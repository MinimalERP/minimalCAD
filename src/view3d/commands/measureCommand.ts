/**
 * MinimalCAD Web
 * view3d/commands/measureCommand.ts
 *
 * Measure (read-only, nothing is added to the model):
 *  - Angle:    two flat faces (or two straight edges) -> their angle; parallel faces also give the gap;
 *  - Distance: two points, snapping to corners / edge middles / circle centres -> distance and dX dY dZ;
 *  - Edge:     an edge -> length, or radius / diameter / arc length;
 *  - Face:     a face -> area (and radius if round).
 * A small panel shows the result; clicking again starts a new measurement.
 */

import type { Body, Edge, Face } from "../../part/kernel/types";
import { edgeAngle, edgeMeasure, faceAngle, faceMeasure, pointDistance } from "../../part/measure";
import { snapPoints3d } from "../../part/line3d";
import type { Vec3 } from "../../part/vec3";
import type { Hit } from "../modelView";
import { edgePolyline } from "../modelView";
import { FeatureDialog } from "../featureDialog";
import type { ChoiceHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

export type MeasureMode = "angle" | "distance" | "edge" | "face";

const NAME = "MEASURE";
const PROMPT: Record<MeasureMode, string> = {
  angle: "Click two flat faces (or two straight edges) to measure the angle between them",
  distance: "Click two points - corners, edge middles and circle centres snap",
  edge: "Click an edge to measure its length (or radius)",
  face: "Click a face to measure its area",
};

const fmt = (v: number): string => `${+v.toFixed(3)}`;

type Picked = { kind: "face"; body: Body; face: Face } | { kind: "edge"; body: Body; edge: Edge };

export class MeasureCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private modeChoice: ChoiceHandle<MeasureMode>;
  private sel: SelectionHandle;
  private results: HTMLDivElement;
  private bodies: readonly Body[];
  /** Edge candidates the view offers (indices of `hit.index`). */
  private edges: { body: Body; edge: Edge; poly: Vec3[] }[] = [];
  private picked: Picked[] = [];
  private points: Vec3[] = [];
  private cursor: { p: Vec3; snapped: boolean } | null = null;

  static start(ctx: ModelContext, mode: MeasureMode): MeasureCommand | null {
    if ((ctx.result()?.bodies.length ?? 0) === 0) {
      showToast("Nothing to measure yet - make a solid first.");
      return null;
    }
    return new MeasureCommand(ctx, mode);
  }

  private constructor(
    private ctx: ModelContext,
    private mode: MeasureMode,
  ) {
    this.bodies = ctx.result()?.bodies ?? [];
    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, "Measure", { onOk: () => this.cancel(), onCancel: () => this.cancel() }));
    this.modeChoice = d.choice<MeasureMode>(
      "Measure",
      [
        { value: "angle", label: "Angle", title: "Angle between two faces or two edges" },
        { value: "distance", label: "Distance", title: "Distance between two points" },
        { value: "edge", label: "Edge", title: "Length, or radius of a round edge" },
        { value: "face", label: "Face", title: "Area of a face" },
      ],
      mode,
      (m) => this.setMode(m),
    );
    this.sel = d.selection("Picked", "");
    this.results = d.custom("measure-results");
    d.hint("Click again to start a new measurement. OK or Esc closes.");
    ctx.view.setOriginPlanesVisible(false);
    ctx.view.onEdgeHover = (hit) => this.onEdgeHover(hit);
    ctx.view.onPoint3dHover = (hit) => this.onPointHover(hit);
    this.setMode(mode);
  }

  setMode(mode: MeasureMode): void {
    this.mode = mode;
    MeasureCommand.lastMode = mode;
    this.modeChoice.set(mode);
    this.reset();
    const view = this.ctx.view;
    if (mode === "distance") view.setPoint3dMode(snapPoints3d(this.bodies));
    else {
      const all = this.bodies.flatMap((body) => body.edges.map((edge) => ({ body, edge })));
      const wanted = mode === "edge" ? all : mode === "angle" ? all.filter((e) => e.edge.geom.kind === "line") : [];
      this.edges = wanted.map((e) => ({ ...e, poly: edgePolyline(e.edge) }));
      view.setEdgePickMode(this.edges.map((e) => e.poly));
    }
    this.ctx.status(NAME, PROMPT[mode]);
    this.show();
  }

  /** The mode the toolbar's Measure button opens next. */
  static lastMode: MeasureMode = "angle";

  private reset(): void {
    this.picked = [];
    this.points = [];
    this.cursor = null;
    this.ctx.view.setPinnedFaces([]);
    this.ctx.view.setChainPreview([], null, null);
    this.ctx.view.setEdgeHighlights([], []);
  }

  onPick(hit: Hit): void {
    if (this.mode === "distance") {
      if (hit.kind !== "point3d") return;
      const p = hit.snap?.p ?? hit.at;
      if (p === null) return;
      if (this.points.length >= 2) this.reset();
      this.points.push(p);
      this.drawPoints();
      this.show();
      return;
    }
    let pick: Picked | null = null;
    if (hit.kind === "edge") {
      const e = this.edges[hit.index];
      if (e !== undefined) pick = { kind: "edge", body: e.body, edge: e.edge };
    } else if (hit.kind === "face") {
      const face = hit.body.faces[hit.faceId];
      if (face !== undefined) pick = { kind: "face", body: hit.body, face };
    }
    if (pick === null) return;
    const need = this.mode === "angle" ? 2 : 1;
    // A new pick after a finished measurement starts over; Angle needs two of the same kind.
    if (this.picked.length >= need || (this.picked.length === 1 && this.picked[0]!.kind !== pick.kind)) this.reset();
    if (this.mode === "edge" && pick.kind !== "edge") return this.note("Click an edge (the lines along the solid), not a face");
    if (this.mode === "face" && pick.kind !== "face") return;
    const same = (q: Picked): boolean =>
      q.body === pick.body && (q.kind === "face" && pick.kind === "face" ? q.face.id === pick.face.id : q.kind === "edge" && pick.kind === "edge" && q.edge === pick.edge);
    if (this.picked.some(same)) return this.note(`That ${pick.kind} is already picked - click a different one`);
    this.picked.push(pick);
    this.drawPicked();
    this.show();
  }

  private note(text: string): void {
    this.dialog.setError(text);
  }

  private onEdgeHover(hit: Hit | null): void {
    const e = hit?.kind === "edge" ? this.edges[hit.index] : undefined;
    this.drawPicked(e === undefined ? [] : [e.poly]);
  }

  private onPointHover(hit: Extract<Hit, { kind: "point3d" }> | null): void {
    const p = hit === null ? null : (hit.snap?.p ?? hit.at);
    this.cursor = p === null ? null : { p, snapped: hit?.snap != null };
    this.drawPoints();
  }

  private drawPicked(hover: Vec3[][] = []): void {
    const faces = this.picked.flatMap((p) => (p.kind === "face" ? [{ body: p.body, faceId: p.face.id }] : []));
    const edges = this.picked.flatMap((p) => (p.kind === "edge" ? [edgePolyline(p.edge)] : []));
    this.ctx.view.setPinnedFaces(faces);
    this.ctx.view.setEdgeHighlights(edges, hover);
  }

  private drawPoints(): void {
    const [a, b] = this.points;
    if (a !== undefined && b !== undefined) this.ctx.view.setChainPreview([a, b], null, this.cursor);
    else this.ctx.view.setChainPreview(this.points, a !== undefined && this.cursor !== null ? [a, this.cursor.p] : null, this.cursor);
  }

  /** Result lines for the panel, or what to pick next. */
  private lines(): { label: string; value: string }[] | string {
    if (this.mode === "distance") {
      if (this.points.length < 2) return this.points.length === 0 ? "Click the first point" : "Click the second point";
      const d = pointDistance(this.points[0]!, this.points[1]!);
      return [
        { label: "Distance", value: `${fmt(d.distance)} mm` },
        { label: "ΔX", value: fmt(d.dx) },
        { label: "ΔY", value: fmt(d.dy) },
        { label: "ΔZ", value: fmt(d.dz) },
      ];
    }
    if (this.mode === "angle") {
      if (this.picked.length < 2) return this.picked.length === 0 ? "Click the first face (or edge)" : `Click the second ${this.picked[0]!.kind}`;
      const [a, b] = this.picked as [Picked, Picked];
      if (a.kind === "edge" && b.kind === "edge") {
        const ang = edgeAngle(a.edge, b.edge);
        return typeof ang === "string" ? ang : [{ label: "Angle", value: `${fmt(ang)}°` }];
      }
      if (a.kind !== "face" || b.kind !== "face") return "Pick two faces, or two edges";
      const r = faceAngle(a.face, b.face);
      if (typeof r === "string") return r;
      const out = [
        { label: "Angle", value: `${fmt(r.planes)}°` },
        { label: "Faces meet at", value: `${fmt(r.between)}°` },
      ];
      if (r.gap !== undefined) out.push({ label: "Parallel, gap", value: `${fmt(r.gap)} mm` });
      return out;
    }
    if (this.mode === "edge") {
      const p = this.picked[0];
      if (p?.kind !== "edge") return "Click an edge";
      const m = edgeMeasure(p.edge);
      if (m.kind === "arc") {
        return [
          { label: "Radius", value: `${fmt(m.radius)} mm` },
          { label: "Diameter", value: `${fmt(m.diameter)} mm` },
          { label: m.full ? "Circumference" : "Arc length", value: `${fmt(m.length)} mm` },
        ];
      }
      return [{ label: "Length", value: `${fmt(m.length)} mm` }];
    }
    const p = this.picked[0];
    if (p?.kind !== "face") return "Click a face";
    const m = faceMeasure(p.body, p.face);
    const out = [{ label: "Area", value: `${fmt(m.area)} mm²` }];
    if (m.radius !== undefined) out.push({ label: "Radius", value: `${fmt(m.radius)} mm` }, { label: "Diameter", value: `${fmt(2 * m.radius)} mm` });
    return out;
  }

  private show(): void {
    this.dialog.setError(null);
    const n = this.mode === "distance" ? this.points.length : this.picked.length;
    this.sel.set(n === 0 ? "Nothing yet" : `${n} picked`, n > 0);
    const r = this.lines();
    this.results.replaceChildren();
    if (typeof r === "string") {
      const hint = document.createElement("div");
      hint.className = "measure-hint";
      hint.textContent = r;
      this.results.appendChild(hint);
      return;
    }
    for (const line of r) {
      const row = document.createElement("div");
      row.className = "measure-row";
      const l = document.createElement("span");
      l.className = "measure-label";
      l.textContent = line.label;
      const v = document.createElement("span");
      v.className = "measure-value";
      v.textContent = line.value;
      const copy = document.createElement("button");
      copy.className = "fd-small-btn";
      copy.textContent = "Copy";
      copy.title = "Copy the value";
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(line.value.replace(/\s*(mm²|mm|°)$/, "")).then(
          () => showToast(`Copied ${line.value}`),
          () => showToast("Couldn't copy - select the value instead"),
        );
      });
      row.append(l, v, copy);
      this.results.appendChild(row);
    }
  }

  ok(): void {
    this.cancel();
  }

  cancel(): void {
    this.dialog.close();
    this.reset();
    this.ctx.view.onEdgeHover = null;
    this.ctx.view.onPoint3dHover = null;
    this.ctx.view.setPickMode("none");
    this.ctx.done();
  }
}
