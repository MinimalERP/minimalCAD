/**
 * MinimalCAD Web
 * view3d/commands/holeCommand.ts
 *
 * Hole: a small Inventor-style dialog for the hole itself (Type, Ø,
 * Termination) plus ONE placement button, "Add constraint". Everything
 * about positions happens on the model:
 *
 *   - click on a flat face: drops a hole (snaps to the face's own edge ends,
 *     midpoints and circle centres);
 *   - "Add constraint" on: STEP 1 click the hole to constrain; STEP 2 click
 *     an edge / a locked hole's centre / a circle centre on the face -> a
 *     real dimension (extension line, arrows, value) appears on the face
 *     with its value box open -- type the distance, Enter. After two the
 *     hole is LOCKED (green) and others can be constrained from it;
 *   - click a dimension's value to change it; Delete removes the selected
 *     dimension or hole. Holes dimensioned from earlier holes follow them.
 *
 * The dimensions are only shown while the Hole feature is open.
 */

import type { HoleCenter, HoleDim, HoleFeature, HoleRef, HoleStyle } from "../../part/types";
import { nextId } from "../../part/types";
import type { TopoRef } from "../../part/kernel/types";
import { faceFrameOf, rebuild, throughLength } from "../../part/rebuild";
import { dependsOn, holeTools, refLine, resolveCenters, signedDistance } from "../../part/hole";
import { edgesOnFace } from "../../part/faceTopology";
import type { Frame } from "../../part/plane";
import { evalExpression } from "../../part/params";
import type { Point } from "../../core/types";
import type { Hit } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

const PICK_PX = 12;
const OTHER_FACE = "Holes in one Hole feature go on one face - OK this one, then start another Hole";

type Selection = { kind: "hole"; i: number } | { kind: "dim"; i: number; k: number } | null;

export class HoleCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private face: TopoRef | null = null;
  private frame: Frame | null = null;
  private centers: HoleCenter[] = [];
  private constrain = false;
  private selection: Selection = null;
  private style: HoleStyle = "plain";
  private through = true;
  private v = { diameter: "10", depth: "20", cbDiameter: "18", cbDepth: "6", csDiameter: "20", csAngle: "90" };

  /** The picked face's own straight edges and circle centres (face coords). */
  private faceLines: [Point, Point][] = [];
  private faceCircles: Point[] = [];

  private faceSel: SelectionHandle;
  private holesSel: SelectionHandle;
  private constrainToggle: { set(on: boolean): void };
  private depthField: FieldHandle;
  private cbFields: FieldHandle[];
  private csFields: FieldHandle[];

  static start(ctx: ModelContext, editing: HoleFeature | null): HoleCommand | null {
    if (editing === null && (ctx.result()?.bodies.length ?? 0) === 0) {
      showToast("Make a solid first - holes are drilled into a face of it.");
      return null;
    }
    return new HoleCommand(ctx, editing);
  }

  private constructor(
    private ctx: ModelContext,
    private editing: HoleFeature | null,
  ) {
    if (editing !== null) {
      this.style = editing.style;
      this.through = editing.extent === "through";
      this.centers = editing.centers.map((c) => structuredClone(c));
      this.v = {
        diameter: editing.diameter,
        depth: editing.depth,
        cbDiameter: editing.cbDiameter ?? "18",
        cbDepth: editing.cbDepth ?? "6",
        csDiameter: editing.csDiameter ?? "20",
        csAngle: editing.csAngle ?? "90",
      };
    }

    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Hole" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
    this.faceSel = d.selection("Face", "Click on a flat face");
    this.holesSel = d.selection("Holes", "");
    this.constrainToggle = d.toggle(
      "Add constraint",
      "Dimension holes on the model: click a hole, then an edge or another hole's centre, then type the distance",
      (on) => this.setConstrain(on),
    );
    d.choice<HoleStyle>(
      "Type",
      [
        { value: "plain", label: "Simple", icon: ICONS.holeSimple },
        { value: "counterbore", label: "C'bore", icon: ICONS.holeCbore, title: "Counterbore" },
        { value: "countersink", label: "C'sink", icon: ICONS.holeCsink, title: "Countersink" },
      ],
      this.style,
      (s) => {
        this.style = s;
        this.update();
      },
    );
    d.number("Diameter", "mm", this.v.diameter, (t) => this.set("diameter", t));
    d.choice<"distance" | "through">(
      "Termination",
      [
        { value: "through", label: "Through all", icon: ICONS.through },
        { value: "distance", label: "Distance", icon: ICONS.distance, title: "Blind hole, with a 118° drill point" },
      ],
      this.through ? "through" : "distance",
      (v) => {
        this.through = v === "through";
        this.update();
      },
    );
    this.depthField = d.number("Depth", "mm", this.v.depth, (t) => this.set("depth", t));
    this.cbFields = [
      d.number("C'bore Ø", "mm", this.v.cbDiameter, (t) => this.set("cbDiameter", t)),
      d.number("C'bore depth", "mm", this.v.cbDepth, (t) => this.set("cbDepth", t)),
    ];
    this.csFields = [
      d.number("C'sink Ø", "mm", this.v.csDiameter, (t) => this.set("csDiameter", t)),
      d.number("C'sink angle", "°", this.v.csAngle, (t) => this.set("csAngle", t)),
    ];

    if (editing !== null) {
      // Face frame as built *before* this hole (its own cut doesn't move it).
      const part = ctx.part();
      const upTo = { ...part, features: part.features.slice(0, part.features.findIndex((x) => x.id === editing.id)) };
      const before = rebuild(upTo, ctx.drawingEntities()).bodies;
      this.useFace(editing.face, faceFrameOf(before, editing.face), before);
    }
    ctx.view.onDimClick = (id) => this.onDimClick(id);
    ctx.view.setSurfacePointMode();
    ctx.view.setOriginPlanesVisible(false);
    this.update();
    this.ctx.status("HOLE", this.hint());
  }

  private set(key: keyof HoleCommand["v"], text: string): void {
    this.v[key] = text;
    this.update();
  }

  private setConstrain(on: boolean): void {
    this.constrain = on;
    this.constrainToggle.set(on);
    this.selection = null; // step 1 is always: pick the hole
    this.update();
    this.ctx.status("HOLE", this.hint());
  }

  private hint(): string {
    if (this.face === null) return "Click on a flat face where the hole goes (snaps to its edges and circle centres)";
    if (!this.constrain) return "Click on the face for more holes - press Add constraint to dimension them - OK when done";
    const sel = this.selection;
    if (sel?.kind === "hole") {
      const n = this.centers[sel.i]?.dims?.length ?? 0;
      if (n < 2) return `Step 2 - Hole ${sel.i + 1}: click an edge or a locked (green) hole's centre - ${2 - n} more to lock it`;
      return `Hole ${sel.i + 1} is locked - Step 1: click the next hole to constrain (or click a value to change it)`;
    }
    const free = this.centers.filter((c) => (c.dims?.length ?? 0) < 2).length;
    return free === 0
      ? "All holes locked - click a value to change it, or OK"
      : "Step 1: click the hole to constrain (click a value to change it, Delete removes)";
  }

  // --- face ---

  private useFace(face: TopoRef, frame: Frame | null, bodies = this.ctx.result()?.bodies ?? []): void {
    if (frame === null) {
      showToast("That face can't be used for a hole.");
      return;
    }
    this.face = face;
    this.frame = frame;
    const body = bodies.find((b) => b.faces.some((f) => sameRef(f.ref, face)));
    const topo = body === undefined ? null : edgesOnFace(body, frame);
    this.faceLines = topo?.lines ?? [];
    this.faceCircles = topo?.circles.map((c) => c.center) ?? [];
  }

  // --- picking helpers ---

  private tol(): number {
    return this.ctx.view.pixelSize() * PICK_PX;
  }

  private holeNear(p: Point): number | null {
    const solved = this.resolved();
    let best: number | null = null;
    let bestD = this.tol();
    solved.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** A reference near `p` for dimensioning hole `hole`: an earlier hole's
   *  centre, a circle centre on the face, or an edge -- in that priority. */
  private refNear(p: Point, hole: number): HoleRef | null {
    const tol = this.tol();
    const solved = this.resolved();
    const me = solved[hole] ?? p;
    const axisFor = (c: Point): "u" | "v" => (Math.abs(me.x - c.x) >= Math.abs(me.y - c.y) ? "u" : "v");
    for (let i = 0; i < solved.length; i++) {
      // Only LOCKED holes (2 constraints) can be referenced, and never one
      // that already depends on this hole (that would be a loop).
      if (i === hole || !this.locked(i) || dependsOn({ centers: this.centers }, i, hole)) continue;
      const c = solved[i]!;
      if (Math.hypot(c.x - p.x, c.y - p.y) <= tol) return { kind: "hole", index: i, axis: axisFor(c) };
    }
    for (const c of this.faceCircles) {
      if (Math.hypot(c.x - p.x, c.y - p.y) <= tol) return { kind: "point", p: c, axis: axisFor(c) };
    }
    let best: [Point, Point] | null = null;
    let bestD = tol;
    for (const seg of this.faceLines) {
      const [a, b] = seg;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const dist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (dist < bestD) {
        bestD = dist;
        best = seg;
      }
    }
    return best === null ? null : { kind: "edge", seg: best };
  }

  private locked(i: number): boolean {
    return (this.centers[i]?.dims?.length ?? 0) >= 2;
  }

  private refSegments(ref: HoleRef): [Point, Point][] {
    if (ref.kind === "edge") return [ref.seg];
    const c = ref.kind === "point" ? ref.p : this.resolved()[ref.index];
    if (c === undefined) return [];
    const s = this.ctx.view.pixelSize() * 9;
    return [
      [{ x: c.x - s, y: c.y }, { x: c.x + s, y: c.y }],
      [{ x: c.x, y: c.y - s }, { x: c.x, y: c.y + s }],
    ];
  }

  // --- view events ---

  onPick(hit: Hit): void {
    if (hit.kind !== "surfacePoint") return;
    if (this.face === null) {
      this.useFace(hit.ref, faceFrameOf(this.ctx.result()?.bodies ?? [], hit.ref));
      if (this.face === null) return;
      this.addCenter(hit.point);
      return;
    }
    if (!sameRef(hit.ref, this.face)) {
      this.dialog.setError(OTHER_FACE);
      return;
    }
    if (!this.constrain) {
      this.addCenter(hit.point);
      return;
    }
    // Constraint mode: a reference for the selected hole, else select a hole.
    const sel = this.selection;
    if (sel?.kind === "hole" && (this.centers[sel.i]?.dims?.length ?? 0) < 2) {
      const ref = this.refNear(hit.raw, sel.i);
      if (ref !== null) {
        this.addDim(sel.i, ref);
        return;
      }
    }
    const h = this.holeNear(hit.raw);
    this.selection = h === null ? null : { kind: "hole", i: h };
    this.update();
    this.ctx.status("HOLE", this.hint());
  }

  onSurfaceHover(hit: Extract<Hit, { kind: "surfacePoint" }> | null): void {
    const onOurFace = hit !== null && (this.face === null || sameRef(hit.ref, this.face));
    let ref: HoleRef | null = null;
    const sel = this.selection;
    if (onOurFace && this.constrain && sel?.kind === "hole" && (this.centers[sel.i]?.dims?.length ?? 0) < 2) {
      ref = this.refNear(hit.raw, sel.i);
    }
    this.ctx.view.setHighlightLines(this.frame, ref === null ? [] : this.refSegments(ref));
    const frame = this.frame ?? hit?.frame ?? null;
    const preview = onOurFace && !this.constrain ? { point: hit.point, snap: hit.snap } : null;
    this.ctx.view.setMarkers(frame, this.frame === null ? [] : this.resolved(), preview ?? this.selectedMarker(), this.markerColors());
    this.ctx.status(
      "HOLE",
      hit !== null && !onOurFace ? OTHER_FACE : ref !== null ? `Dimension from this ${ref.kind === "edge" ? "edge" : "centre"}` : this.hint(),
    );
  }

  private onDimClick(id: string): void {
    const [i, k] = id.split(".").map(Number) as [number, number];
    const dim = this.centers[i]?.dims?.[k];
    if (dim === undefined) return;
    this.selection = { kind: "dim", i, k };
    this.update();
    this.ctx.view.editDimLabel(id, dim.d, (text) => {
      if (text !== "" && evalExpression(text, this.ctx.params()) !== null) dim.d = text;
      this.update();
    });
  }

  onKey(e: KeyboardEvent): boolean {
    // A dimension value box is open but focus is on the view: Enter confirms
    // the value (never OK on the whole hole), other keys are typed into it.
    if (this.ctx.view.hasDimEdit()) {
      if (e.key === "Enter") {
        this.ctx.view.commitDimEdit();
        return true;
      }
      if (e.key !== "Escape") {
        this.ctx.view.focusDimEdit(); // the character lands in the box
        return false;
      }
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      const sel = this.selection;
      if (sel?.kind === "dim") {
        const c = this.centers[sel.i]!;
        c.dims = (c.dims ?? []).filter((_, k) => k !== sel.k);
        if (c.dims.length === 0) delete c.dims;
        this.selection = { kind: "hole", i: sel.i };
      } else if (sel?.kind === "hole") {
        this.removeHole(sel.i);
      } else return false;
      this.update();
      this.ctx.status("HOLE", this.hint());
      return true;
    }
    if (e.key === "Escape" && this.selection !== null) {
      this.selection = null;
      this.update();
      this.ctx.status("HOLE", this.hint());
      return true;
    }
    return false;
  }

  // --- holes & dimensions ---

  private addCenter(p: Point): void {
    this.centers.push({ x: +p.x.toFixed(6), y: +p.y.toFixed(6) });
    this.selection = { kind: "hole", i: this.centers.length - 1 };
    this.update();
    this.ctx.status("HOLE", this.hint());
  }

  /** Removes hole `i`; dimensions from it go too, later references shift down. */
  private removeHole(i: number): void {
    this.centers.splice(i, 1);
    for (const c of this.centers) {
      if (c.dims === undefined) continue;
      c.dims = c.dims
        .filter((d) => !(d.ref.kind === "hole" && d.ref.index === i))
        .map((d) => (d.ref.kind === "hole" && d.ref.index > i ? { ...d, ref: { ...d.ref, index: d.ref.index - 1 } } : d));
      if (c.dims.length === 0) delete c.dims;
    }
    this.selection = null;
  }

  /** Adds a dimension to hole `i` from `ref`, pre-filled with the measured
   *  distance, and opens its value box on the model. */
  private addDim(i: number, ref: HoleRef): void {
    const c = this.centers[i]!;
    const solved = this.resolved();
    const line = refLine(ref, solved);
    if (typeof line === "string") {
      this.dialog.setError(line);
      return;
    }
    const measured = signedDistance(line, solved[i] ?? c);
    const dim: HoleDim = { ref, d: `${+Math.abs(measured).toFixed(2)}`, side: measured < 0 ? -1 : 1 };
    c.dims = [...(c.dims ?? []), dim];
    const k = c.dims.length - 1;
    const nowLocked = c.dims.length >= 2;
    // Two constraints lock the hole: step 1 again for the next one.
    this.selection = nowLocked ? null : { kind: "hole", i };
    this.update();
    this.ctx.view.editDimLabel(`${i}.${k}`, dim.d, (text) => {
      if (text !== "" && evalExpression(text, this.ctx.params()) !== null) dim.d = text;
      this.update();
      this.ctx.status("HOLE", nowLocked ? `Hole ${i + 1} locked - ${this.hint()}` : this.hint());
    });
  }

  private resolved(): Point[] {
    const r = resolveCenters({ centers: this.centers }, this.ctx.params());
    return typeof r === "string" ? this.centers.map((c) => ({ x: c.x, y: c.y })) : r;
  }

  /** Green = locked (2 constraints), red = still free. */
  private markerColors(): string[] {
    return this.centers.map((_, i) => (this.locked(i) ? "#4caf50" : "#ff5a5a"));
  }

  private selectedMarker(): { point: Point; snap: string | null } | null {
    const sel = this.selection;
    if (sel === null) return null;
    const p = this.resolved()[sel.i];
    return p === undefined ? null : { point: p, snap: "selected" };
  }

  /** On-model dimension graphics for every hole's dimensions. */
  private dimensionGraphics(): { id: string; segs: [Point, Point][]; labelAt: Point; text: string; selected: boolean }[] {
    const out: { id: string; segs: [Point, Point][]; labelAt: Point; text: string; selected: boolean }[] = [];
    const solved = this.resolved();
    const arrow = this.ctx.view.pixelSize() * 9;
    this.centers.forEach((c, i) => {
      const q = solved[i];
      if (q === undefined) return;
      (c.dims ?? []).forEach((dim, k) => {
        const line = refLine(dim.ref, solved);
        if (typeof line === "string") return;
        const dist = signedDistance(line, q);
        const foot = { x: q.x - line.n.x * dist, y: q.y - line.n.y * dist };
        const segs: [Point, Point][] = [[foot, q]];
        // Arrowheads at both ends of the dimension line.
        const len = Math.abs(dist);
        if (len > 1e-9) {
          const t = { x: (q.x - foot.x) / len, y: (q.y - foot.y) / len };
          const nrm = { x: -t.y, y: t.x };
          const head = (tip: Point, dir: number): void => {
            for (const s of [1, -1]) {
              segs.push([tip, { x: tip.x - dir * t.x * arrow + s * nrm.x * arrow * 0.35, y: tip.y - dir * t.y * arrow + s * nrm.y * arrow * 0.35 }]);
            }
          };
          head(q, 1);
          head(foot, -1);
        }
        // Extension line from the reference to the foot.
        if (dim.ref.kind === "edge") {
          const [a, b] = dim.ref.seg;
          const da = Math.hypot(foot.x - a.x, foot.y - a.y);
          const db = Math.hypot(foot.x - b.x, foot.y - b.y);
          const segLen = Math.hypot(b.x - a.x, b.y - a.y);
          if (Math.max(da, db) > segLen + 1e-9) segs.push([da < db ? a : b, foot]);
        } else {
          const p = dim.ref.kind === "point" ? dim.ref.p : solved[dim.ref.index];
          if (p !== undefined) segs.push([p, foot]);
        }
        const value = evalExpression(dim.d, this.ctx.params());
        const text = value === null ? dim.d : /^[\d.]+$/.test(dim.d) ? dim.d : `${dim.d} = ${+value.toFixed(3)}`;
        const sel = this.selection;
        out.push({
          id: `${i}.${k}`,
          segs,
          labelAt: { x: (foot.x + q.x) / 2, y: (foot.y + q.y) / 2 },
          text,
          selected: (sel?.kind === "dim" && sel.i === i && sel.k === k) || (sel?.kind === "hole" && sel.i === i),
        });
      });
    });
    return out;
  }

  // --- feature & preview ---

  private feature(): HoleFeature | null {
    if (this.face === null) return null;
    const f: HoleFeature = {
      id: this.editing?.id ?? "HolePreview",
      type: "hole",
      face: this.face,
      centers: this.centers,
      diameter: this.v.diameter,
      depth: this.v.depth,
      style: this.style,
    };
    if (this.through) f.extent = "through";
    if (this.style === "counterbore") {
      f.cbDiameter = this.v.cbDiameter;
      f.cbDepth = this.v.cbDepth;
    }
    if (this.style === "countersink") {
      f.csDiameter = this.v.csDiameter;
      f.csAngle = this.v.csAngle;
    }
    return f;
  }

  private update(): void {
    this.depthField.setVisible(!this.through);
    this.cbFields.forEach((f) => f.setVisible(this.style === "counterbore"));
    this.csFields.forEach((f) => f.setVisible(this.style === "countersink"));
    this.faceSel.set(this.face === null ? "Click on a flat face" : "Face picked", this.face !== null);
    const n = this.centers.length;
    const dims = this.centers.reduce((s, c) => s + (c.dims?.length ?? 0), 0);
    this.holesSel.set(n === 0 ? "None yet" : `${n} hole${n === 1 ? "" : "s"} · ${dims} constraint${dims === 1 ? "" : "s"}`, n > 0);
    if (this.frame !== null) {
      this.ctx.view.setMarkers(this.frame, this.resolved(), this.selectedMarker(), this.markerColors());
      this.ctx.view.setDimensions(this.frame, this.dimensionGraphics());
    }

    const f = this.feature();
    let error: string | null = null;
    let tools: ReturnType<typeof holeTools> = [];
    if (f === null || this.frame === null) error = "Click on a flat face where the hole goes";
    else if (n === 0) error = "Click on the face to place a hole";
    else {
      tools = holeTools(f, this.frame, this.ctx.params(), throughLength(this.ctx.result()?.bodies ?? [], this.frame));
      if (typeof tools === "string") error = tools;
    }
    this.dialog.setError(error);
    this.ctx.view.setPreview(error === null && typeof tools !== "string" ? tools : null, true);
  }

  ok(): void {
    if (this.ctx.view.hasDimEdit()) {
      this.ctx.view.commitDimEdit(); // finish the open value first; OK again to finish the hole
      return;
    }
    this.update();
    const f = this.feature();
    if (f === null || this.frame === null || this.centers.length === 0) return;
    if (typeof holeTools(f, this.frame, this.ctx.params(), 1) === "string") return;
    // Store solved positions too (a readable file); dims keep them parametric.
    const solved = this.resolved();
    f.centers = this.centers.map((c, i) => ({ ...c, x: solved[i]!.x, y: solved[i]!.y }));
    this.close();
    this.ctx.commit((part) => {
      if (this.editing !== null) {
        const i = part.features.findIndex((x) => x.id === this.editing!.id);
        if (i >= 0) part.features[i] = { ...f, id: this.editing.id };
        return;
      }
      part.features.push({ ...f, id: nextId(part, "Hole") });
    });
    this.ctx.done();
  }

  cancel(): void {
    this.close();
    this.ctx.done();
  }

  private close(): void {
    this.dialog.close();
    this.ctx.view.onDimClick = null;
    this.ctx.view.setDimensions(null, []);
    this.ctx.view.setPickMode("none");
    this.ctx.view.setPreview(null);
    this.ctx.view.setMarkers(null, [], null);
    this.ctx.view.setHighlightLines(null, []);
  }
}

function sameRef(a: TopoRef, b: TopoRef): boolean {
  return a.feature === b.feature && a.role === b.role && a.index === b.index;
}
