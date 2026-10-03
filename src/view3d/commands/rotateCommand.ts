/**
 * MinimalCAD Web
 * view3d/commands/rotateCommand.ts
 *
 * Rotate Body: an Inventor-style dialog. Bodies (all of them, or click a
 * face of each solid to turn -- again to drop it), the axis (X / Y / Z
 * through the origin, or "Edge / face": click a straight edge of the model
 * or a round face, whose own axis is used), and the angle. Live preview of
 * the turned solids.
 */

import type { Body, TopoRef } from "../../part/kernel/types";
import type { PatternAxis, RotateFeature, XYZ, EdgeRef } from "../../part/types";
import { nextId } from "../../part/types";
import { rebuild } from "../../part/rebuild";
import type { AxisEdge } from "../../part/rotateBody";
import { axisEdgeRef, axisEdges, moveBody, rotateSelection, rotateTransform, samePiece } from "../../part/rotateBody";
import type { Hit } from "../modelView";
import { FeatureDialog } from "../featureDialog";
import type { ChoiceHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

type AxisChoice = PatternAxis | "model";

export class RotateCommand implements ModelCommand {
  private dialog: FeatureDialog;
  /** The model as it is before this feature. */
  private bodies: readonly Body[];
  private candidates: AxisEdge[] = [];
  /** The picked solids (feature + a point on it); null = all bodies. */
  private picked: { feature: string; at: XYZ }[] | null = null;
  /** Older files: whole features' bodies. */
  private legacyBodies: string[] | undefined;
  private axis: AxisChoice = "Z";
  private axisEdge: (EdgeRef & { a: XYZ; b: XYZ }) | null = null;
  private axisFace: TopoRef | null = null;
  private angle = "90";
  private stage: "bodies" | "axis" = "bodies";
  private bodiesSel: SelectionHandle;
  private axisSel: SelectionHandle | null = null;
  private axisRows: { setVisible(v: boolean): void };
  private axisChoice: ChoiceHandle<AxisChoice>;

  static start(ctx: ModelContext, editing: RotateFeature | null): RotateCommand | null {
    if (editing === null && (ctx.result()?.bodies.length ?? 0) === 0) {
      showToast("Make a solid first - Rotate turns solids.");
      return null;
    }
    return new RotateCommand(ctx, editing);
  }

  private constructor(
    private ctx: ModelContext,
    private editing: RotateFeature | null,
  ) {
    let bodies: readonly Body[] = ctx.result()?.bodies ?? [];
    if (editing !== null) {
      const part = ctx.part();
      const upTo = { ...part, features: part.features.slice(0, part.features.findIndex((x) => x.id === editing.id)) };
      bodies = rebuild(upTo, ctx.drawingEntities()).bodies;
      this.picked = editing.pieces?.map((x) => ({ ...x })) ?? null;
      this.legacyBodies = editing.bodies?.slice();
      this.angle = editing.angle;
      this.axisEdge = editing.axisEdge ?? null;
      this.axisFace = editing.axisFace ?? null;
      this.axis = this.axisEdge !== null || this.axisFace !== null ? "model" : (editing.axis ?? "Z");
    }
    this.bodies = bodies;
    this.candidates = bodies.flatMap((b) => axisEdges(b));

    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Rotate Body" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
    this.bodiesSel = d.selection("Bodies", "", true, () => this.setStage("bodies"));
    d.buttons("", [
      {
        label: "All bodies",
        onClick: () => {
          this.picked = null;
          this.legacyBodies = undefined;
          this.update();
        },
      },
    ]);
    const axes = (["X", "Y", "Z"] as const).map((a) => ({ value: a as AxisChoice, label: a, title: `About the ${a} axis through the origin` }));
    this.axisChoice = d.choice<AxisChoice>(
      "Axis",
      [...axes, { value: "model", label: "Edge / face", title: "About a straight edge of the model, or a round face's axis, that you click" }],
      this.axis,
      (a) => {
        this.axis = a;
        this.setStage(a === "model" ? "axis" : "bodies");
        this.update();
      },
    );
    this.axisRows = d.rowGroup(() => (this.axisSel = d.selection("Edge / face", "", false, () => this.setStage("axis"))));
    d.number("Angle", "°", this.angle, (t) => {
      this.angle = t;
      this.update();
    });
    d.hint("Positive turns anticlockwise looking down the axis. Edge: from its first end to its second.");

    ctx.view.setOriginPlanesVisible(false);
    ctx.view.onEdgeHover = (hit) => this.onHover(hit);
    this.setStage(this.axis === "model" && this.axisEdge === null && this.axisFace === null ? "axis" : "bodies");
    this.update();
    d.focusFirst();
  }

  private setStage(stage: "bodies" | "axis"): void {
    this.stage = stage;
    if (stage === "bodies") {
      this.ctx.view.setEdgePickMode([]); // faces of any kind
      this.ctx.status("ROTATE BODY", "Click a face of each solid to turn (again to drop it) - or keep All bodies");
    } else {
      this.ctx.view.setEdgePickMode(this.candidates.map((e) => [e.a, e.b]));
      this.ctx.status("ROTATE BODY", "Click a straight edge to turn about - or a round face (its axis)");
    }
    this.bodiesSel.setActive(stage === "bodies");
    this.axisSel?.setActive(stage === "axis");
  }

  onPick(hit: Hit): void {
    if (this.stage === "bodies") {
      if (hit.kind !== "face") return;
      if (hit.at === undefined) return;
      const at = hit.at;
      const body = hit.body;
      const list = this.picked ?? [];
      // Again on a picked solid drops it.
      const same = (x: { feature: string; at: XYZ }): boolean => x.feature === body.feature && samePiece(body, x.at, at);
      this.picked = list.some(same) ? list.filter((x) => !same(x)) : [...list, { feature: body.feature, at }];
      this.legacyBodies = undefined;
      if (this.picked.length === 0) this.picked = null;
    } else if (hit.kind === "edge") {
      const e = this.candidates[hit.index];
      if (e === undefined) return;
      this.axisEdge = axisEdgeRef(e);
      this.axisFace = null;
      this.setStage("bodies");
    } else if (hit.kind === "face") {
      const kind = hit.body.faces[hit.faceId]?.geom.kind;
      if (kind !== "cylinder" && kind !== "cone") {
        this.dialog.setError("That face is not round - click a straight edge, or a round face (its axis is used)");
        return;
      }
      this.axisFace = hit.ref;
      this.axisEdge = null;
      this.setStage("bodies");
    } else return;
    this.update();
  }

  private onHover(hit: Hit | null): void {
    const e = hit?.kind === "edge" ? this.candidates[hit.index] : undefined;
    this.drawEdges(e === undefined ? [] : [[e.a, e.b]]);
  }

  private drawEdges(hover: XYZ[][] = []): void {
    const sel = this.axis === "model" && this.axisEdge !== null ? [[this.axisEdge.a, this.axisEdge.b]] : [];
    this.ctx.view.setEdgeHighlights(sel, hover);
  }

  private feature(): RotateFeature {
    const f: RotateFeature = { id: this.editing?.id ?? "RotatePreview", type: "rotate", angle: this.angle };
    if (this.picked !== null) f.pieces = this.picked.map((x) => ({ ...x }));
    else if (this.legacyBodies !== undefined) f.bodies = this.legacyBodies.slice();
    if (this.axis !== "model") f.axis = this.axis;
    else if (this.axisEdge !== null) f.axisEdge = this.axisEdge;
    else if (this.axisFace !== null) f.axisFace = this.axisFace;
    return f;
  }

  /** The turned bodies, or why there are none. */
  private preview(): Body[] | string {
    if (this.axis === "model" && this.axisEdge === null && this.axisFace === null) return "Click a straight edge or a round face to turn about";
    const f = this.feature();
    const t = rotateTransform(f, this.bodies, this.ctx.params());
    if (typeof t === "string") return t;
    const sel = rotateSelection(f, this.bodies);
    if (sel.targets.size === 0) return "Click a face of each solid to turn";
    return [...sel.targets].map((b) => moveBody(b, t));
  }

  private update(): void {
    this.axisChoice.set(this.axis);
    this.axisRows.setVisible(this.axis === "model");
    const n = this.picked?.length ?? 0;
    this.bodiesSel.set(
      this.picked !== null ? `${n} solid${n === 1 ? "" : "s"} picked` : this.legacyBodies !== undefined ? `Solids of ${this.legacyBodies.join(", ")}` : "All bodies",
      true,
    );
    this.axisSel?.set(
      this.axisEdge !== null ? "Edge" : this.axisFace !== null ? `Round face of ${this.axisFace.feature}` : "Click an edge or a round face",
      this.axisEdge !== null || this.axisFace !== null,
    );
    this.drawEdges();
    const p = this.preview();
    this.dialog.setError(typeof p === "string" ? p : null);
    this.ctx.view.setPreview(typeof p === "string" ? null : p, false);
  }

  ok(): void {
    this.update();
    if (typeof this.preview() === "string") return;
    const f = this.feature();
    this.close();
    this.ctx.commit((part) => {
      if (this.editing !== null) {
        const i = part.features.findIndex((x) => x.id === this.editing!.id);
        if (i >= 0) part.features[i] = { ...f, id: this.editing.id };
        return;
      }
      part.features.push({ ...f, id: nextId(part, "Rotate") });
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
