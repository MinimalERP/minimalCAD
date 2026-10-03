/**
 * MinimalCAD Web
 * view3d/commands/extrudeCommand.ts
 *
 * Extrude, driven by an Inventor-style dialog: Profile (click shapes in the
 * view), Operation (Join / Cut / New), Extent (Distance / Through all),
 * Distance, Direction -- with a live preview (blue, or red for a cut).
 */

import type { ExtrudeDirection, ExtrudeFeature, FeatureOperation } from "../../part/types";
import { DRAWING_SKETCH, isExtrude, nextId, usesSketch } from "../../part/types";
import { extrudeExtent, extrudeTool, selectRegions, throughLength, upToPlane } from "../../part/rebuild";
import type { Body, TopoRef } from "../../part/kernel/types";
import { regionContains, regionSeed } from "../../part/profile";
import { toLocal } from "../../part/plane";
import { evalExpression } from "../../part/params";
import type { Hit, PickableRegion } from "../modelView";
import { FeatureDialog, ICONS } from "../featureDialog";
import type { ChoiceHandle, FieldHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

export class ExtrudeCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private candidates: PickableRegion[] = [];
  private chosen: PickableRegion[] = [];
  private sketchId: string | null = null;
  private profiles: ExtrudeFeature["profiles"] | null = null;
  private operation: FeatureOperation;
  private direction: ExtrudeDirection = "normal";
  private through = false;
  /** Extent "to face": the face to stop at, and whether the view is picking it now. */
  private toFace = false;
  private target: TopoRef | null = null;
  private pickingTarget = false;
  private targetSel!: { set(text: string, done: boolean): void; setActive(a: boolean): void };
  private targetRow!: { setVisible(v: boolean): void };
  private shapeRows!: { setVisible(v: boolean): void };
  private distance = "10";
  /** Taper / lean (degrees, as typed) and what the drawn shape is under a lean. */
  private shape = { taper: "0", lean: "0", leanToward: "0" };
  private square = true;
  private leanRows!: { setVisible(v: boolean): void };
  private selection: SelectionHandle;
  private distanceField: FieldHandle;
  private directionChoice: ChoiceHandle<ExtrudeDirection>;

  /** Returns null (after telling the user) if there's nothing to extrude. */
  /** `opts.sketch`: start with every shape of that sketch chosen (3D Line hands its loop over). */
  static start(ctx: ModelContext, editing: ExtrudeFeature | null, opts: { sketch?: string } = {}): ExtrudeCommand | null {
    if (editing === null && ExtrudeCommand.allRegions(ctx).length === 0) {
      showToast("Nothing to extrude - draw a closed shape first (in 2D, or in a sketch).");
      return null;
    }
    return new ExtrudeCommand(ctx, editing, opts.sketch ?? null);
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
    private editing: ExtrudeFeature | null,
    private preselect: string | null = null,
  ) {
    const hasSolid = (ctx.result()?.bodies.length ?? 0) > 0;
    this.operation = editing?.operation ?? (hasSolid ? "join" : "new");
    if (editing !== null) {
      this.sketchId = editing.sketch;
      this.profiles = editing.profiles;
      this.direction = editing.direction;
      this.through = editing.extent === "through";
      this.toFace = editing.extent === "toFace";
      this.target = editing.toFace ?? null;
      this.distance = editing.distance;
      this.shape = { taper: editing.taper ?? "0", lean: editing.lean ?? "0", leanToward: editing.leanToward ?? "0" };
      this.square = editing.section === "square" || editing.lean === undefined;
    }

    this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? "Extrude" : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    });
    const d = this.dialog;
    this.selection = d.selection("Profile", "");
    d.choice<FeatureOperation>(
      "Operation",
      [
        { value: "join", label: "Join", icon: ICONS.join, title: "Add material to the solid it touches" },
        { value: "cut", label: "Cut", icon: ICONS.cut, title: "Remove material" },
        { value: "new", label: "New", icon: ICONS.newBody, title: "Make a separate solid" },
      ],
      this.operation,
      (v) => {
        // Cutting from a sketch on a face goes into the material by default.
        if (v === "cut" && this.operation !== "cut" && this.onFace() && this.direction === "normal") this.setDirection("reverse");
        if (v !== "cut" && this.operation === "cut" && this.onFace() && this.direction === "reverse") this.setDirection("normal");
        this.operation = v;
        this.update();
      },
    );
    d.choice<"distance" | "through" | "toFace">(
      "Extent",
      [
        { value: "distance", label: "Distance", icon: ICONS.distance },
        { value: "through", label: "Through all", icon: ICONS.through, title: "All the way through the model" },
        { value: "toFace", label: "To face", icon: ICONS.toFace, title: "Up to a flat face of the solid (it may slope) - no distance to work out" },
      ],
      this.toFace ? "toFace" : this.through ? "through" : "distance",
      (v) => {
        this.through = v === "through";
        this.toFace = v === "toFace";
        this.pickTarget(this.toFace && this.target === null);
        this.update();
      },
    );
    this.targetRow = d.rowGroup(() => (this.targetSel = d.selection("Up to", "", false, () => this.pickTarget(true))));
    this.distanceField = d.number("Distance", "mm", this.distance, (t) => {
      this.distance = t;
      this.update();
    });
    this.directionChoice = d.choice<ExtrudeDirection>(
      "Direction",
      [
        { value: "normal", label: "One side", icon: ICONS.dirOne },
        { value: "reverse", label: "Flip", icon: ICONS.dirFlip },
        { value: "symmetric", label: "Both", icon: ICONS.dirSym, title: "Symmetric - half each side" },
      ],
      this.direction,
      (v) => {
        this.direction = v;
        this.update();
      },
    );
    this.shapeRows = d.rowGroup(() => {
      d.number("Taper", "°", this.shape.taper, (t) => {
        this.shape.taper = t;
        this.update();
      });
      d.number("Lean", "°", this.shape.lean, (t) => {
        this.shape.lean = t;
        this.update();
      });
    });
    this.leanRows = d.rowGroup(() => {
      d.number("Lean toward", "°", this.shape.leanToward, (t) => {
        this.shape.leanToward = t;
        this.update();
      });
      d.choice<"square" | "footprint">(
        "Drawn shape is",
        [
          { value: "square", label: "Section", title: "The shape you drew is the body's cross-section, square to the lean - a drawn circle makes a truly round boss" },
          { value: "footprint", label: "Footprint", title: "The shape you drew is the footprint on the sketch plane - a drawn circle stays a circle there" },
        ],
        this.square ? "square" : "footprint",
        (v) => {
          this.square = v === "square";
          this.update();
        },
      );
    });
    d.hint(
      (editing === null ? "Click inside closed shapes in the view to pick or unpick them. " : "") +
        "Taper slopes the sides in (minus = out). Lean tips the whole body; Lean toward is the direction in the sketch (0 = right, 90 = up).",
    );

    if (editing === null) this.startPicking();
    this.update();
    d.focusFirst();
  }

  private onFace(): boolean {
    return this.sketchId !== null && this.ctx.part().sketches.find((s) => s.id === this.sketchId)?.plane.base === "face";
  }

  private setDirection(v: ExtrudeDirection): void {
    this.direction = v;
    this.directionChoice.set(v);
  }

  /** Offer shapes not extruded yet first; auto-pick when there's only one. */
  private startPicking(): void {
    const part = this.ctx.part();
    const all = ExtrudeCommand.allRegions(this.ctx);
    const consumed = (r: PickableRegion): boolean =>
      part.features
        .filter(usesSketch)
        .some((f) => f.sketch === r.sketchId && (f.profiles === "all" || f.profiles.some((s) => regionContains(r.region, toLocal(s)))));
    const fresh = all.filter((r) => !consumed(r));
    this.candidates = fresh.length > 0 ? fresh : all;
    this.ctx.showWireframes(new Set(this.candidates.map((c) => c.sketchId)));
    this.ctx.view.setPickMode("region", this.candidates);
    const pre = this.candidates.filter((c) => c.sketchId === this.preselect);
    if (pre.length > 0) for (const c of pre) this.toggle(c);
    else if (this.candidates.length === 1) this.toggle(this.candidates[0]!);
    this.ctx.status("EXTRUDE", "Pick shapes in the view, set options in the dialog, then OK");
  }

  private toggle(region: PickableRegion): void {
    // One feature extrudes shapes from one sketch.
    if (this.chosen.length > 0 && this.chosen[0]!.sketchId !== region.sketchId) this.chosen = [];
    this.chosen = this.chosen.includes(region) ? this.chosen.filter((r) => r !== region) : [...this.chosen, region];
    this.ctx.view.setSelectedRegions(this.chosen);
    if (this.chosen.length === 0) {
      this.sketchId = null;
      this.profiles = null;
    } else {
      this.sketchId = this.chosen[0]!.sketchId;
      this.profiles = this.profilesFor(this.chosen);
    }
    this.update();
  }

  /** The 2D drawing keeps growing, so its picks are always seed points; a
   *  dedicated sketch with every shape chosen is simply "all". */
  private profilesFor(chosen: PickableRegion[]): ExtrudeFeature["profiles"] {
    const sketchId = chosen[0]!.sketchId;
    const total = this.ctx.result()?.sketches.get(sketchId)?.profiles.regions.length ?? 0;
    if (sketchId !== DRAWING_SKETCH && chosen.length === total) return "all";
    return chosen.map((c) => regionSeed(c.region));
  }

  onPick(hit: Hit): void {
    if (this.pickingTarget) {
      if (hit.kind !== "face") return;
      this.target = hit.ref;
      this.pickTarget(false);
      this.update();
      return;
    }
    if (hit.kind === "region" && this.editing === null) this.toggle(hit.region);
  }

  /** Switches the view between picking the face to stop at and (for a new
   *  extrude) picking shapes. */
  private pickTarget(on: boolean): void {
    this.pickingTarget = on;
    const view = this.ctx.view;
    if (on) {
      view.setPickMode("plane");
      view.setOriginPlanesVisible(false);
      this.ctx.status("EXTRUDE", "Click the flat face to extrude up to");
    } else if (this.editing === null) {
      view.setPickMode("region", this.candidates);
      view.setSelectedRegions(this.chosen);
      this.ctx.status("EXTRUDE", "Pick shapes in the view, set options in the dialog, then OK");
    } else view.setPickMode("none");
    this.targetSel.setActive(on);
  }

  /** The solid the dialog describes, or why it can't be built (null = not enough picked yet). */
  private build(id: string): Body | string | null {
    const r = this.ctx.result();
    const geo = this.sketchId === null ? undefined : r?.sketches.get(this.sketchId);
    if (geo === undefined || this.profiles === null) return null;
    const regions = selectRegions(geo.profiles.regions, this.profiles);
    if (regions.length === 0) return "Profile not found - the shape was deleted or opened up";
    if (this.toFace) {
      const plane = upToPlane(r?.bodies ?? [], this.target ?? undefined);
      return typeof plane === "string" ? plane : extrudeTool({ id }, regions, geo.frame, 0, 1, this.ctx.params(), plane);
    }
    const distance = this.through ? throughLength(r?.bodies ?? [], geo.frame) : evalExpression(this.distance, this.ctx.params());
    if (this.through && (r?.bodies.length ?? 0) === 0) return "Through all needs an existing solid";
    if (distance === null || !(distance > 0)) return "Distance must be a positive number";
    const [h0, h1] = this.through && this.direction === "symmetric" ? [-distance, distance] : extrudeExtent(this.direction, distance);
    return extrudeTool({ id, ...this.shapeData() }, regions, geo.frame, h0, h1, this.ctx.params());
  }

  /** Validates, updates the dialog state and the live preview. */
  private update(): void {
    this.distanceField.setVisible(!this.through && !this.toFace);
    this.directionChoice.setVisible(!this.toFace);
    this.targetRow.setVisible(this.toFace);
    this.shapeRows.setVisible(!this.toFace);
    this.leanRows.setVisible(this.leaning() && !this.toFace);
    this.targetSel.set(this.target === null ? "Click a flat face" : `Face of ${this.target.feature}`, this.target !== null);
    const n = this.editing !== null ? -1 : this.chosen.length;
    this.selection.set(
      this.editing !== null
        ? `from ${this.sketchId === DRAWING_SKETCH ? "2D Drawing" : this.sketchId}`
        : n === 0
          ? "Click a closed shape in the view"
          : `${n} shape${n === 1 ? "" : "s"} selected`,
      this.editing !== null || n > 0,
    );
    const tool = this.build("preview");
    this.dialog.setError(tool === null ? "Pick at least one closed shape" : typeof tool === "string" ? tool : null);
    this.ctx.view.setPreview(tool === null || typeof tool === "string" ? null : tool, this.operation === "cut");
  }

  private leaning(): boolean {
    const v = evalExpression(this.shape.lean, this.ctx.params());
    return v !== null && v !== 0;
  }

  /** Taper / lean as stored: only what is actually used. */
  private shapeData(): Pick<ExtrudeFeature, "taper" | "lean" | "leanToward" | "section"> {
    const used = (e: string): boolean => evalExpression(e, this.ctx.params()) !== 0;
    const out: Pick<ExtrudeFeature, "taper" | "lean" | "leanToward" | "section"> = {};
    if (used(this.shape.taper)) out.taper = this.shape.taper;
    if (used(this.shape.lean)) {
      out.lean = this.shape.lean;
      out.leanToward = this.shape.leanToward;
      if (this.square) out.section = "square";
    }
    return out;
  }

  /** The solid the dialog describes can actually be built. */
  private buildable(): boolean {
    const tool = this.build("check");
    return tool !== null && typeof tool !== "string";
  }

  ok(): void {
    this.update();
    if (this.sketchId === null || this.profiles === null) return;
    if (!this.buildable()) return;
    const shape = this.toFace ? {} : this.shapeData();
    const extent = this.toFace && this.target !== null ? { extent: "toFace" as const, toFace: this.target } : this.through ? { extent: "through" as const } : {};
    const sketch = this.sketchId;
    const profiles = this.profiles;
    const hadBodies = (this.ctx.result()?.bodies.length ?? 0) > 0;
    this.close();
    this.ctx.commit((part) => {
      const data = {
        distance: this.through || this.toFace ? (this.editing?.distance ?? "10") : this.distance,
        direction: this.direction,
        operation: this.operation,
      };
      if (this.editing !== null) {
        const f = part.features.find((x) => x.id === this.editing!.id);
        if (f !== undefined && isExtrude(f)) {
          Object.assign(f, data);
          for (const k of ["extent", "toFace", "taper", "lean", "leanToward", "section"] as const) delete f[k];
          Object.assign(f, extent, shape);
        }
        return;
      }
      part.features.push({
        id: nextId(part, "Extrude"),
        type: "extrude",
        sketch,
        profiles,
        ...data,
        ...extent,
        ...shape,
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
    this.ctx.view.setPickMode("none");
    this.ctx.view.setPreview(null);
  }
}
