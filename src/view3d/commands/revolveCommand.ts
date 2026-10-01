/**
 * MinimalCAD Web
 * view3d/commands/revolveCommand.ts
 *
 * Revolve, driven by an Inventor-style dialog: Profile (click closed shapes
 * in the view), Axis (click a straight line of the same sketch, or one of
 * the sketch's own two axes), Operation (Join / Cut / New), Extent (Full /
 * Angle), Angle, Direction -- with a live preview (blue, or red for a cut).
 *
 * The view picks for one row at a time (Profile first, then Axis); clicking
 * a row in the dialog goes back to picking for it.
 */

import type { Point } from "../../core/types";
import type { ExtrudeDirection, FeatureOperation, RevolveAxis, RevolveFeature } from "../../part/types";
import { DRAWING_SKETCH, nextId, usesSketch } from "../../part/types";
import { resolveRevolveAxis, revolveSweep, selectRegions } from "../../part/rebuild";
import type { SketchGeometry } from "../../part/rebuild";
import { revolveRegions } from "../../part/kernel/revolveRegion";
import type { AxisLine } from "../../part/kernel/revolveRegion";
import { regionContains, regionSeed } from "../../part/profile";
import type { Region } from "../../part/profile";
import { fromLocal, localTo3d, toLocal } from "../../part/plane";
import type { Vec3 } from "../../part/vec3";
import type { Hit, PickableRegion } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { ChoiceHandle, FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

/** Something the axis can be: a line of the sketch, or one of its own axes. */
interface AxisCandidate {
  axis: RevolveAxis;
  line: AxisLine;
  label: string;
  /** How it is drawn / picked in the view. */
  polyline: Vec3[];
}

export class RevolveCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private regions: PickableRegion[] = [];
  private chosen: PickableRegion[] = [];
  private sketchId: string | null = null;
  private profiles: RevolveFeature["profiles"] | null = null;
  private axis: RevolveAxis | null = null;
  private candidates: AxisCandidate[] = [];
  private hover: number | null = null;
  private stage: "profile" | "axis" = "profile";
  private operation: FeatureOperation;
  private direction: ExtrudeDirection = "normal";
  private partial = false;
  private angle = "90";
  private profileSel: SelectionHandle;
  private axisSel: SelectionHandle;
  private angleField: FieldHandle;
  private directionChoice: ChoiceHandle<ExtrudeDirection>;

  /** Returns null (after telling the user) if there's nothing to revolve. */
  static start(ctx: ModelContext, editing: RevolveFeature | null): RevolveCommand | null {
    if (editing === null && RevolveCommand.allRegions(ctx).length === 0) {
      showToast("Nothing to revolve - draw a closed shape first (in 2D, or in a sketch).");
      return null;
    }
    return new RevolveCommand(ctx, editing);
  }

  private static allRegions(ctx: ModelContext): PickableRegion[] {
    const r = ctx.result();
    const all: PickableRegion[] = [];
    const add = (sketchId: string): void => {
      const geo = r?.sketches.get(sketchId);
      geo?.profiles.regions.forEach((region, index) => all.push({ sketchId, index, region, frame: geo.frame }));
    };
    add(DRAWING_SKETCH);
    for (const s of ctx.part().sketches) add(s.id);
    return all;
  }

  private constructor(
    private ctx: ModelContext,
    private editing: RevolveFeature | null,
  ) {
    const hasSolid = (ctx.result()?.bodies.length ?? 0) > 0;
    this.operation = editing?.operation ?? (hasSolid ? "join" : "new");
    if (editing !== null) {
      this.sketchId = editing.sketch;
      this.profiles = editing.profiles;
      this.axis = editing.axis;
      this.direction = editing.direction;
      this.partial = editing.extent === "angle";
      this.angle = editing.angle;
    }

    this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Revolve" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    });
    const d = this.dialog;
    this.profileSel = d.selection("Profile", "", false, editing === null ? () => this.setStage("profile") : undefined);
    this.axisSel = d.selection("Axis", "", false, () => this.setStage("axis"));
    d.choice<FeatureOperation>(
      "Operation",
      [
        { value: "join", label: "Join", icon: ICONS.join, title: "Add material to the solid it touches" },
        { value: "cut", label: "Cut", icon: ICONS.cut, title: "Remove material (a groove, a bore)" },
        { value: "new", label: "New", icon: ICONS.newBody, title: "Make a separate solid" },
      ],
      this.operation,
      (v) => {
        this.operation = v;
        this.update();
      },
    );
    d.choice<"full" | "angle">(
      "Extent",
      [
        { value: "full", label: "Full", icon: ICONS.revFull, title: "A full turn (360°)" },
        { value: "angle", label: "Angle", icon: ICONS.revAngle, title: "Part of a turn" },
      ],
      this.partial ? "angle" : "full",
      (v) => {
        this.partial = v === "angle";
        this.update();
      },
    );
    this.angleField = d.number("Angle", "°", this.angle, (t) => {
      this.angle = t;
      this.update();
    });
    this.directionChoice = d.choice<ExtrudeDirection>(
      "Direction",
      [
        { value: "normal", label: "One side", icon: ICONS.dirOne },
        { value: "reverse", label: "Flip", icon: ICONS.dirFlip },
        { value: "symmetric", label: "Both", icon: ICONS.dirSym, title: "Symmetric - half the angle each side of the sketch" },
      ],
      this.direction,
      (v) => {
        this.direction = v;
        this.update();
      },
    );
    d.hint(
      editing === null
        ? "Click a closed shape, then the line to spin it round. Click the Profile or Axis row to pick it again."
        : "Click another line in the view to change the axis.",
    );

    ctx.view.onEdgeHover = (hit) => this.onHover(hit);
    if (editing === null) this.startPicking();
    else {
      this.buildCandidates();
      this.setStage("axis");
    }
    this.update();
  }

  /** Offer shapes no feature uses yet first; auto-pick when there's only one. */
  private startPicking(): void {
    const part = this.ctx.part();
    const all = RevolveCommand.allRegions(this.ctx);
    const consumed = (r: PickableRegion): boolean =>
      part.features
        .filter(usesSketch)
        .some((f) => f.sketch === r.sketchId && (f.profiles === "all" || f.profiles.some((s) => regionContains(r.region, toLocal(s)))));
    const fresh = all.filter((r) => !consumed(r));
    this.regions = fresh.length > 0 ? fresh : all;
    this.ctx.showWireframes(new Set(this.regions.map((c) => c.sketchId)));
    if (this.regions.length === 1) this.toggle(this.regions[0]!);
    else this.setStage("profile");
  }

  private geo(): SketchGeometry | undefined {
    return this.sketchId === null ? undefined : this.ctx.result()?.sketches.get(this.sketchId);
  }

  private chosenRegions(): Region[] {
    const geo = this.geo();
    return geo === undefined || this.profiles === null ? [] : selectRegions(geo.profiles.regions, this.profiles);
  }

  /** The chosen sketch's lines, then its own two axes (long enough to see). */
  private buildCandidates(): void {
    const geo = this.geo();
    this.candidates = [];
    if (geo === undefined) return;
    const pts = (a: Point, b: Point): Vec3[] => [localTo3d(geo.frame, a), localTo3d(geo.frame, b)];
    let reach = 20;
    for (const r of geo.profiles.regions) for (const p of r.outer.polygon) reach = Math.max(reach, Math.abs(p.x) * 1.25, Math.abs(p.y) * 1.25);
    for (const [a, b] of geo.lines) {
      reach = Math.max(reach, Math.abs(a.x), Math.abs(a.y), Math.abs(b.x), Math.abs(b.y));
      this.candidates.push({ axis: { kind: "line", a: fromLocal(a), b: fromLocal(b) }, line: { a, b }, label: "Sketch line", polyline: pts(a, b) });
    }
    const drawing = this.sketchId === DRAWING_SKETCH;
    this.candidates.push(
      { axis: { kind: "u" }, line: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, label: drawing ? "X axis" : "Sketch horizontal axis", polyline: pts({ x: -reach, y: 0 }, { x: reach, y: 0 }) },
      { axis: { kind: "v" }, line: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } }, label: drawing ? "Y axis" : "Sketch vertical axis", polyline: pts({ x: 0, y: -reach }, { x: 0, y: reach }) },
    );
  }

  /** The candidate the current axis is (the same infinite line), or -1. */
  private axisIndex(): number {
    const geo = this.geo();
    if (this.axis === null || geo === undefined) return -1;
    if (this.axis.kind !== "line") return this.candidates.findIndex((c) => c.axis.kind === this.axis!.kind);
    const { a, b } = resolveRevolveAxis(this.axis, geo.lines);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const off = (p: Point): number => Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len;
    return this.candidates.findIndex((c) => c.axis.kind === "line" && off(c.line.a) <= len * 1e-6 && off(c.line.b) <= len * 1e-6);
  }

  /** A sketch with exactly ONE line that isn't a side of the chosen shapes:
   *  that line is surely the axis (Inventor's centreline habit). */
  private autoAxis(): void {
    const sides: [Point, Point][] = [];
    for (const r of this.chosenRegions()) {
      for (const loop of [r.outer, ...r.holes]) for (const s of loop.segments) if (s.kind === "line") sides.push([s.a, s.b]);
    }
    const near = (p: Point, q: Point): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= 1e-6 * (1 + Math.abs(p.x) + Math.abs(p.y));
    const loose = this.candidates.filter(
      (c) => c.axis.kind === "line" && !sides.some(([a, b]) => (near(a, c.line.a) && near(b, c.line.b)) || (near(a, c.line.b) && near(b, c.line.a))),
    );
    if (loose.length === 1) this.axis = loose[0]!.axis;
  }

  private setStage(stage: "profile" | "axis"): void {
    if (stage === "axis" && this.sketchId === null) stage = "profile"; // no sketch yet: nothing to pick an axis from
    this.stage = stage;
    this.hover = null;
    const view = this.ctx.view;
    if (stage === "profile") {
      view.setPickMode("region", this.regions);
      view.setSelectedRegions(this.chosen);
      this.ctx.status("REVOLVE", "Click the closed shape(s) to revolve");
    } else {
      view.setEdgePickMode(this.candidates.map((c) => c.polyline));
      this.ctx.status(
        "REVOLVE",
        this.axis === null
          ? "Now click the AXIS - the line to revolve round (a line of the sketch, or its X / Y axis)"
          : "Axis picked (shown blue) - click another line to change it, or OK",
      );
    }
    this.profileSel.setActive(stage === "profile" && this.editing === null);
    this.axisSel.setActive(stage === "axis");
    this.drawLines();
  }

  private toggle(region: PickableRegion): void {
    // One feature revolves shapes from one sketch.
    const sketchChanged = this.chosen.length > 0 && this.chosen[0]!.sketchId !== region.sketchId;
    if (sketchChanged) this.chosen = [];
    this.chosen = this.chosen.includes(region) ? this.chosen.filter((r) => r !== region) : [...this.chosen, region];
    const before = this.sketchId;
    if (this.chosen.length === 0) {
      this.sketchId = null;
      this.profiles = null;
    } else {
      this.sketchId = this.chosen[0]!.sketchId;
      this.profiles = this.profilesFor(this.chosen);
    }
    if (this.sketchId !== before) {
      this.axis = null; // an axis belongs to its sketch
      this.buildCandidates();
    }
    if (this.sketchId !== null && this.axis === null) this.autoAxis();
    // First shape picked: the view asks for the axis next (even when one was
    // found automatically -- it is shown, and another click changes it).
    this.setStage(this.chosen.length === 1 && (this.axis === null || sketchChanged || before === null) ? "axis" : "profile");
    this.update();
  }

  private profilesFor(chosen: PickableRegion[]): RevolveFeature["profiles"] {
    const sketchId = chosen[0]!.sketchId;
    const total = this.ctx.result()?.sketches.get(sketchId)?.profiles.regions.length ?? 0;
    if (sketchId !== DRAWING_SKETCH && chosen.length === total) return "all";
    return chosen.map((c) => regionSeed(c.region));
  }

  onPick(hit: Hit): void {
    if (hit.kind === "region" && this.editing === null && this.stage === "profile") this.toggle(hit.region);
    else if (hit.kind === "edge" && this.stage === "axis") {
      this.axis = this.candidates[hit.index]!.axis;
      this.hover = null;
      this.update();
      this.ctx.status("REVOLVE", "Axis picked (shown blue) - click another line to change it, or OK");
    }
  }

  private onHover(hit: Hit | null): void {
    if (this.stage !== "axis") return;
    this.hover = hit?.kind === "edge" ? hit.index : null;
    this.drawLines();
  }

  /** Blue: the chosen shapes' outlines and the axis. Yellow: the hovered line. */
  private drawLines(): void {
    const geo = this.geo();
    const selected: Vec3[][] = [];
    if (geo !== undefined && this.stage === "axis") {
      for (const r of this.chosenRegions()) {
        for (const loop of [r.outer, ...r.holes]) selected.push([...loop.polygon, loop.polygon[0]!].map((p) => localTo3d(geo.frame, p)));
      }
    }
    const at = this.axisIndex();
    if (at >= 0) selected.push(this.candidates[at]!.polyline);
    this.ctx.view.setEdgeHighlights(selected, this.hover === null ? [] : [this.candidates[this.hover]!.polyline]);
  }

  private feature(): Pick<RevolveFeature, "extent" | "angle" | "direction"> {
    return { ...(this.partial ? { extent: "angle" as const } : {}), angle: this.angle, direction: this.direction };
  }

  /** Validates, updates the dialog state and the live preview. */
  private update(): void {
    this.angleField.setVisible(this.partial);
    this.directionChoice.setVisible(this.partial);
    const n = this.chosen.length;
    this.profileSel.set(
      this.editing !== null
        ? `from ${this.sketchId === DRAWING_SKETCH ? "2D Drawing" : this.sketchId}`
        : n === 0
          ? "Click a closed shape in the view"
          : `${n} shape${n === 1 ? "" : "s"} selected`,
      this.editing !== null || n > 0,
    );
    const at = this.axisIndex();
    this.axisSel.set(
      this.axis === null ? (this.sketchId === null ? "Pick the profile first" : "Click the axis line in the view") : at >= 0 ? this.candidates[at]!.label : "Sketch line",
      this.axis !== null,
    );
    this.drawLines();

    const geo = this.geo();
    const regions = this.chosenRegions();
    const sweep = revolveSweep(this.feature(), this.ctx.params());
    let error: string | null = null;
    let preview: ReturnType<typeof revolveRegions> | null = null;
    if (geo === undefined || this.profiles === null) error = "Pick at least one closed shape";
    else if (regions.length === 0) error = "Profile not found - the shape was deleted or opened up";
    else if (this.axis === null) error = "Pick the axis - a line to revolve round";
    else if (sweep === null) error = "Angle must be more than 0, up to 360";
    else {
      preview = revolveRegions("preview", regions, geo.frame, resolveRevolveAxis(this.axis, geo.lines), sweep[0], sweep[1]);
      if (typeof preview === "string") error = preview;
    }
    this.dialog.setError(error);
    this.ctx.view.setPreview(preview !== null && typeof preview !== "string" ? preview : null, this.operation === "cut");
  }

  /** Whether the dialog's state makes a valid feature right now. */
  private valid(): boolean {
    const geo = this.geo();
    const sweep = revolveSweep(this.feature(), this.ctx.params());
    const regions = this.chosenRegions();
    if (geo === undefined || this.axis === null || sweep === null || regions.length === 0) return false;
    return typeof revolveRegions("check", regions, geo.frame, resolveRevolveAxis(this.axis, geo.lines), sweep[0], sweep[1]) !== "string";
  }

  ok(): void {
    this.update();
    if (this.sketchId === null || this.profiles === null || this.axis === null || !this.valid()) return;
    const sketch = this.sketchId;
    const profiles = this.profiles;
    const axis = this.axis;
    const hadBodies = (this.ctx.result()?.bodies.length ?? 0) > 0;
    this.close();
    this.ctx.commit((part) => {
      const data = { axis, angle: this.angle, direction: this.direction, operation: this.operation };
      if (this.editing !== null) {
        const f = part.features.find((x) => x.id === this.editing!.id);
        if (f !== undefined && f.type === "revolve") {
          Object.assign(f, data);
          if (this.partial) f.extent = "angle";
          else delete f.extent;
        }
        return;
      }
      part.features.push({
        id: nextId(part, "Revolve"),
        type: "revolve",
        sketch,
        profiles,
        ...data,
        ...(this.partial ? { extent: "angle" as const } : {}),
      });
    });
    if (!hadBodies) this.ctx.view.fit();
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
