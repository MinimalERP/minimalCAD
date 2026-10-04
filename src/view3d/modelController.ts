/**
 * MinimalCAD Web
 * view3d/modelController.ts
 *
 * The 3D workspace: model browser (feature tree), command dispatch, and the
 * Parametric Model -> rebuild -> ModelView pipeline.
 *
 * AutoCAD-style single model space: the tab's 2D drafting drawing IS the XY
 * ground plane, so whatever was drawn in 2D is visible here and extrudable
 * directly (linked -- editing it in 2D rebuilds the solid). Other planes
 * (XZ, YZ, work planes, faces) get their own sketches.
 *
 * 3D features run as commands (view3d/commands/*) with Inventor-style
 * dialogs; this class only routes view picks and keys to the active one.
 *
 * The parametric model lives in the tab's Document.part (plain JSON), so
 * save/open/undo/autosave all work on it unchanged: every edit is "push undo
 * snapshot, mutate part, rebuild". Loaded lazily with three.js.
 */

import type { CommandBar } from "../ui/commandBar";
import type { Engine } from "../engine/engine";
import type { ModelAction } from "../ui/toolbar";
import { showToast } from "../ui/toast";
import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { HoleFeature, PartData, PlaneRef } from "../part/types";
import { DRAWING_SKETCH, emptyPart, isEdgeFeature, modelPlaneKind, nextId, parsePart, usesSketch } from "../part/types";
import type { ModelPlaneRef } from "../part/types";
import { rebuild, resolvePlane, sheetValues } from "../part/rebuild";
import type { RebuildResult } from "../part/rebuild";
import { projectBodiesWithSources } from "../part/project";
import { modelEdgeRef, modelRefResolver } from "../part/sketchRefs";
import { axisName, offsetFrame } from "../part/plane";
import type { Frame } from "../part/plane";
import { evalExpression } from "../part/params";
import { entityPolylines } from "../part/profile";
import { ModelView } from "./modelView";
import type { ModelCommand, ModelContext } from "./commands/context";
import { ExtrudeCommand } from "./commands/extrudeCommand";
import { RevolveCommand } from "./commands/revolveCommand";
import { PatternCommand } from "./commands/patternCommand";
import { HoleCommand } from "./commands/holeCommand";
import { EdgeBlendCommand } from "./commands/edgeBlendCommand";
import { RotateCommand } from "./commands/rotateCommand";
import { Line3dCommand } from "./commands/line3dCommand";
import { MeasureCommand } from "./commands/measureCommand";
import { SheetMetalCommand } from "./commands/sheetMetalCommand";
import { sheetMaterial } from "../part/sheetMetal";
import { WorkPlaneCommand, planeAxes } from "./commands/workPlaneCommand";

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
  /** Finds the reference geometry a constraint measures from, as the solid
   *  is now (Document.modelRef), and what to remember about an underlay
   *  entity so that works (Engine.modelRefOf) -- see part/sketchRefs.ts. */
  modelRef: (constraint: unknown) => Entity | null;
  modelRefOf: (entity: Entity) => unknown;
}

const OPERATION_LABEL = { new: "New solid", join: "Join", cut: "Cut" } as const;

export class ModelController {
  private view: ModelView;
  private lastBuiltKey = "";
  private result: RebuildResult | null = null;
  private selectedNode: string | null = null;
  private firstShow = true;
  /** The running 3D command (with its dialog), if any. */
  private active: ModelCommand | null = null;
  /** New Sketch is a simple one-click pick (no dialog needed). */
  private pickingSketchPlane = false;
  private ctx: ModelContext;

  constructor(
    canvas: HTMLCanvasElement,
    private browserEl: HTMLElement,
    private host: ModelHost,
  ) {
    this.view = new ModelView(canvas);
    this.ctx = {
      view: this.view,
      dialogParent: canvas.parentElement!,
      part: () => this.part(),
      result: () => this.result,
      params: () => this.params(),
      drawingEntities: () => this.drawingEntities(),
      commit: (mutate) => this.commit(mutate),
      ortho: () => this.host.getEngine().orthoEnabled,
      showWireframes: (alsoShow) => this.showWireframes(this.part(), alsoShow),
      status: (command, text) => this.host.commandBar.setStatus(command, text),
      done: () => this.finishCommand(),
      startCommand: (make) => this.run(make),
    };
    this.view.onPick = (hit) => {
      if (this.active !== null) {
        this.active.onPick?.(hit);
        return;
      }
      if (!this.pickingSketchPlane) return;
      if (hit.kind === "plane") this.pickSketchPlane(hit.key);
      else if (hit.kind === "face") {
        this.cancel();
        this.host.enterSketch(nextId(this.part(), "Sketch"), { base: "face", offset: 0, face: hit.ref });
      }
    };
    this.view.onFacePointHover = (hit) => this.active?.onFacePointHover?.(hit);
    this.view.onSurfaceHover = (hit) => this.active?.onSurfaceHover?.(hit);
    this.view.onPlaneDoubleClick = (key) => {
      if (this.active === null && !this.pickingSketchPlane) this.pickSketchPlane(key);
    };
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

  private params(): ReadonlyMap<string, number> {
    return this.result?.params ?? new Map<string, number>();
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
      [...this.result.planes.values()].flatMap((p) => (p.frame === null ? [] : [{ key: p.id, frame: p.frame, hingeAt: p.hingeAt, centerAt: p.centerAt }])),
    );
    this.view.updateOriginScale();
    this.renderBrowser(part);
  }

  /** The 2D drawing is always shown on the XY ground (it IS the model
   *  space); other sketches only until a feature consumes them. */
  private showWireframes(part: PartData, alsoShow: ReadonlySet<string> = new Set()): void {
    // A sheet shown flat keeps its sketch visible: the bend lines on the blank.
    const used = new Set(part.features.filter(usesSketch).filter((f) => !(f.type === "sheet" && f.flat === true)).map((f) => f.sketch));
    const list: { frame: Frame; polylines: Point[][] }[] = [];
    const drawing = this.result?.sketches.get(DRAWING_SKETCH);
    if (drawing !== undefined) {
      list.push({ frame: drawing.frame, polylines: entityPolylines(this.host.getEngine().document.entities) });
    }
    for (const s of part.sketches) {
      if (used.has(s.id) && !alsoShow.has(s.id)) continue;
      const geo = this.result?.sketches.get(s.id);
      if (geo === undefined) continue;
      list.push({ frame: geo.frame, polylines: entityPolylines(geo.entities) }); // as rebuilt: constraints applied
      // A flat sheet: its bend lines (the whole sketch) on the blank's top face too.
      for (const f of part.features) {
        if (f.type !== "sheet" || f.flat !== true || f.sketch !== s.id) continue;
        const v = sheetValues(f, this.params());
        if (typeof v !== "string") list.push({ frame: offsetFrame(geo.frame, v.thickness), polylines: entityPolylines(geo.entities) });
      }
    }
    this.view.setSketches(list);
  }

  /** Projected solids + UCS labels for a sketch on `plane` (see SketchReference). */
  referenceFor(plane: PlaneRef): SketchReference {
    this.refresh();
    const r = this.result;
    const frame = r === null ? null : resolvePlane(plane, r.planes, r.bodies);
    if (r === null || frame === null) return { underlay: [], labels: ["X", "Y"], modelRef: () => null, modelRefOf: () => undefined };
    const sources = projectBodiesWithSources(r.bodies, frame);
    return {
      underlay: sources.map((s) => s.entity),
      labels: [axisName(frame.u) || "u", axisName(frame.v) || "v"],
      modelRef: modelRefResolver(sources),
      modelRefOf: (entity) => {
        const source = sources.find((s) => s.entity === entity);
        return source === undefined ? undefined : (modelEdgeRef(source) ?? undefined);
      },
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

  // --- commands ---

  action(action: ModelAction): void {
    switch (action) {
      case "newsketch":
        return this.startNewSketch();
      case "workplane":
        return this.run(() => new WorkPlaneCommand(this.ctx, null));
      case "extrude":
        return this.run(() => ExtrudeCommand.start(this.ctx, null));
      case "revolve":
        return this.run(() => RevolveCommand.start(this.ctx, null));
      case "hole":
        return this.run(() => HoleCommand.start(this.ctx, null));
      case "pattern":
        return this.run(() => PatternCommand.start(this.ctx, "rect", null));
      case "circpattern":
        return this.run(() => PatternCommand.start(this.ctx, "circular", null));
      case "mirror3d":
        return this.run(() => PatternCommand.start(this.ctx, "mirror", null));
      case "fillet":
      case "chamfer":
        return this.run(() => EdgeBlendCommand.start(this.ctx, action, null));
      case "rotate3d":
        return this.run(() => RotateCommand.start(this.ctx, null));
      case "sheetmetal":
        return this.run(() => SheetMetalCommand.start(this.ctx, null));
      case "measure":
        return this.run(() => MeasureCommand.start(this.ctx, MeasureCommand.lastMode));
      case "measureangle":
        return this.run(() => MeasureCommand.start(this.ctx, "angle"));
      case "measuredist":
        return this.run(() => MeasureCommand.start(this.ctx, "distance"));
      case "measureedge":
        return this.run(() => MeasureCommand.start(this.ctx, "edge"));
      case "measureface":
        return this.run(() => MeasureCommand.start(this.ctx, "face"));
      case "line3d":
        return this.run(() => new Line3dCommand(this.ctx));
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

  private run(make: () => ModelCommand | null): void {
    this.cancel();
    this.active = make();
  }

  /** Called by a command when it ends (OK or Cancel). */
  private finishCommand(): void {
    this.active = null;
    this.view.setOriginPlanesVisible(true);
    this.host.commandBar.setReady();
    this.showWireframes(this.part());
    this.view.canvas.focus();
  }

  /** Typed text in the command bar while in 3D: command shortcuts only
   *  (3D options live in dialogs). */
  textInput(text: string): void {
    if (this.active?.textInput?.(text) === true) return;
    const t = text.trim().toLowerCase();
    if (this.pickingSketchPlane) {
      const upper = t.toUpperCase();
      const wp = this.part().planes.find((p) => p.id.toUpperCase() === upper);
      if (upper === "XY" || upper === "XZ" || upper === "YZ") this.pickSketchPlane(upper);
      else if (wp !== undefined) this.pickSketchPlane(wp.id);
      return;
    }
    if (["e", "ext", "extrude"].includes(t)) this.action("extrude");
    else if (["r", "rev", "revolve"].includes(t)) this.action("revolve");
    else if (["h", "hole"].includes(t)) this.action("hole");
    else if (["pat", "pattern"].includes(t)) this.action("pattern");
    else if (["cpat", "circular"].includes(t)) this.action("circpattern");
    else if (["mir", "mirror"].includes(t)) this.action("mirror3d");
    else if (["f", "fillet"].includes(t)) this.action("fillet");
    else if (["ro", "rot", "rotate"].includes(t)) this.action("rotate3d");
    else if (["l3", "l", "line", "3dline", "line3d"].includes(t)) this.action("line3d");
    else if (["mea", "measure", "ma", "ang", "angle"].includes(t)) this.action("measureangle");
    else if (["di", "dist", "distance"].includes(t)) this.action("measuredist");
    else if (["sm", "sheet", "sheetmetal"].includes(t)) this.action("sheetmetal");
    else if (["ch", "cha", "chamfer"].includes(t)) this.action("chamfer");
    else if (["s", "sk", "sketch"].includes(t)) this.action("newsketch");
    else if (["wp", "plane", "workplane", "ucs"].includes(t)) this.action("workplane");
    else if (t !== "") this.host.commandBar.setStatus("3D", `Unknown command "${t}" - try E (extrude), R (revolve), H (hole), F (fillet), CH (chamfer), RO (rotate), L (3D line), MEA (measure), DI (distance), SM (sheet metal), S (sketch), WP`);
  }

  escape(): void {
    this.cancel();
  }

  private cancel(): void {
    this.active?.cancel(); // calls finishCommand via ctx.done()
    this.active = null;
    if (this.pickingSketchPlane) {
      this.pickingSketchPlane = false;
      this.view.setPickMode("none");
      this.host.commandBar.setReady();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.active?.onKey?.(e) === true) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Enter") this.active?.ok();
    else if (e.key === "Delete") {
      if (this.selectedNode !== null && this.active === null) this.deleteNode(this.selectedNode);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (this.active === null || this.active.textInput !== undefined)) {
      // Same as 2D: typing a command shortcut goes to the command bar.
      this.host.commandBar.enableInput("text");
      this.host.commandBar.insertChar(e.key); // marks the field as typed, so the next key appends
      e.preventDefault();
    }
  }

  // --- New Sketch (one click: a plane, or a flat face) ---

  private startNewSketch(): void {
    this.cancel();
    this.pickingSketchPlane = true;
    this.view.setOriginPlanesVisible(true);
    this.view.setPickMode("plane");
    this.host.commandBar.setStatus("NEW SKETCH", "Click a plane or a flat face of the solid - each New Sketch is a new sketch");
  }

  private pickSketchPlane(key: string): void {
    this.cancel();
    // Every New Sketch is its own sketch -- XY too (the 2D drawing is opened from its own tree row).
    this.host.enterSketch(nextId(this.part(), "Sketch"), { base: key, offset: 0 });
  }

  // --- model browser ---

  private editFeature(id: string): void {
    const f = this.part().features.find((x) => x.id === id);
    if (f === undefined) return;
    if (f.type === "hole") this.run(() => HoleCommand.start(this.ctx, f));
    else if (isEdgeFeature(f)) this.run(() => EdgeBlendCommand.start(this.ctx, f.type, f));
    else if (f.type === "revolve") this.run(() => RevolveCommand.start(this.ctx, f));
    else if (f.type === "pattern") this.run(() => PatternCommand.start(this.ctx, f.kind, f));
    else if (f.type === "rotate") this.run(() => RotateCommand.start(this.ctx, f));
    else if (f.type === "sheet") this.run(() => SheetMetalCommand.start(this.ctx, f));
    else this.run(() => ExtrudeCommand.start(this.ctx, f));
  }

  private deleteNode(id: string): void {
    const part = this.part();
    if (id === DRAWING_SKETCH) return;
    if (part.features.some((f) => usesSketch(f) && f.sketch === id)) {
      showToast(`${id} is used by a feature - delete the feature first.`);
      return;
    }
    if (part.sketches.some((s) => s.plane.base === id)) {
      showToast(`${id} has sketches on it - delete them first.`);
      return;
    }
    const user = part.features.find(
      (f) => (f.type === "pattern" && (f.features.includes(id) || f.plane === id)) || (f.type === "rotate" && (f.bodies?.includes(id) === true || f.pieces?.some((x) => x.feature === id) === true)),
    );
    if (user !== undefined) {
      showToast(`${id} is used by ${user.id} - delete that first.`);
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

  /** Hide / show a feature: the model is rebuilt without / with it. */
  private toggleHidden(id: string): void {
    this.cancel();
    this.commit((p) => {
      const f = p.features.find((x) => x.id === id);
      if (f !== undefined) f.suppressed = f.suppressed !== true;
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
      opts: { error?: string; hint?: string } = {},
    ): void => {
      const r = document.createElement("div");
      r.className = "mb-row";
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
      // A feature can be hidden: the model is rebuilt without it (and shown again the same way).
      const feature = part.features.find((f) => f.id === id);
      const isHidden = feature?.suppressed === true;
      if (feature !== undefined) {
        if (isHidden) {
          r.classList.add("suppressed");
          if (opts.error === undefined) r.title = "Hidden - the model is built without it. Click the eye to show it again";
        }
        const eye = document.createElement("span");
        eye.className = "mb-eye";
        eye.innerHTML = isHidden ? EYE_OFF_SVG : EYE_SVG;
        eye.title = isHidden ? "Show this feature" : "Hide this feature";
        eye.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleHidden(id);
        });
        eye.addEventListener("dblclick", (e) => e.stopPropagation());
        r.appendChild(eye);
      }
      r.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.selectedNode = id;
        for (const item of el.querySelectorAll<HTMLElement>(".mb-row")) item.classList.toggle("selected", item === r);
        const items: [string, () => void][] = [["Edit", onOpen]];
        if (feature !== undefined) items.push([isHidden ? "Show" : "Hide", () => this.toggleHidden(id)]);
        if (id !== DRAWING_SKETCH) items.push(["Delete", () => this.deleteNode(id)]);
        showRowMenu(e.clientX, e.clientY, items);
      });
      r.addEventListener("click", () => {
        if (this.active?.onTreePick?.(id) === true) return;
        this.selectedNode = id;
        // Keep this row mounted between the two clicks of a double-click.
        // Rebuilding the tree here removes the target after the first click,
        // so Firefox never dispatches `dblclick` and feature editing cannot open.
        for (const item of el.querySelectorAll<HTMLElement>(".mb-row")) {
          item.classList.toggle("selected", item === r);
        }
        this.view.canvas.focus();
      });
      r.addEventListener("dblclick", onOpen);
      el.appendChild(r);
    };

    const regionCount = (sketchId: string): string => {
      const n = this.result?.sketches.get(sketchId)?.profiles.regions.length ?? 0;
      return `${n} closed shape${n === 1 ? "" : "s"}`;
    };

    row(DRAWING_SKETCH, "2D Drawing", `XY · ${regionCount(DRAWING_SKETCH)}`, "✎", () => this.host.enterDrawing(), {
      hint: "The 2D drafting drawing (XY plane). Double-click to edit it in 2D.",
    });

    for (const wp of part.planes) {
      const g = this.result?.planes.get(wp.id);
      const off = evalExpression(wp.offset, this.params());
      const ang = evalExpression(wp.angle, this.params());
      const [u, v] = planeAxes(wp.base);
      const tilt = ang !== null && ang !== 0 ? `, ${ang}° about ${wp.axis === "u" ? u : v}` : "";
      const detail =
        wp.on !== undefined
          ? modelPlaneSummary(wp.on, `${ang ?? wp.angle}`) + (off !== null && off !== 0 ? `, ${off} mm` : "")
          : `${wp.base} ${off ?? wp.offset} mm${tilt}`;
      row(wp.id, wp.id, detail, "◇", () => this.run(() => new WorkPlaneCommand(this.ctx, wp)), {
        error: g?.error,
      });
    }

    // History order (Inventor-style): each feature, with the sketch it
    // consumes listed just before it.
    const shownSketches = new Set<string>();
    const sketchRow = (id: string): void => {
      const sketch = part.sketches.find((s) => s.id === id);
      if (sketch === undefined || shownSketches.has(id)) return;
      shownSketches.add(id);
      row(sketch.id, sketch.id, `${planeLabel(sketch.plane)} · ${regionCount(sketch.id)}`, "✎", () => {
        this.cancel();
        this.host.enterSketch(sketch.id, sketch.plane);
      });
    };
    for (const f of part.features) {
      const st = this.result?.status.get(f.id);
      const error = st?.ok === false ? st.error : undefined;
      if (f.type === "hole") {
        row(f.id, f.id, holeSummary(f, this.params()), "◉", () => this.editFeature(f.id), { error });
        continue;
      }
      if (isEdgeFeature(f)) {
        const v = evalExpression(f.size, this.params());
        const size = v === null ? f.size : `${+v.toFixed(3)}`;
        const what = f.type === "fillet" ? `R${size}` : f.mode === "two" ? `${size} × ${f.size2 ?? "?"}` : f.mode === "angle" ? `${size} × ${f.angle ?? "?"}°` : `${size}`;
        const n = f.edges.length;
        row(f.id, f.id, `${what} · ${n} edge${n === 1 ? "" : "s"}`, f.type === "fillet" ? "◜" : "◸", () => this.editFeature(f.id), { error });
        continue;
      }
      if (f.type === "pattern") {
        const n = (e: string | undefined): string => {
          const v = e === undefined ? null : evalExpression(e, this.params());
          return v === null ? (e ?? "?") : `${+v.toFixed(3)}`;
        };
        const what =
          f.kind === "mirror"
            ? `in ${f.planeFace !== undefined ? `face of ${f.planeFace.feature}` : (f.plane ?? "?")}`
            : f.kind === "circular"
              ? `×${n(f.count1)} over ${n(f.angle ?? "360")}° about ${f.axisFace !== undefined ? `face of ${f.axisFace.feature}` : (f.dir1 ?? "Z")}`
              : `${n(f.count1)} × ${n(f.spacing1)} mm along ${f.dir1 ?? "X"}${f.dir2 !== undefined ? `, ${n(f.count2)} × ${n(f.spacing2)} mm along ${f.dir2}` : ""}`;
        row(f.id, f.id, `${f.features.join(", ")} ${what}`, f.kind === "mirror" ? "⇋" : f.kind === "circular" ? "❋" : "▦", () => this.editFeature(f.id), { error });
        continue;
      }
      if (f.type === "rotate") {
        const deg = evalExpression(f.angle, this.params());
        const about = f.axisEdge !== undefined ? "an edge" : f.axisFace !== undefined ? `face of ${f.axisFace.feature}` : (f.axis ?? "Z");
        const n = f.pieces?.length ?? 0;
        const what = f.pieces !== undefined ? `${n} solid${n === 1 ? "" : "s"}` : f.bodies === undefined ? "all bodies" : f.bodies.join(", ");
        row(f.id, f.id, `${what} ${deg === null ? f.angle : +deg.toFixed(3)}° about ${about}`, "⟳", () => this.editFeature(f.id), { error });
        continue;
      }
      sketchRow(f.sketch);
      if (f.type === "sheet") {
        const t = evalExpression(f.thickness, this.params());
        const n = f.bends.length;
        const mat = sheetMaterial(f.material).name.replace(/ \(.*\)/, "");
        row(f.id, f.id, `${t === null ? f.thickness : +t.toFixed(3)} mm ${mat} · ${n} bend${n === 1 ? "" : "s"}${f.flat === true ? " · flat" : ""}`, "⌐", () => this.editFeature(f.id), { error });
        continue;
      }
      if (f.type === "revolve") {
        const deg = evalExpression(f.angle, this.params());
        const turn = f.extent !== "angle" ? "360°" : deg === null ? f.angle : `${+deg.toFixed(3)}°`;
        row(f.id, f.id, `${OPERATION_LABEL[f.operation]} ${turn}${f.sketch === DRAWING_SKETCH ? " (2D)" : ""}`, "◐", () => this.editFeature(f.id), { error });
        continue;
      }
      const value = evalExpression(f.distance, this.params());
      const amount = f.extent === "through" ? "through all" : f.extent === "toFace" ? `to face of ${f.toFace?.feature ?? "?"}` : value === null ? f.distance : `${+value.toFixed(3)} mm`;
      const from = f.sketch === DRAWING_SKETCH ? " (2D)" : "";
      const deg = (e: string | undefined, label: string): string => {
        const v = e === undefined ? 0 : evalExpression(e, this.params());
        return v === 0 ? "" : `, ${label} ${v === null ? e : +v.toFixed(3)}°`;
      };
      row(f.id, f.id, `${OPERATION_LABEL[f.operation]} ${amount}${deg(f.taper, "taper")}${deg(f.lean, "lean")}${from}`, "▣", () => this.editFeature(f.id), { error });
    }
    for (const sketch of part.sketches) sketchRow(sketch.id);
  }
}

const EYE_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>';

/** The Model tree's right-click menu; closes on a choice, a click elsewhere, or Esc. */
function showRowMenu(x: number, y: number, items: readonly (readonly [string, () => void])[]): void {
  document.querySelector(".mb-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "mb-menu";
  const close = (): void => {
    menu.remove();
    document.removeEventListener("pointerdown", onAway, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onAway = (e: Event): void => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  for (const [label, run] of items) {
    const item = document.createElement("div");
    item.className = "mb-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      close();
      run();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 4)}px`;
  document.addEventListener("pointerdown", onAway, true);
  document.addEventListener("keydown", onKey, true);
}

/** "45° from face of Extrude001" -- tree detail of a plane tied to the model. */
function modelPlaneSummary(on: ModelPlaneRef, angle: string): string {
  const kind = modelPlaneKind(on);
  if (kind === "points") return "through 3 points";
  const of = `face of ${(on as { face: { feature: string } }).face.feature}`;
  if (kind === "tangent") return `tangent at ${angle}° on ${of}`;
  if (kind === "parallel") return `parallel to ${of}`;
  if (kind === "mid") return `between ${of} and ${(on as { face2: { feature: string } }).face2.feature}`;
  return `${angle}° from ${of}`;
}

/** "Ø10 thru ×2 · c'bore Ø18×6" -- tree detail. */
function holeSummary(f: HoleFeature, params: ReadonlyMap<string, number>): string {
  const v = (e: string | undefined): string => {
    const n = e === undefined ? null : evalExpression(e, params);
    return n === null ? (e ?? "?") : `${+n.toFixed(3)}`;
  };
  const depth = f.extent === "through" ? "thru" : f.extent === "toAxis" ? "to axis" : `↧${v(f.depth)}`;
  const count = f.centers.length > 1 ? ` ×${f.centers.length}` : "";
  const extra =
    f.style === "counterbore"
      ? ` · c'bore Ø${v(f.cbDiameter)}×${v(f.cbDepth)}`
      : f.style === "countersink"
        ? ` · c'sink Ø${v(f.csDiameter)} ${v(f.csAngle)}°`
        : "";
  const lean = f.lean === undefined ? "" : ` · lean ${v(f.lean)}°${f.locate === "axis" ? " (to axis crossing)" : ""}`;
  return `Ø${v(f.diameter)} ${depth}${f.placement === "radial" ? " radial" : ""}${count}${extra}${lean}`;
}

/** Short description of where a sketch lives. */
export function planeLabel(plane: PlaneRef): string {
  return plane.base === "face" && plane.face !== undefined ? `face of ${plane.face.feature}` : plane.base;
}
