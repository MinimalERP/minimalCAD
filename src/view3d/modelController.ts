/**
 * MinimalCAD Web
 * view3d/modelController.ts
 *
 * The 3D workspace: model browser (feature tree), 3D commands (New Sketch,
 * Work Plane, Extrude), and the Parametric Model -> rebuild -> ModelView
 * pipeline.
 *
 * AutoCAD-style single model space: the tab's 2D drafting drawing IS the XY
 * ground plane, so whatever was drawn in 2D is visible here and extrudable
 * directly (linked -- editing it in 2D rebuilds the solid). Other planes
 * (XZ, YZ, work planes) get their own sketches.
 *
 * The parametric model lives in the tab's Document.part (plain JSON), so
 * save/open/undo/autosave all work on it unchanged: every edit here is
 * "push undo snapshot, mutate part, rebuild". Loaded lazily (dynamic import
 * from workspace/workspace.ts) together with three.js.
 */

import type { CommandBar } from "../ui/commandBar";
import type { Engine } from "../engine/engine";
import type { ModelAction } from "../ui/toolbar";
import { showToast } from "../ui/toast";
import { parseEntities } from "../core/document";
import type { ExtrudeDirection, ExtrudeFeature, PartData, PlaneRef, WorkPlane } from "../part/types";
import { DRAWING_SKETCH, emptyPart, isBasePlane, nextId, parsePart } from "../part/types";
import { extrudeExtent, rebuild, resolvePlane, selectRegions } from "../part/rebuild";
import { projectBodies } from "../part/project";
import type { Entity } from "../entities/entity";
import { axisName } from "../part/plane";
import type { RebuildResult } from "../part/rebuild";
import { evalExpression } from "../part/params";
import { workPlaneFrame } from "../part/plane";
import type { Frame } from "../part/plane";
import type { Point } from "../core/types";
import { extrudeRegions } from "../part/kernel/extrude";
import { entityPolylines, regionContains, regionSeed } from "../part/profile";
import { toLocal } from "../part/plane";
import { ModelView } from "./modelView";
import type { PickableRegion } from "./modelView";

export interface ModelHost {
  commandBar: CommandBar;
  /** The tab's own Engine (owner of the 2D drawing, Document.part, undo). */
  getEngine(): Engine;
  /** Edit the 2D drawing (XY base) -- i.e. switch to the 2D workspace. */
  enterDrawing(): void;
  enterSketch(sketchId: string, plane: PlaneRef): void;
}

/** What a 2D sketch view shows besides its own entities. */
export interface SketchReference {
  /** Solids projected onto the plane: dim, snappable, never saved. */
  underlay: Entity[];
  /** UCS icon axis names (screen right, screen up). */
  labels: [string, string];
}

type WorkPlaneDraft = Pick<WorkPlane, "base" | "axis"> & { offset: string; angle: string; editing: string | null };

type State =
  | { kind: "idle" }
  | { kind: "pickPlane" }
  | { kind: "wpBase"; editing: string | null }
  | { kind: "wpOffset"; draft: WorkPlaneDraft }
  | { kind: "wpAngle"; draft: WorkPlaneDraft }
  | { kind: "pickProfile"; candidates: PickableRegion[]; chosen: PickableRegion[] }
  | {
      kind: "distance";
      sketchId: string;
      profiles: ExtrudeFeature["profiles"];
      direction: ExtrudeDirection;
      /** Set when editing an existing feature rather than creating one. */
      editing: string | null;
    };

const DIRECTION_LABEL: Record<ExtrudeDirection, string> = {
  normal: "one side",
  reverse: "flipped",
  symmetric: "symmetric",
};

export class ModelController {
  private view: ModelView;
  private state: State = { kind: "idle" };
  private lastBuiltKey = "";
  private result: RebuildResult | null = null;
  private selectedNode: string | null = null;
  private firstShow = true;

  constructor(
    canvas: HTMLCanvasElement,
    private browserEl: HTMLElement,
    private host: ModelHost,
  ) {
    this.view = new ModelView(canvas);
    this.view.onPick = (hit) => {
      if (hit.kind === "plane" && this.state.kind === "pickPlane") this.pickSketchPlane(hit.key);
      else if (hit.kind === "face" && this.state.kind === "pickPlane") {
        this.cancel();
        this.host.enterSketch(nextId(this.part(), "Sketch"), { base: "face", offset: 0, face: hit.ref });
      }
      else if (hit.kind === "plane" && this.state.kind === "wpBase" && isBasePlane(hit.key)) this.wpPickBase(hit.key);
      else if (hit.kind === "region" && this.state.kind === "pickProfile") this.toggleRegion(hit.region);
    };
    this.view.onPlaneDoubleClick = (key) => {
      if (this.state.kind === "idle") this.pickSketchPlane(key);
    };
    host.commandBar.addEventListener("textChanged", () => this.onLiveText(host.commandBar.text()));
    canvas.addEventListener("keydown", (e) => this.onKeyDown(e));
    canvas.addEventListener("pointerdown", () => canvas.focus());
  }

  // --- lifecycle ---

  show(): void {
    this.view.resize();
    this.refresh(true);
    if (this.firstShow) {
      this.firstShow = false;
      this.view.setView("iso");
    } else {
      this.view.fitIfNeeded();
    }
    this.host.commandBar.setReady();
    this.view.canvas.focus();
  }

  hide(): void {
    this.cancel();
  }

  private part(): PartData {
    return parsePart(this.host.getEngine().document.part) ?? emptyPart();
  }

  private drawingEntities(): Record<string, unknown>[] {
    return this.host.getEngine().document.entities.map((e) => e.serialize());
  }

  /** Rebuilds if the part or the 2D drawing changed since the last build
   *  (cheap no-op otherwise) -- called after undo/redo/open, 2D edits, etc. */
  refresh(force = false): void {
    const doc = this.host.getEngine().document;
    const entities = this.drawingEntities();
    const key = JSON.stringify([doc.part ?? null, entities]);
    if (!force && key === this.lastBuiltKey) return;
    this.lastBuiltKey = key;
    const part = this.part();
    this.result = rebuild(part, entities);
    this.view.setBodies(this.result.bodies);
    this.showWireframes(part);
    this.view.setWorkPlanes(
      [...this.result.planes.values()].flatMap((p) => (p.frame === null ? [] : [{ key: p.id, frame: p.frame }])),
    );
    this.view.updateOriginScale();
    this.renderBrowser(part);
  }

  /** The 2D drawing is always shown on the XY ground (it IS the model
   *  space); other sketches only until a feature consumes them. */
  private showWireframes(part: PartData, alsoShow: ReadonlySet<string> = new Set()): void {
    const used = new Set(part.features.map((f) => f.sketch));
    const list: { frame: Frame; polylines: Point[][] }[] = [];
    const drawing = this.result?.sketches.get(DRAWING_SKETCH);
    if (drawing !== undefined) {
      list.push({ frame: drawing.frame, polylines: entityPolylines(this.host.getEngine().document.entities) });
    }
    for (const s of part.sketches) {
      if (used.has(s.id) && !alsoShow.has(s.id)) continue;
      const geo = this.result?.sketches.get(s.id);
      if (geo === undefined) continue;
      list.push({ frame: geo.frame, polylines: entityPolylines(parseEntities(s.entities).entities) });
    }
    this.view.setSketches(list);
  }

  /** Projected solids + UCS labels for a sketch on `plane` (see SketchReference). */
  referenceFor(plane: PlaneRef): SketchReference {
    this.refresh();
    const r = this.result;
    const frame = r === null ? null : resolvePlane(plane, r.planes, r.bodies);
    if (r === null || frame === null) return { underlay: [], labels: ["X", "Y"] };
    return {
      underlay: projectBodies(r.bodies, frame),
      labels: [axisName(frame.u) || "u", axisName(frame.v) || "v"],
    };
  }

  private commit(mutate: (part: PartData) => void): void {
    const engine = this.host.getEngine();
    engine.undo.push(engine.document.toDict());
    const part = this.part();
    mutate(part);
    engine.document.part = part;
    this.refresh();
  }

  // --- toolbar / command bar entry points ---

  action(action: ModelAction): void {
    switch (action) {
      case "newsketch":
        return this.startNewSketch();
      case "workplane":
        return this.startWorkPlane(null);
      case "extrude":
        return this.startExtrude();
      case "viewfront":
        return this.view.setView("front");
      case "viewtop":
        return this.view.setView("top");
      case "viewright":
        return this.view.setView("right");
      case "viewiso":
        return this.view.setView("iso");
      case "fit":
        return this.view.fit();
    }
  }

  textInput(text: string): void {
    const t = text.trim();
    const upper = t.toUpperCase();
    switch (this.state.kind) {
      case "pickPlane":
        if (upper === "XY" || upper === "XZ" || upper === "YZ") this.pickSketchPlane(upper);
        else if (this.part().planes.some((p) => p.id.toUpperCase() === upper)) {
          this.pickSketchPlane(this.part().planes.find((p) => p.id.toUpperCase() === upper)!.id);
        } else this.prompt("NEW SKETCH", "Type XY, XZ, YZ or a work plane name, or click a plane");
        return;
      case "wpBase":
        if (upper === "XY" || upper === "XZ" || upper === "YZ") this.wpPickBase(upper);
        else this.prompt("WORK PLANE", "Type XY, XZ or YZ, or click an origin plane");
        return;
      case "wpOffset":
        return this.wpAcceptOffset(t);
      case "wpAngle":
        return this.wpAcceptAngle(t);
      case "pickProfile":
        return this.acceptProfiles();
      case "distance":
        return this.acceptDistance(t);
      case "idle": {
        const cmd = t.toLowerCase();
        if (["e", "ext", "extrude"].includes(cmd)) this.startExtrude();
        else if (["s", "sk", "sketch"].includes(cmd)) this.startNewSketch();
        else if (["wp", "plane", "workplane", "ucs"].includes(cmd)) this.startWorkPlane(null);
        return;
      }
    }
  }

  escape(): void {
    this.cancel();
  }

  private prompt(command: string, text: string, value?: string): void {
    this.host.commandBar.setStatus(command, text);
    this.host.commandBar.enableInput("text");
    if (value !== undefined) this.host.commandBar.setValue(value);
  }

  private cancel(): void {
    this.state = { kind: "idle" };
    this.view.setPickMode("none");
    this.view.setPreview(null);
    this.view.setPlanePreview(null);
    this.view.setOriginPlanesVisible(true);
    this.host.commandBar.setReady();
    this.showWireframes(this.part());
  }

  private onLiveText(text: string): void {
    if (this.state.kind === "distance") this.updateExtrudePreview(text);
    else if (this.state.kind === "wpOffset") this.updatePlanePreview({ ...this.state.draft, offset: text });
    else if (this.state.kind === "wpAngle") this.updatePlanePreview({ ...this.state.draft, angle: text });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.cancel();
    } else if (e.key === "Enter") {
      if (this.state.kind === "pickProfile") this.acceptProfiles();
    } else if (e.key === "Delete") {
      if (this.selectedNode !== null) this.deleteNode(this.selectedNode);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Same as 2D: typing starts command-bar entry.
      this.host.commandBar.enableInput("text");
      this.host.commandBar.setValue(e.key);
      e.preventDefault();
    }
  }

  private params(): ReadonlyMap<string, number> {
    return this.result?.params ?? new Map<string, number>();
  }

  // --- New Sketch ---

  private startNewSketch(): void {
    this.cancel();
    this.state = { kind: "pickPlane" };
    this.view.setOriginPlanesVisible(true);
    this.view.setPickMode("plane");
    this.prompt("NEW SKETCH", "Click a plane or a flat face of the solid (XY = the 2D drawing), or type XY / XZ / YZ");
  }

  private pickSketchPlane(key: string): void {
    this.cancel();
    if (key === "XY") {
      // The XY plane is the 2D drawing itself.
      this.host.enterDrawing();
      return;
    }
    this.host.enterSketch(nextId(this.part(), "Sketch"), { base: key, offset: 0 });
  }

  // --- Work Plane (a saved, parametric UCS) ---

  private startWorkPlane(editing: string | null): void {
    this.cancel();
    if (editing !== null) {
      const wp = this.part().planes.find((p) => p.id === editing);
      if (wp === undefined) return;
      const draft: WorkPlaneDraft = { ...wp, editing };
      this.state = { kind: "wpOffset", draft };
      this.promptOffset(draft);
      return;
    }
    this.state = { kind: "wpBase", editing: null };
    this.view.setOriginPlanesVisible(true);
    this.view.setPickMode("plane");
    this.prompt("WORK PLANE", "Click the origin plane to start from, or type XY / XZ / YZ");
  }

  private wpPickBase(base: "XY" | "XZ" | "YZ"): void {
    this.view.setPickMode("none");
    this.view.setOriginPlanesVisible(true);
    const draft: WorkPlaneDraft = { base, axis: "u", offset: "0", angle: "0", editing: null };
    this.state = { kind: "wpOffset", draft };
    this.promptOffset(draft);
  }

  private promptOffset(draft: WorkPlaneDraft): void {
    this.prompt("WORK PLANE", `Offset from ${draft.base} (mm) - Enter to accept`, draft.offset);
    this.updatePlanePreview(draft);
  }

  private wpAcceptOffset(text: string): void {
    if (this.state.kind !== "wpOffset") return;
    if (evalExpression(text, this.params()) === null) {
      this.prompt("WORK PLANE", `Invalid offset "${text}" - enter a distance`);
      return;
    }
    const draft = { ...this.state.draft, offset: text };
    this.state = { kind: "wpAngle", draft };
    this.promptAngle(draft);
  }

  private promptAngle(draft: WorkPlaneDraft): void {
    const axisName = axisLabel(draft);
    this.prompt("WORK PLANE", `Rotate about ${axisName} axis (degrees) - A to switch axis, Enter to accept`, draft.angle);
    this.updatePlanePreview(draft);
  }

  private wpAcceptAngle(text: string): void {
    if (this.state.kind !== "wpAngle") return;
    const s = this.state;
    if (text.toLowerCase() === "a") {
      s.draft = { ...s.draft, axis: s.draft.axis === "u" ? "v" : "u" };
      this.promptAngle(s.draft);
      return;
    }
    if (evalExpression(text, this.params()) === null) {
      this.prompt("WORK PLANE", `Invalid angle "${text}" - enter degrees`);
      return;
    }
    const draft = { ...s.draft, angle: text };
    this.view.setPlanePreview(null);
    this.state = { kind: "idle" };
    this.commit((part) => {
      const existing = part.planes.find((p) => p.id === draft.editing);
      const data = { base: draft.base, axis: draft.axis, offset: draft.offset, angle: draft.angle };
      if (existing !== undefined) Object.assign(existing, data);
      else part.planes.push({ id: nextId(part, "WorkPlane"), ...data });
    });
    this.host.commandBar.setReady();
  }

  private updatePlanePreview(draft: WorkPlaneDraft): void {
    const offset = evalExpression(draft.offset, this.params());
    const angle = evalExpression(draft.angle, this.params());
    this.view.setPlanePreview(offset === null || angle === null ? null : workPlaneFrame(draft, offset, angle));
  }

  // --- Extrude ---

  /** Regions already extruded by some feature (so the next Extrude offers the new ones first). */
  private consumed(part: PartData, sketchId: string, region: PickableRegion["region"]): boolean {
    return part.features.some(
      (f) =>
        f.sketch === sketchId &&
        (f.profiles === "all" || f.profiles.some((seed) => regionContains(region, toLocal(seed)))),
    );
  }

  private startExtrude(): void {
    this.cancel();
    const part = this.part();
    if (this.result === null) this.refresh(true);
    const all: PickableRegion[] = [];
    const add = (sketchId: string): void => {
      const geo = this.result!.sketches.get(sketchId);
      geo?.profiles.regions.forEach((region, index) => all.push({ sketchId, index, region, frame: geo.frame }));
    };
    add(DRAWING_SKETCH);
    for (const sketch of part.sketches) add(sketch.id);
    if (all.length === 0) {
      showToast("Nothing to extrude - draw a closed shape in 2D first (rectangle, circle, closed polyline...).");
      return;
    }
    // Prefer shapes not extruded yet; fall back to everything.
    const fresh = all.filter((r) => !this.consumed(part, r.sketchId, r.region));
    const candidates = fresh.length > 0 ? fresh : all;
    if (candidates.length === 1) {
      this.state = {
        kind: "distance",
        sketchId: candidates[0]!.sketchId,
        profiles: this.profilesFor([candidates[0]!], candidates),
        direction: "normal",
        editing: null,
      };
      this.promptDistance();
      return;
    }
    this.state = { kind: "pickProfile", candidates, chosen: [] };
    this.showWireframes(part, new Set(candidates.map((c) => c.sketchId)));
    this.view.setPickMode("region", candidates);
    this.prompt("EXTRUDE", "Click the closed shape(s) to extrude, then Enter");
  }

  /** How a feature records its chosen regions. The 2D drawing keeps growing,
   *  so its picks are always seeds; a dedicated sketch with every region
   *  chosen is simply "all". */
  private profilesFor(chosen: PickableRegion[], candidates: PickableRegion[]): ExtrudeFeature["profiles"] {
    const sketchId = chosen[0]!.sketchId;
    const total = candidates.filter((c) => c.sketchId === sketchId).length;
    const allOfSketch = this.result?.sketches.get(sketchId)?.profiles.regions.length ?? 0;
    if (sketchId !== DRAWING_SKETCH && chosen.length === total && total === allOfSketch) return "all";
    return chosen.map((c) => regionSeed(c.region));
  }

  private toggleRegion(region: PickableRegion): void {
    if (this.state.kind !== "pickProfile") return;
    let chosen = this.state.chosen;
    // One feature extrudes profiles from one sketch.
    if (chosen.length > 0 && chosen[0]!.sketchId !== region.sketchId) chosen = [];
    chosen = chosen.includes(region) ? chosen.filter((r) => r !== region) : [...chosen, region];
    this.state.chosen = chosen;
    this.view.setSelectedRegions(chosen);
    this.prompt("EXTRUDE", `${chosen.length} shape(s) selected - click more, or Enter to continue`);
  }

  private acceptProfiles(): void {
    if (this.state.kind !== "pickProfile") return;
    const { chosen, candidates } = this.state;
    if (chosen.length === 0) {
      this.prompt("EXTRUDE", "Select at least one shape (click inside it)");
      return;
    }
    this.view.setPickMode("none");
    this.state = {
      kind: "distance",
      sketchId: chosen[0]!.sketchId,
      profiles: this.profilesFor(chosen, candidates),
      direction: "normal",
      editing: null,
    };
    this.promptDistance();
  }

  private promptDistance(): void {
    if (this.state.kind !== "distance") return;
    const s = this.state;
    const existing = s.editing !== null ? this.part().features.find((f) => f.id === s.editing)?.distance : undefined;
    const current = this.host.commandBar.text();
    const value = current !== "" && !/^[fs]$/i.test(current) ? current : (existing ?? "10");
    this.prompt("EXTRUDE", `Height (${DIRECTION_LABEL[s.direction]}) - Enter to accept | F flip | S symmetric`, value);
    this.updateExtrudePreview(value);
  }

  private acceptDistance(t: string): void {
    if (this.state.kind !== "distance") return;
    const s = this.state;
    const lower = t.toLowerCase();
    if (lower === "f") {
      s.direction = s.direction === "normal" ? "reverse" : "normal";
      this.promptDistance();
      return;
    }
    if (lower === "s") {
      s.direction = s.direction === "symmetric" ? "normal" : "symmetric";
      this.promptDistance();
      return;
    }
    const value = evalExpression(t, this.params());
    if (value === null || !(value > 0)) {
      this.prompt("EXTRUDE", `Invalid height "${t}" - enter a positive value`);
      return;
    }
    this.state = { kind: "idle" };
    this.view.setPreview(null);
    const hadBodies = (this.result?.bodies.length ?? 0) > 0;
    this.commit((part) => {
      if (s.editing !== null) {
        const f = part.features.find((x) => x.id === s.editing);
        if (f !== undefined) {
          f.distance = t;
          f.direction = s.direction;
        }
        return;
      }
      part.features.push({
        id: nextId(part, "Extrude"),
        type: "extrude",
        sketch: s.sketchId,
        profiles: s.profiles,
        distance: t,
        direction: s.direction,
        operation: "new",
      });
    });
    this.host.commandBar.setReady();
    if (!hadBodies) this.view.fit();
  }

  private updateExtrudePreview(text: string): void {
    if (this.state.kind !== "distance") return;
    const s = this.state;
    const distance = evalExpression(text, this.params());
    const geo = this.result?.sketches.get(s.sketchId);
    if (distance === null || !(distance > 0) || geo === undefined) {
      this.view.setPreview(null);
      return;
    }
    const regions = selectRegions(geo.profiles.regions, s.profiles);
    const [h0, h1] = extrudeExtent(s.direction, distance);
    this.view.setPreview(regions.length > 0 ? extrudeRegions("preview", regions, geo.frame, h0, h1) : null);
  }

  private editFeature(id: string): void {
    const f = this.part().features.find((x) => x.id === id);
    if (f === undefined) return;
    this.cancel();
    this.state = { kind: "distance", sketchId: f.sketch, profiles: f.profiles, direction: f.direction, editing: id };
    this.promptDistance();
  }

  // --- model browser ---

  private deleteNode(id: string): void {
    const part = this.part();
    if (id === DRAWING_SKETCH) return;
    if (part.features.some((f) => f.sketch === id)) {
      showToast(`${id} is used by a feature - delete the feature first.`);
      return;
    }
    if (part.sketches.some((s) => s.plane.base === id)) {
      showToast(`${id} has sketches on it - delete them first.`);
      return;
    }
    const exists = [...part.planes, ...part.sketches, ...part.features].some((x) => x.id === id);
    if (!exists) return;
    this.selectedNode = null;
    this.commit((p) => {
      p.planes = p.planes.filter((x) => x.id !== id);
      p.sketches = p.sketches.filter((s) => s.id !== id);
      p.features = p.features.filter((f) => f.id !== id);
    });
  }

  private renderBrowser(part: PartData): void {
    const el = this.browserEl;
    el.innerHTML = "";
    const title = document.createElement("div");
    title.className = "mb-title";
    title.textContent = "Model";
    el.appendChild(title);

    const row = (
      id: string,
      label: string,
      detail: string,
      icon: string,
      onOpen: () => void,
      opts: { error?: string; indent?: boolean; hint?: string } = {},
    ): void => {
      const r = document.createElement("div");
      r.className = "mb-row";
      if (opts.indent === true) r.classList.add("indent");
      if (id === this.selectedNode) r.classList.add("selected");
      if (opts.error !== undefined) {
        r.classList.add("error");
        r.title = opts.error;
      } else {
        r.title = opts.hint ?? "Double-click to edit, Delete to remove";
      }
      const i = document.createElement("span");
      i.className = "mb-icon";
      i.textContent = icon;
      const name = document.createElement("span");
      name.className = "mb-name";
      name.textContent = label;
      const d = document.createElement("span");
      d.className = "mb-detail";
      d.textContent = detail;
      r.append(i, name, d);
      r.addEventListener("click", () => {
        this.selectedNode = id;
        this.renderBrowser(this.part());
        this.view.canvas.focus();
      });
      r.addEventListener("dblclick", onOpen);
      el.appendChild(r);
    };

    const regionCount = (sketchId: string): string => {
      const n = this.result?.sketches.get(sketchId)?.profiles.regions.length ?? 0;
      return `${n} closed shape${n === 1 ? "" : "s"}`;
    };
    const featureRows = (sketchId: string): void => {
      for (const f of part.features) {
        if (f.sketch !== sketchId) continue;
        const st = this.result?.status.get(f.id);
        const value = evalExpression(f.distance, this.params());
        const shown = value === null ? f.distance : `${+value.toFixed(3)} mm`;
        row(f.id, f.id, shown, "▣", () => this.editFeature(f.id), {
          indent: true,
          error: st?.ok === false ? st.error : undefined,
        });
      }
    };

    row(DRAWING_SKETCH, "2D Drawing", `XY · ${regionCount(DRAWING_SKETCH)}`, "✎", () => this.host.enterDrawing(), {
      hint: "The 2D drafting drawing (XY plane). Double-click to edit it in 2D.",
    });
    featureRows(DRAWING_SKETCH);

    for (const wp of part.planes) {
      const g = this.result?.planes.get(wp.id);
      const off = evalExpression(wp.offset, this.params());
      const ang = evalExpression(wp.angle, this.params());
      const detail = `${wp.base} ${off ?? wp.offset} mm${ang !== null && ang !== 0 ? `, ${ang}° about ${axisLabel(wp)}` : ""}`;
      row(wp.id, wp.id, detail, "◇", () => this.startWorkPlane(wp.id), { error: g?.error });
    }
    for (const sketch of part.sketches) {
      row(sketch.id, sketch.id, `${planeLabel(sketch.plane)} · ${regionCount(sketch.id)}`, "✎", () => {
        this.cancel();
        this.host.enterSketch(sketch.id, sketch.plane);
      });
      featureRows(sketch.id);
    }
  }
}

/** Short description of where a sketch lives. */
export function planeLabel(plane: PlaneRef): string {
  return plane.base === "face" && plane.face !== undefined ? `face of ${plane.face.feature}` : plane.base;
}

/** Human axis name for a work plane's rotation axis (its u or v direction). */
function axisLabel(wp: Pick<WorkPlane, "base" | "axis">): string {
  const axes: Record<string, [string, string]> = { XY: ["X", "Y"], XZ: ["X", "Z"], YZ: ["Y", "Z"] };
  const pair = axes[wp.base] ?? ["u", "v"];
  return wp.axis === "u" ? pair[0] : pair[1];
}
