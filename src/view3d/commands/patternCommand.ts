/**
 * MinimalCAD Web
 * view3d/commands/patternCommand.ts
 *
 * Rectangular Pattern, Circular Pattern and Mirror, each an Inventor-style
 * dialog: Features (click a face of each feature to repeat -- again to drop
 * it), then where the copies go:
 *
 *  - Rectangular: a direction (X / Y / Z), how many, how far apart; and
 *    optionally a second direction.
 *  - Circular: an axis (X / Y / Z through the origin, or a round face's own
 *    axis), how many in all, and the total angle (360 = evenly all round).
 *  - Mirror: a plane -- click an origin plane, a work plane or a flat face.
 *
 * Live preview of every copy (blue; red if they are cuts).
 */

import type { PatternAxis, PatternFeature } from "../../part/types";
import { nextId } from "../../part/types";
import { patternTools, patternTransforms } from "../../part/pattern";
import { planeFrame } from "../../part/plane";
import { isBasePlane } from "../../part/types";
import type { TopoRef } from "../../part/kernel/types";
import type { Hit } from "../modelView";
import { FeatureDialog } from "../featureDialog";
import type { ChoiceHandle, SelectionHandle } from "../featureDialog";
import type { ModelCommand, ModelContext } from "./context";
import { showToast } from "../../ui/toast";

type Kind = PatternFeature["kind"];
type AxisChoice = PatternAxis | "face";
type Rows = { setVisible(v: boolean): void };

const TITLE: Record<Kind, string> = { rect: "Rectangular Pattern", circular: "Circular Pattern", mirror: "Mirror" };
const ID_PREFIX: Record<Kind, string> = { rect: "Pattern", circular: "CircPattern", mirror: "Mirror" };

export class PatternCommand implements ModelCommand {
  private dialog: FeatureDialog;
  private features: string[] = [];
  private v = { count1: "3", spacing1: "20", count2: "2", spacing2: "20", angle: "360" };
  private dir1: PatternAxis;
  private dir2: PatternAxis | "none" = "none";
  private axis: AxisChoice = "Z";
  private axisFace: TopoRef | null = null;
  private plane: string | null = null;
  private planeFace: TopoRef | null = null;
  /** What the next click in the view is for. */
  private stage: "features" | "ref" = "features";
  private featuresSel: SelectionHandle;
  private refSel: SelectionHandle | null = null;
  private refRows: Rows | null = null;
  private dir2Rows: Rows | null = null;
  private axisChoice: ChoiceHandle<AxisChoice> | null = null;

  static start(ctx: ModelContext, kind: Kind, editing: PatternFeature | null): PatternCommand | null {
    if (editing === null && (ctx.result()?.made.size ?? 0) === 0) {
      showToast("Make a feature first - a pattern repeats features of the solid.");
      return null;
    }
    return new PatternCommand(ctx, editing?.kind ?? kind, editing);
  }

  private constructor(
    private ctx: ModelContext,
    private kind: Kind,
    private editing: PatternFeature | null,
  ) {
    this.dir1 = kind === "circular" ? "Z" : "X";
    if (editing !== null) {
      this.features = editing.features.slice();
      this.dir1 = editing.dir1 ?? this.dir1;
      this.dir2 = editing.dir2 ?? "none";
      this.axis = editing.axisFace !== undefined ? "face" : (editing.dir1 ?? "Z");
      this.axisFace = editing.axisFace ?? null;
      this.plane = editing.plane ?? null;
      this.planeFace = editing.planeFace ?? null;
      this.v = {
        count1: editing.count1 ?? this.v.count1,
        spacing1: editing.spacing1 ?? this.v.spacing1,
        count2: editing.count2 ?? this.v.count2,
        spacing2: editing.spacing2 ?? this.v.spacing2,
        angle: editing.angle ?? this.v.angle,
      };
    } else if (kind === "circular") this.v.count1 = "6";

    const d = (this.dialog = new FeatureDialog(ctx.dialogParent, editing === null ? TITLE[kind] : `Edit ${editing.id}`, {
      onOk: () => this.ok(),
      onCancel: () => this.cancel(),
    }));
    this.featuresSel = d.selection("Features", "", false, () => this.setStage("features"));
    const set = (key: keyof PatternCommand["v"]) => (t: string): void => {
      this.v[key] = t;
      this.update();
    };
    const axes = (["X", "Y", "Z"] as const).map((a) => ({ value: a, label: a, title: `Along / about the ${a} axis` }));

    if (kind === "rect") {
      d.choice<PatternAxis>("Direction", axes, this.dir1, (a) => {
        this.dir1 = a;
        this.update();
      });
      d.number("Count", "", this.v.count1, set("count1"));
      d.number("Spacing", "mm", this.v.spacing1, set("spacing1"));
      d.choice<PatternAxis | "none">("Direction 2", [{ value: "none", label: "None", title: "One row only" }, ...axes], this.dir2, (a) => {
        this.dir2 = a;
        this.update();
      });
      this.dir2Rows = d.rowGroup(() => {
        d.number("Count 2", "", this.v.count2, set("count2"));
        d.number("Spacing 2", "mm", this.v.spacing2, set("spacing2"));
      });
      d.hint("Count includes the original. A minus spacing goes the other way.");
    } else if (kind === "circular") {
      this.axisChoice = d.choice<AxisChoice>("Axis", [...axes, { value: "face", label: "Round face", title: "About the axis of a round face you click" }], this.axis, (a) => {
        this.axis = a;
        this.setStage(a === "face" && this.axisFace === null ? "ref" : "features");
        this.update();
      });
      this.refRows = d.rowGroup(() => (this.refSel = d.selection("Round face", "", false, () => this.setStage("ref"))));
      d.number("Count", "", this.v.count1, set("count1"));
      d.number("Angle", "°", this.v.angle, set("angle"));
      d.hint("Count is how many in all. 360 spaces them evenly all round; a smaller angle ends on it.");
    } else {
      this.refSel = d.selection("Plane", "", false, () => this.setStage("ref"));
      d.hint("Click an origin plane, a work plane, or a flat face to mirror in.");
    }

    ctx.view.setOriginPlanesVisible(false);
    this.setStage(this.features.length > 0 && kind === "mirror" && this.plane === null && this.planeFace === null ? "ref" : "features");
    this.update();
    d.focusFirst();
  }

  private setStage(stage: "features" | "ref"): void {
    this.stage = stage;
    const view = this.ctx.view;
    const name = TITLE[this.kind].toUpperCase();
    if (stage === "features") {
      view.setOriginPlanesVisible(false);
      view.setEdgePickMode([]); // faces of any kind
      this.ctx.status(name, "Click a face of each feature to repeat - or its row in the Model tree (again to drop it)");
    } else if (this.kind === "mirror") {
      view.setOriginPlanesVisible(true);
      view.setPickMode("plane");
      this.ctx.status(name, "Click the plane to mirror in - an origin plane, a work plane, or a flat face");
    } else {
      view.setEdgePickMode([]);
      this.ctx.status(name, "Click the round face to turn about");
    }
    this.featuresSel.setActive(stage === "features");
    this.refSel?.setActive(stage === "ref");
  }

  /** Features that can be repeated here: built ones, before this pattern. */
  private allowed(id: string): boolean {
    const r = this.ctx.result();
    if (r === null || !r.made.has(id)) return false;
    if (this.editing === null) return true;
    const order = this.ctx.part().features.map((f) => f.id);
    return order.indexOf(id) < order.indexOf(this.editing.id);
  }

  /** A feature can also be picked by its row in the Model tree (a small
   *  hole's wall is hard to click). */
  onTreePick(id: string): boolean {
    if (!this.ctx.part().features.some((f) => f.id === id)) return false;
    this.toggleFeature(id);
    this.update();
    return true;
  }

  private toggleFeature(id: string): void {
    if (!this.allowed(id)) {
      this.dialog.setError(`${id} can't be repeated here (fillets and chamfers can't; nor can features made after this one)`);
      return;
    }
    this.features = this.features.includes(id) ? this.features.filter((x) => x !== id) : [...this.features, id];
    // Mirror: with something to mirror, the next click is the plane.
    if (this.kind === "mirror" && this.features.length > 0 && this.plane === null && this.planeFace === null) this.setStage("ref");
  }

  onPick(hit: Hit): void {
    if (this.stage === "features") {
      if (hit.kind !== "face") return;
      this.toggleFeature(hit.ref.feature);
    } else if (this.kind === "mirror") {
      if (hit.kind === "plane") {
        this.plane = hit.key;
        this.planeFace = null;
      } else if (hit.kind === "face") {
        this.planeFace = hit.ref;
        this.plane = null;
      } else return;
      this.setStage("features");
    } else {
      if (hit.kind !== "face") return;
      const kind = hit.body.faces[hit.faceId]?.geom.kind;
      if (kind !== "cylinder" && kind !== "cone") {
        this.dialog.setError("That face is not round - click a round face (its axis is the pattern's axis)");
        return;
      }
      this.axisFace = hit.ref;
      this.setStage("features");
    }
    this.update();
  }

  private feature(): PatternFeature {
    const f: PatternFeature = { id: this.editing?.id ?? "PatternPreview", type: "pattern", kind: this.kind, features: this.features.slice() };
    if (this.kind === "rect") {
      Object.assign(f, { dir1: this.dir1, count1: this.v.count1, spacing1: this.v.spacing1 });
      if (this.dir2 !== "none") Object.assign(f, { dir2: this.dir2, count2: this.v.count2, spacing2: this.v.spacing2 });
    } else if (this.kind === "circular") {
      Object.assign(f, { count1: this.v.count1, angle: this.v.angle });
      if (this.axis === "face") {
        if (this.axisFace !== null) f.axisFace = this.axisFace;
      } else f.dir1 = this.axis;
    } else if (this.planeFace !== null) f.planeFace = this.planeFace;
    else if (this.plane !== null) f.plane = this.plane;
    return f;
  }

  /** The copies' tool solids, or why there are none. */
  private tools(): ReturnType<typeof patternTools> | string {
    const r = this.ctx.result();
    if (r === null) return "Nothing built yet";
    if (this.features.length === 0) return "Click a face of the feature to repeat";
    if (this.kind === "circular" && this.axis === "face" && this.axisFace === null) return "Click the round face to turn about";
    const f = this.feature();
    const transforms = patternTransforms(f, {
      params: this.ctx.params(),
      bodies: r.bodies,
      plane: (key) => (isBasePlane(key) ? planeFrame({ base: key, offset: 0 }) : (r.planes.get(key)?.frame ?? null)),
    });
    if (typeof transforms === "string") return transforms;
    const sources = this.features.flatMap((id) => r.made.get(id) ?? []);
    return sources.length === 0 ? "Those features have nothing to repeat" : patternTools(f, sources, transforms);
  }

  private update(): void {
    this.dir2Rows?.setVisible(this.dir2 !== "none");
    this.refRows?.setVisible(this.axis === "face");
    this.axisChoice?.set(this.axis);
    const n = this.features.length;
    this.featuresSel.set(n === 0 ? "Click a feature (face or tree row)" : this.features.join(", "), n > 0);
    if (this.kind === "mirror") {
      this.refSel?.set(this.planeFace !== null ? `Face of ${this.planeFace.feature}` : (this.plane ?? "Click a plane or a flat face"), this.plane !== null || this.planeFace !== null);
    } else this.refSel?.set(this.axisFace === null ? "Click a round face" : `Face of ${this.axisFace.feature}`, this.axisFace !== null);

    const tools = this.tools();
    this.dialog.setError(typeof tools === "string" ? tools : null);
    if (typeof tools === "string") this.ctx.view.setPreview(null);
    else {
      this.ctx.view.setPreview(
        tools.map((t) => t.tool),
        tools.length > 0 && tools.every((t) => t.op === "cut"),
      );
    }
  }

  ok(): void {
    this.update();
    if (typeof this.tools() === "string") return;
    const f = this.feature();
    this.close();
    this.ctx.commit((part) => {
      if (this.editing !== null) {
        const i = part.features.findIndex((x) => x.id === this.editing!.id);
        if (i >= 0) part.features[i] = { ...f, id: this.editing.id };
        return;
      }
      part.features.push({ ...f, id: nextId(part, ID_PREFIX[this.kind]) });
    });
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
