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
import { parseEntities } from "../core/document";
import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { HoleFeature, PartData, PlaneRef } from "../part/types";
import { DRAWING_SKETCH, emptyPart, isExtrude, nextId, parsePart } from "../part/types";
import { rebuild, resolvePlane } from "../part/rebuild";
import type { RebuildResult } from "../part/rebuild";
import { projectBodies } from "../part/project";
import { axisName } from "../part/plane";
import type { Frame } from "../part/plane";
import { evalExpression } from "../part/params";
import { entityPolylines } from "../part/profile";
import { ModelView } from "./modelView";
import type { ModelCommand, ModelContext } from "./commands/context";
import { ExtrudeCommand } from "./commands/extrudeCommand";
import { HoleCommand } from "./commands/holeCommand";
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
      showWireframes: (alsoShow) => this.showWireframes(this.part(), alsoShow),
      status: (command, text) => this.host.commandBar.setStatus(command, text),
      done: () => this.finishCommand(),
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
      [...this.result.planes.values()].flatMap((p) => (p.frame === null ? [] : [{ key: p.id, frame: p.frame }])),
    );
    this.view.updateOriginScale();
    this.renderBrowser(part);
  }

  /** The 2D drawing is always shown on the XY ground (it IS the model
   *  space); other sketches only until a feature consumes them. */
  private showWireframes(part: PartData, alsoShow: ReadonlySet<string> = new Set()): void {
    const used = new Set(part.features.filter(isExtrude).map((f) => f.sketch));
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

  // --- commands ---

  action(action: ModelAction): void {
    switch (action) {
      case "newsketch":
        return this.startNewSketch();
      case "workplane":
        return this.run(() => new WorkPlaneCommand(this.ctx, null));
      case "extrude":
        return this.run(() => ExtrudeCommand.start(this.ctx, null));
      case "hole":
        return this.run(() => HoleCommand.start(this.ctx, null));
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
    const t = text.trim().toLowerCase();
    if (this.pickingSketchPlane) {
      const upper = t.toUpperCase();
      const wp = this.part().planes.find((p) => p.id.toUpperCase() === upper);
      if (upper === "XY" || upper === "XZ" || upper === "YZ") this.pickSketchPlane(upper);
      else if (wp !== undefined) this.pickSketchPlane(wp.id);
      return;
    }
    if (["e", "ext", "extrude"].includes(t)) this.action("extrude");
    else if (["h", "hole"].includes(t)) this.action("hole");
    else if (["s", "sk", "sketch"].includes(t)) this.action("newsketch");
    else if (["wp", "plane", "workplane", "ucs"].includes(t)) this.action("workplane");
    else if (t !== "") this.host.commandBar.setStatus("3D", `Unknown command "${t}" - try E (extrude), H (hole), S (sketch), WP`);
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
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && this.active === null) {
      // Same as 2D: typing a command shortcut goes to the command bar.
      this.host.commandBar.enableInput("text");
      this.host.commandBar.setValue(e.key);
      e.preventDefault();
    }
  }

  // --- New Sketch (one click: a plane, or a flat face) ---

  private startNewSketch(): void {
    this.cancel();
    this.pickingSketchPlane = true;
    this.view.setOriginPlanesVisible(true);
    this.view.setPickMode("plane");
    this.host.commandBar.setStatus("NEW SKETCH", "Click a plane or a flat face of the solid (XY = the 2D drawing)");
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

  // --- model browser ---

  private editFeature(id: string): void {
    const f = this.part().features.find((x) => x.id === id);
    if (f === undefined) return;
    if (f.type === "hole") this.run(() => HoleCommand.start(this.ctx, f));
    else this.run(() => ExtrudeCommand.start(this.ctx, f));
  }

  private deleteNode(id: string): void {
    const part = this.part();
    if (id === DRAWING_SKETCH) return;
    if (part.features.some((f) => isExtrude(f) && f.sketch === id)) {
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

    row(DRAWING_SKETCH, "2D Drawing", `XY · ${regionCount(DRAWING_SKETCH)}`, "✎", () => this.host.enterDrawing(), {
      hint: "The 2D drafting drawing (XY plane). Double-click to edit it in 2D.",
    });

    for (const wp of part.planes) {
      const g = this.result?.planes.get(wp.id);
      const off = evalExpression(wp.offset, this.params());
      const ang = evalExpression(wp.angle, this.params());
      const [u, v] = planeAxes(wp.base);
      const tilt = ang !== null && ang !== 0 ? `, ${ang}° about ${wp.axis === "u" ? u : v}` : "";
      row(wp.id, wp.id, `${wp.base} ${off ?? wp.offset} mm${tilt}`, "◇", () => this.run(() => new WorkPlaneCommand(this.ctx, wp)), {
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
      sketchRow(f.sketch);
      const value = evalExpression(f.distance, this.params());
      const amount = f.extent === "through" ? "through all" : value === null ? f.distance : `${+value.toFixed(3)} mm`;
      const from = f.sketch === DRAWING_SKETCH ? " (2D)" : "";
      row(f.id, f.id, `${OPERATION_LABEL[f.operation]} ${amount}${from}`, "▣", () => this.editFeature(f.id), { error });
    }
    for (const sketch of part.sketches) sketchRow(sketch.id);
  }
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
  return `Ø${v(f.diameter)} ${depth}${f.placement === "radial" ? " radial" : ""}${count}${extra}`;
}

/** Short description of where a sketch lives. */
export function planeLabel(plane: PlaneRef): string {
  return plane.base === "face" && plane.face !== undefined ? `face of ${plane.face.feature}` : plane.base;
}
