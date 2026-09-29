/**
 * MinimalCAD Web
 * view3d/commands/edgeBlendCommand.ts
 *
 * Fillet / Chamfer: an Inventor-style dialog plus edge picking on the
 * model. Click an edge to add it (again to remove it); click a face to add
 * all its edges at once (again to remove them). Straight edges between two
 * flat faces and circle rims where a round face meets a flat one can be
 * picked -- others aren't offered. Live preview: the picked edges in blue,
 * the material to be cut (red) or added (blue).
 */

import type { Body } from "../../part/kernel/types";
import { faceHasRef } from "../../part/kernel/types";
import type { ChamferMode, EdgeFeature, EdgeRef } from "../../part/types";
import { nextId } from "../../part/types";
import { rebuild } from "../../part/rebuild";
import type { BlendEdge } from "../../part/edgeBlend";
import { blendEdges, edgeRefOf, edgeTools, resolveEdgeRef } from "../../part/edgeBlend";
import type { Hit } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

type Kind = "fillet" | "chamfer";

export class EdgeBlendCommand implements ModelCommand {
  private dialog: FeatureDialog;
  /** Pickable edges of the model as it is before this feature. */
  private candidates: BlendEdge[] = [];
  /** Picked edges (indices into candidates). */
  private picked: number[] = [];
  /** Chamfer: first distance / angle on the edge's OTHER face. */
  private flipped = false;
  private hover: number | null = null;
  private mode: ChamferMode = "equal";
  private v = { size: "2", size2: "3", angle: "45" };

  private edgesSel: SelectionHandle;
  private size2Field: FieldHandle | null = null;
  private angleField: FieldHandle | null = null;
  private flipRow: { setVisible(v: boolean): void } | null = null;

  static start(ctx: ModelContext, kind: Kind, editing: EdgeFeature | null): EdgeBlendCommand | null {
    if (editing === null && (ctx.result()?.bodies.length ?? 0) === 0) {
      showToast(`Make a solid first - a ${kind} goes on its edges.`);
      return null;
    }
    return new EdgeBlendCommand(ctx, editing?.type ?? kind, editing);
  }

  private constructor(
    private ctx: ModelContext,
    private kind: Kind,
    private editing: EdgeFeature | null,
  ) {
    // Edges as the model is BEFORE this feature (its own change doesn't count).
    let bodies: readonly Body[] = ctx.result()?.bodies ?? [];
    if (editing !== null) {
      const part = ctx.part();
      const upTo = { ...part, features: part.features.slice(0, part.features.findIndex((x) => x.id === editing.id)) };
      bodies = rebuild(upTo, ctx.drawingEntities()).bodies;
    }
    this.candidates = bodies.flatMap((b) => blendEdges(b));
    if (editing !== null) {
      this.v.size = editing.size;
      this.v.size2 = editing.size2 ?? this.v.size2;
      this.v.angle = editing.angle ?? this.v.angle;
      this.mode = editing.mode ?? "equal";
      for (const ref of editing.edges) {
        const e = resolveEdgeRef(this.candidates, ref);
        const i = e === null ? -1 : this.candidates.indexOf(e);
        if (i >= 0 && !this.picked.includes(i)) this.picked.push(i);
        // Chamfer sides are stored per edge; the dialog flips them all at once.
        if (e !== null && !faceHasRef(e.faceA, ref.faces[0])) this.flipped = true;
      }
    }

    const title = kind === "fillet" ? "Fillet" : "Chamfer";
    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? title : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
    this.edgesSel = d.selection("Edges", "");
    if (kind === "fillet") {
      d.number("Radius", "mm", this.v.size, (t) => this.set("size", t));
    } else {
      d.choice<ChamferMode>(
        "Type",
        [
          { value: "equal", label: "Equal", icon: ICONS.chamferEqual, title: "Same distance on both faces" },
          { value: "two", label: "2 dist.", icon: ICONS.chamferTwo, title: "A distance on each face" },
          { value: "angle", label: "Angle", icon: ICONS.chamferAngle, title: "A distance and an angle" },
        ],
        this.mode,
        (m) => {
          this.mode = m;
          this.update();
        },
      );
      d.number("Distance", "mm", this.v.size, (t) => this.set("size", t));
      this.size2Field = d.number("Distance 2", "mm", this.v.size2, (t) => this.set("size2", t));
      this.angleField = d.number("Angle", "°", this.v.angle, (t) => this.set("angle", t));
      this.flipRow = d.rowGroup(() =>
        d.buttons("Sides", [
          {
            label: "Flip",
            onClick: () => {
              this.flipped = !this.flipped;
              this.update();
            },
          },
        ]),
      );
    }
    d.hint("Click edges on the model (again to remove). Click a face to add all its edges.");

    ctx.view.setEdgePickMode(this.candidates.map((e) => e.polyline));
    ctx.view.onEdgeHover = (hit) => this.onHover(hit);
    ctx.view.setOriginPlanesVisible(false);
    this.update();
    this.ctx.status(title.toUpperCase(), `Click the edges to ${kind === "fillet" ? "round off" : "bevel"} - or a face for all its edges - then OK`);
  }

  private set(key: keyof EdgeBlendCommand["v"], text: string): void {
    this.v[key] = text;
    this.update();
  }

  /** Candidate edges bounding the face `hit` is on. */
  private edgesOfFace(hit: Extract<Hit, { kind: "face" }>): number[] {
    const out: number[] = [];
    this.candidates.forEach((e, i) => {
      if (e.body === hit.body && (e.faceA.id === hit.faceId || e.faceB.id === hit.faceId)) out.push(i);
    });
    return out;
  }

  onPick(hit: Hit): void {
    if (hit.kind === "edge") {
      const at = this.picked.indexOf(hit.index);
      if (at >= 0) this.picked.splice(at, 1);
      else this.picked.push(hit.index);
    } else if (hit.kind === "face") {
      const list = this.edgesOfFace(hit);
      if (list.length === 0) {
        this.dialog.setError("That face has no edges that can be rounded here (only straight edges and circle rims)");
        return;
      }
      if (list.every((i) => this.picked.includes(i))) this.picked = this.picked.filter((i) => !list.includes(i));
      else for (const i of list) if (!this.picked.includes(i)) this.picked.push(i);
    } else return;
    this.update();
    this.onHover(hit); // the hint now says "remove" for what was just added
  }

  private onHover(hit: Hit | null): void {
    this.hover = hit?.kind === "edge" ? hit.index : null;
    this.drawEdges(hit?.kind === "face" ? this.edgesOfFace(hit) : []);
    const n = hit?.kind === "face" ? this.edgesOfFace(hit).length : 0;
    this.ctx.status(
      this.kind.toUpperCase(),
      hit?.kind === "edge"
        ? this.picked.includes(hit.index)
          ? "Click to remove this edge"
          : "Click to add this edge"
        : n > 0
          ? `Click to ${this.edgesOfFace(hit as Extract<Hit, { kind: "face" }>).every((i) => this.picked.includes(i)) ? "remove" : "add"} this face's ${n} edge${n === 1 ? "" : "s"}`
          : `Click the edges to ${this.kind === "fillet" ? "round off" : "bevel"} - or a face for all its edges - then OK`,
    );
  }

  /** Picked edges blue; the hovered edge (or a hovered face's edges) yellow. */
  private drawEdges(faceHover: number[] = []): void {
    const hover = this.hover !== null ? [this.hover] : faceHover;
    this.ctx.view.setEdgeHighlights(
      this.picked.map((i) => this.candidates[i]!.polyline),
      hover.map((i) => this.candidates[i]!.polyline),
    );
  }

  private refs(): EdgeRef[] {
    return this.picked.map((i) => {
      const r = edgeRefOf(this.candidates[i]!);
      return this.flipped ? { ...r, faces: [r.faces[1], r.faces[0]] } : r;
    });
  }

  private feature(): EdgeFeature {
    const f: EdgeFeature = { id: this.editing?.id ?? "BlendPreview", type: this.kind, edges: this.refs(), size: this.v.size };
    if (this.kind === "chamfer") {
      f.mode = this.mode;
      if (this.mode === "two") f.size2 = this.v.size2;
      if (this.mode === "angle") f.angle = this.v.angle;
    }
    return f;
  }

  private update(): void {
    this.size2Field?.setVisible(this.mode === "two");
    this.angleField?.setVisible(this.mode === "angle");
    this.flipRow?.setVisible(this.kind === "chamfer" && this.mode !== "equal");
    const n = this.picked.length;
    this.edgesSel.set(n === 0 ? "Click edges" : `${n} edge${n === 1 ? "" : "s"}`, n > 0);
    this.drawEdges();

    let error: string | null = null;
    const f = this.feature();
    const tools = n === 0 ? `Click the edges to ${this.kind === "fillet" ? "round off" : "bevel"}` : edgeTools(f, [...new Set(this.candidates.map((c) => c.body))], this.ctx.params());
    if (typeof tools === "string") error = tools;
    this.dialog.setError(error);
    this.ctx.view.setPreview(typeof tools === "string" ? null : tools.map((t) => t.body), typeof tools !== "string" && tools.some((t) => t.cut));
  }

  ok(): void {
    this.update();
    if (this.picked.length === 0) return;
    const f = this.feature();
    if (typeof edgeTools(f, [...new Set(this.candidates.map((c) => c.body))], this.ctx.params()) === "string") return;
    this.close();
    this.ctx.commit((part) => {
      if (this.editing !== null) {
        const i = part.features.findIndex((x) => x.id === this.editing!.id);
        if (i >= 0) part.features[i] = { ...f, id: this.editing.id };
        return;
      }
      part.features.push({ ...f, id: nextId(part, this.kind === "fillet" ? "Fillet" : "Chamfer") });
    });
    this.ctx.done();
  }

  cancel(): void {
    this.close();
    this.ctx.done();
  }

  private close(): void {
    this.dialog.close();
    this.ctx.view.onEdgeHover = null;
    this.ctx.view.setEdgeHighlights([], []);
    this.ctx.view.setPickMode("none");
    this.ctx.view.setPreview(null);
  }
}
