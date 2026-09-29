/**
 * MinimalCAD Web
 * view3d/commands/holeCommand.ts
 *
 * Hole: a small Inventor-style dialog for the hole itself (Type, Ø,
 * Termination) plus ONE placement button, "Add constraint". Everything
 * about positions happens on the model:
 *
 *   - click on a flat face: drops a hole (snaps to the face's own edge ends,
 *     midpoints and circle centres); click on the OUTSIDE of a round face:
 *     a radial hole, aimed at its axis;
 *   - "Add constraint" on: STEP 1 click the hole to constrain; STEP 2 click
 *     an edge / a locked hole's centre / a circle centre on the face -> a
 *     real dimension (extension line, arrows, value) appears on the face
 *     with its value box open -- type the distance, Enter. After two the
 *     hole is LOCKED (green) and others can be constrained from it;
 *   - on a round face the two are one distance ALONG the axis (from an end
 *     face or a locked hole) and one ANGLE around it (from a main plane's
 *     line, a flat along the shaft, a seam or a locked hole);
 *   - click a dimension's value to change it; Delete removes the selected
 *     dimension or hole. Holes dimensioned from earlier holes follow them.
 *
 * The dimensions are only shown while the Hole feature is open.
 */

import type { HoleCenter, HoleDim, HoleFeature, HoleRef, HoleStyle } from "../../part/types";
import { nextId } from "../../part/types";
import type { TopoRef } from "../../part/kernel/types";
import { faceHasRef } from "../../part/kernel/types";
import { faceSurfaceOf, rebuild, surfaceThroughLength } from "../../part/rebuild";
import { dependsOn, holeTools, refLine, resolveCenters, signedDistance } from "../../part/hole";
import { edgesOnFace, refsOnRoundFace } from "../../part/faceTopology";
import type { RoundFaceRef } from "../../part/faceTopology";
import type { CylFrame, Surface } from "../../part/cylFrame";
import { isCyl, mmPerDeg, wrapDeg } from "../../part/cylFrame";
import { evalExpression } from "../../part/params";
import type { Point } from "../../core/types";
import type { Hit } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { ChoiceHandle, FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

const PICK_PX = 12;
const OTHER_FACE = "Holes in one Hole feature go on one face - OK this one, then start another Hole";

type Selection = { kind: "hole"; i: number } | { kind: "dim"; i: number; k: number } | null;
type Termination = "through" | "toAxis" | "distance";
type SurfaceHit = Extract<Hit, { kind: "surfacePoint" }>;
/** A dimension's direction: "u" = along x (on a round face: along the
 *  axis), "v" = along y (on a round face: an angle). */
type Dir = "u" | "v";

export class HoleCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private face: TopoRef | null = null;
  private frame: Surface | null = null;
  private centers: HoleCenter[] = [];
  private constrain = false;
  private selection: Selection = null;
  private style: HoleStyle = "plain";
  private termination: Termination = "through";
  private v = { diameter: "10", depth: "20", cbDiameter: "18", cbDepth: "6", csDiameter: "20", csAngle: "90" };

  /** The picked face's own straight edges and circle centres (face coords);
   *  on a round face, its end rims, seams, flats and main-plane lines. */
  private faceLines: RoundFaceRef[] = [];
  private faceCircles: Point[] = [];

  private faceSel: SelectionHandle;
  private holesSel: SelectionHandle;
  private constrainToggle: { set(on: boolean): void };
  private flatTerm: ChoiceHandle<Termination>;
  private radialTerm: ChoiceHandle<Termination>;
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
      this.termination = editing.extent ?? "distance";
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
    this.faceSel = d.selection("Face", "Click on a face");
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
    const setTerm = (t: Termination): void => {
      this.termination = t;
      this.update();
    };
    const through = { value: "through" as const, label: "Through all", icon: ICONS.through };
    const distance = { value: "distance" as const, label: "Distance", icon: ICONS.distance, title: "Blind hole, with a 118° drill point" };
    this.flatTerm = d.choice<Termination>("Termination", [through, distance], this.termination, setTerm);
    this.radialTerm = d.choice<Termination>(
      "Termination",
      [through, { value: "toAxis", label: "To axis", icon: ICONS.toAxis, title: "Blind, down to the centre line" }, distance],
      this.termination,
      setTerm,
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
      // Face as built *before* this hole (its own cut doesn't move it).
      const part = ctx.part();
      const upTo = { ...part, features: part.features.slice(0, part.features.findIndex((x) => x.id === editing.id)) };
      const before = rebuild(upTo, ctx.drawingEntities()).bodies;
      this.useFace(editing.face, faceSurfaceOf(before, editing.face), before);
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
    if (this.face === null) return "Click on a flat face where the hole goes - or on the outside of a round face for a radial hole";
    const round = this.cyl() !== null;
    if (!this.constrain) {
      return round
        ? "Click on the round face for more holes (they point at its axis) - press Add constraint to dimension them - OK when done"
        : "Click on the face for more holes - press Add constraint to dimension them - OK when done";
    }
    const sel = this.selection;
    if (sel?.kind === "hole") {
      const n = this.centers[sel.i]?.dims?.length ?? 0;
      if (n < 2) {
        const more = `${2 - n} more to lock it`;
        if (!round) return `Step 2 - Hole ${sel.i + 1}: click an edge or a locked (green) hole's centre - ${more}`;
        const used = this.usedDirs(sel.i);
        const want = used.has("u")
          ? "the ANGLE: click a plane line, a flat, a seam or a locked hole"
          : used.has("v")
            ? "the distance ALONG the axis: click an end face's rim or a locked hole"
            : "click an end face's rim (distance along) or a plane line / flat / locked hole (angle)";
        return `Step 2 - Hole ${sel.i + 1}: ${want} - ${more}`;
      }
      return `Hole ${sel.i + 1} is locked - Step 1: click the next hole to constrain (or click a value to change it)`;
    }
    const free = this.centers.filter((c) => (c.dims?.length ?? 0) < 2).length;
    return free === 0
      ? "All holes locked - click a value to change it, or OK"
      : "Step 1: click the hole to constrain (click a value to change it, Delete removes)";
  }

  // --- face ---

  private useFace(face: TopoRef, frame: Surface | null, bodies = this.ctx.result()?.bodies ?? []): void {
    if (frame === null) {
      showToast("That face can't be used for a hole.");
      return;
    }
    this.face = face;
    this.frame = frame;
    const body = bodies.find((b) => b.faces.some((f) => faceHasRef(f, face)));
    if (isCyl(frame)) {
      this.faceLines = body === undefined ? [] : refsOnRoundFace(body, face, frame);
      this.faceCircles = [];
      return;
    }
    if (this.termination === "toAxis") this.termination = "through";
    const topo = body === undefined ? null : edgesOnFace(body, frame);
    this.faceLines = (topo?.lines ?? []).map((seg) => ({ seg, label: "edge" }));
    this.faceCircles = topo?.circles.map((c) => c.center) ?? [];
  }

  private cyl(): CylFrame | null {
    return this.frame !== null && isCyl(this.frame) ? this.frame : null;
  }

  // --- face coordinates <-> mm (on a round face y is an angle) ---

  /** mm per unit of y: 1 on a flat face, mm per degree on a round one. */
  private ky(): number {
    const c = this.cyl();
    return c === null ? 1 : mmPerDeg(c);
  }

  /** b.y - a.y, the short way round on a round face. */
  private dy(a: number, b: number): number {
    return this.cyl() === null ? b - a : wrapDeg(b - a);
  }

  /** Distance in mm between two face points. */
  private dist(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, this.dy(a.y, b.y) * this.ky());
  }

  private toMm(p: Point): Point {
    return { x: p.x, y: p.y * this.ky() };
  }

  private fromMm(p: Point): Point {
    return { x: p.x, y: p.y / this.ky() };
  }

  // --- picking helpers ---

  /** True if the face under the cursor is the one these holes are on. */
  private isOurFace(hit: SurfaceHit): boolean {
    const face = hit.body.faces[hit.faceId];
    return this.face !== null && face !== undefined && faceHasRef(face, this.face);
  }

  /** Screen pixels per face unit (x, y) where the cursor is: picking is
   *  measured on screen, so a face seen at a slant picks as easily. */
  private px: Point = { x: 1, y: 1 };

  private setPickScale(p: Point): void {
    if (this.frame === null) return;
    const s = this.ctx.view.pxPerUnit(this.frame, p);
    // A face seen almost edge-on must not make everything "near".
    const square = 0.25 / this.ctx.view.pixelSize();
    this.px = { x: Math.max(s.x, square), y: Math.max(s.y, square * this.ky()) };
  }

  /** Screen distance (px) between two face points. */
  private pxDist(a: Point, b: Point): number {
    return Math.hypot((b.x - a.x) * this.px.x, this.dy(a.y, b.y) * this.px.y);
  }

  private holeNear(p: Point): number | null {
    const solved = this.resolved();
    let best: number | null = null;
    let bestD = PICK_PX;
    solved.forEach((c, i) => {
      const d = this.pxDist(c, p);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private dirOfRef(ref: HoleRef): Dir | null {
    const line = refLine(ref, this.resolved());
    return typeof line === "string" ? null : Math.abs(line.n.x) >= Math.abs(line.n.y) ? "u" : "v";
  }

  /** Directions hole `i` is already dimensioned in. On a round face its two
   *  must be one along the axis and one angle, so a used one is not offered. */
  private usedDirs(i: number): Set<Dir> {
    const out = new Set<Dir>();
    if (this.cyl() === null) return out;
    for (const dim of this.centers[i]?.dims ?? []) {
      const dir = this.dirOfRef(dim.ref);
      if (dir !== null) out.add(dir);
    }
    return out;
  }

  /** Screen distance (px) from `p` to a reference line of the face. */
  private linePx(p: Point, seg: [Point, Point]): number {
    const [a, b] = seg;
    if (this.cyl() !== null) {
      if (Math.abs(a.x - b.x) < 1e-9) return Math.abs(p.x - a.x) * this.px.x; // an end rim, all round
      const over = Math.max(0, Math.min(a.x, b.x) - p.x, p.x - Math.max(a.x, b.x));
      return Math.hypot(over * this.px.x, this.dy(a.y, p.y) * this.px.y);
    }
    const s = (q: Point): Point => ({ x: q.x * this.px.x, y: q.y * this.px.y });
    const [sa, sb, sp] = [s(a), s(b), s(p)];
    const dx = sb.x - sa.x;
    const dy = sb.y - sa.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Infinity;
    const t = Math.max(0, Math.min(1, ((sp.x - sa.x) * dx + (sp.y - sa.y) * dy) / len2));
    return Math.hypot(sp.x - (sa.x + t * dx), sp.y - (sa.y + t * dy));
  }

  /** A reference near `p` for dimensioning hole `hole`: a locked hole's
   *  centre, a circle centre on the face, or an edge -- in that priority. */
  private refNear(p: Point, hole: number): { ref: HoleRef; label: string } | null {
    const tol = PICK_PX;
    const solved = this.resolved();
    const me = solved[hole] ?? p;
    const used = this.usedDirs(hole);
    const axisFor = (c: Point): Dir => {
      if (used.has("u")) return "v";
      if (used.has("v")) return "u";
      return Math.abs(me.x - c.x) >= Math.abs(this.dy(c.y, me.y)) * this.ky() ? "u" : "v";
    };
    for (let i = 0; i < solved.length; i++) {
      // Only LOCKED holes (2 constraints) can be referenced, and never one
      // that already depends on this hole (that would be a loop).
      if (i === hole || !this.locked(i) || dependsOn({ centers: this.centers }, i, hole)) continue;
      const c = solved[i]!;
      if (this.pxDist(c, p) <= tol) return { ref: { kind: "hole", index: i, axis: axisFor(c) }, label: `Hole ${i + 1}` };
    }
    for (const c of this.faceCircles) {
      if (this.pxDist(c, p) <= tol) return { ref: { kind: "point", p: c, axis: axisFor(c) }, label: "centre" };
    }
    let best: RoundFaceRef | null = null;
    let bestD = tol;
    for (const line of this.faceLines) {
      if (used.has(Math.abs(line.seg[0].x - line.seg[1].x) < 1e-9 ? "u" : "v")) continue;
      const dist = this.linePx(p, line.seg);
      if (dist < bestD) {
        bestD = dist;
        best = line;
      }
    }
    return best === null ? null : { ref: { kind: "edge", seg: best.seg }, label: best.label };
  }

  /** On a round face: a flat along the shaft under the cursor, while the
   *  selected hole still needs its angle -> dimension from that flat. */
  private flatRef(hit: SurfaceHit): { ref: HoleRef; label: string } | null {
    const sel = this.selection;
    if (this.cyl() === null || !this.constrain || sel?.kind !== "hole" || this.locked(sel.i) || this.usedDirs(sel.i).has("v")) return null;
    const face = hit.body.faces[hit.faceId];
    const line = face === undefined ? undefined : this.faceLines.find((l) => l.flat !== undefined && faceHasRef(face, l.flat));
    return line === undefined ? null : { ref: { kind: "edge", seg: line.seg }, label: line.label };
  }

  private locked(i: number): boolean {
    return (this.centers[i]?.dims?.length ?? 0) >= 2;
  }

  private refSegments(ref: HoleRef): [Point, Point][] {
    if (ref.kind === "edge") return [ref.seg];
    const c = ref.kind === "point" ? ref.p : this.resolved()[ref.index];
    if (c === undefined) return [];
    const s = this.ctx.view.pixelSize() * 9;
    const sy = s / this.ky();
    return [
      [{ x: c.x - s, y: c.y }, { x: c.x + s, y: c.y }],
      [{ x: c.x, y: c.y - sy }, { x: c.x, y: c.y + sy }],
    ];
  }

  // --- view events ---

  onPick(hit: Hit): void {
    if (hit.kind !== "surfacePoint") return;
    if (this.face === null) {
      this.useFace(hit.ref, faceSurfaceOf(this.ctx.result()?.bodies ?? [], hit.ref));
      if (this.face === null) return;
      this.addCenter(hit.point);
      return;
    }
    const sel = this.selection;
    if (!this.isOurFace(hit)) {
      const flat = this.flatRef(hit);
      if (flat !== null && sel?.kind === "hole") this.addDim(sel.i, flat.ref);
      else this.dialog.setError(OTHER_FACE);
      return;
    }
    if (!this.constrain) {
      this.addCenter(hit.point);
      return;
    }
    this.setPickScale(hit.raw);
    // Constraint mode: a reference for the selected hole, else select a hole.
    if (sel?.kind === "hole" && !this.locked(sel.i)) {
      const near = this.refNear(hit.raw, sel.i);
      if (near !== null) {
        this.addDim(sel.i, near.ref);
        return;
      }
    }
    const h = this.holeNear(hit.raw);
    this.selection = h === null ? null : { kind: "hole", i: h };
    this.update();
    this.ctx.status("HOLE", this.hint());
  }

  onSurfaceHover(hit: SurfaceHit | null): void {
    const onOurFace = hit !== null && (this.face === null || this.isOurFace(hit));
    if (onOurFace) this.setPickScale(hit.raw);
    let near: { ref: HoleRef; label: string } | null = null;
    const sel = this.selection;
    if (onOurFace && this.constrain && sel?.kind === "hole" && !this.locked(sel.i)) near = this.refNear(hit.raw, sel.i);
    if (hit !== null && !onOurFace) near = this.flatRef(hit);
    this.ctx.view.setHighlightLines(this.frame, near === null ? [] : this.refSegments(near.ref));
    const frame = this.frame ?? hit?.frame ?? null;
    const preview = onOurFace && !this.constrain ? { point: hit.point, snap: hit.snap } : null;
    this.ctx.view.setMarkers(frame, this.frame === null ? [] : this.resolved(), preview ?? this.selectedMarker(), this.markerColors());
    let status = this.hint();
    if (near !== null) {
      const dir = this.cyl() === null ? null : this.dirOfRef(near.ref);
      status =
        dir === null
          ? `Dimension from this ${near.ref.kind === "edge" ? "edge" : "centre"}`
          : `${dir === "u" ? "Distance along the axis" : "Angle"} from ${near.label.startsWith("Hole") ? near.label : `${near.label.endsWith("plane") ? "the" : "this"} ${near.label}`}`;
    } else if (hit !== null && !onOurFace) status = OTHER_FACE;
    this.ctx.status("HOLE", status);
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

  /** True if `dim` is an angle (on a round face). */
  private isAngle(ref: HoleRef): boolean {
    return this.cyl() !== null && this.dirOfRef(ref) === "v";
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
    let measured = signedDistance(line, solved[i] ?? c);
    if (this.isAngle(ref)) measured = wrapDeg(measured); // the short way round
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

  /** On-model dimension graphics for every hole's dimensions. Built in mm
   *  (so arrowheads keep their size on a round face), drawn in face coords. */
  private dimensionGraphics(): { id: string; segs: [Point, Point][]; labelAt: Point; text: string; selected: boolean }[] {
    const out: { id: string; segs: [Point, Point][]; labelAt: Point; text: string; selected: boolean }[] = [];
    const solved = this.resolved();
    const arrow = this.ctx.view.pixelSize() * 9;
    const round = this.cyl() !== null;
    const seg = (a: Point, b: Point): [Point, Point] => [this.fromMm(a), this.fromMm(b)];
    this.centers.forEach((c, i) => {
      const q = solved[i];
      if (q === undefined) return;
      (c.dims ?? []).forEach((dim, k) => {
        const line = refLine(dim.ref, solved);
        if (typeof line === "string") return;
        const dist = signedDistance(line, q);
        const foot = { x: q.x - line.n.x * dist, y: q.y - line.n.y * dist };
        const qm = this.toMm(q);
        const fm = this.toMm(foot);
        const segs: [Point, Point][] = [seg(fm, qm)];
        // Arrowheads at both ends of the dimension line.
        const len = Math.hypot(qm.x - fm.x, qm.y - fm.y);
        if (len > 1e-9) {
          const t = { x: (qm.x - fm.x) / len, y: (qm.y - fm.y) / len };
          const nrm = { x: -t.y, y: t.x };
          const head = (tip: Point, dir: number): void => {
            for (const s of [1, -1]) {
              segs.push(seg(tip, { x: tip.x - dir * t.x * arrow + s * nrm.x * arrow * 0.35, y: tip.y - dir * t.y * arrow + s * nrm.y * arrow * 0.35 }));
            }
          };
          head(qm, 1);
          head(fm, -1);
        }
        // Extension line from the reference to the foot.
        if (dim.ref.kind === "edge") {
          const [a, b] = dim.ref.seg;
          const rim = round && Math.abs(a.x - b.x) < 1e-9; // all round: the foot is always on it
          const da = this.dist(foot, a);
          const db = this.dist(foot, b);
          if (!rim && Math.max(da, db) > this.dist(a, b) + 1e-9) {
            const end = da < db ? a : b;
            segs.push(seg(this.toMm({ x: end.x, y: foot.y + this.dy(foot.y, end.y) }), fm));
          }
        } else {
          const p = dim.ref.kind === "point" ? dim.ref.p : solved[dim.ref.index];
          if (p !== undefined) segs.push(seg(this.toMm({ x: p.x, y: foot.y + this.dy(foot.y, p.y) }), fm));
        }
        const value = evalExpression(dim.d, this.ctx.params());
        const unit = this.isAngle(dim.ref) ? "°" : "";
        const text = value === null ? dim.d : /^[\d.]+$/.test(dim.d) ? `${dim.d}${unit}` : `${dim.d} = ${+value.toFixed(3)}${unit}`;
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
    if (this.cyl() !== null) f.placement = "radial";
    if (this.termination !== "distance") f.extent = this.termination;
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
    const cyl = this.cyl();
    this.flatTerm.setVisible(cyl === null);
    this.radialTerm.setVisible(cyl !== null);
    this.flatTerm.set(this.termination);
    this.radialTerm.set(this.termination);
    this.depthField.setVisible(this.termination === "distance");
    this.cbFields.forEach((f) => f.setVisible(this.style === "counterbore"));
    this.csFields.forEach((f) => f.setVisible(this.style === "countersink"));
    this.faceSel.set(
      this.face === null ? "Click on a face" : cyl !== null ? `Round face Ø${+(2 * cyl.radius).toFixed(3)}` : "Flat face",
      this.face !== null,
    );
    const n = this.centers.length;
    const dims = this.centers.reduce((s, c) => s + (c.dims?.length ?? 0), 0);
    this.holesSel.set(n === 0 ? "None yet" : `${n} hole${n === 1 ? "" : "s"} · ${dims} constraint${dims === 1 ? "" : "s"}`, n > 0);
    if (this.frame !== null) {
      this.ctx.view.setMarkers(this.frame, this.resolved(), this.selectedMarker(), this.markerColors());
      this.ctx.view.setDimensions(this.frame, this.dimensionGraphics());
    }
    // Round face, constraining: show the plane / flat lines angles are measured from.
    const guides = cyl !== null && this.constrain ? this.faceLines.filter((l) => l.label !== "end face" && l.label !== "edge").map((l) => l.seg) : [];
    this.ctx.view.setHighlightLines(this.frame, guides, "guide");

    const f = this.feature();
    let error: string | null = null;
    let tools: ReturnType<typeof holeTools> = [];
    if (f === null || this.frame === null) error = "Click on a face where the hole goes";
    else if (n === 0) error = "Click on the face to place a hole";
    else {
      tools = holeTools(f, this.frame, this.ctx.params(), surfaceThroughLength(this.ctx.result()?.bodies ?? [], this.frame));
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
    this.ctx.view.setHighlightLines(null, [], "guide");
  }
}
