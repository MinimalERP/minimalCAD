/**
 * MinimalCAD Web
 * workspace/workspace.ts
 *
 * Switches a tab between its workspaces -- 2D drafting (the original app),
 * 3D model, and part sketch -- so the whole thing feels like ONE program:
 *
 *   drafting <-> model      2D / 3D switcher in the toolbar
 *   model -> sketch         New Sketch (pick a plane) / double-click a sketch
 *   sketch -> model         Finish Sketch
 *
 * A part sketch is edited by a dedicated Engine+Viewport (engine/session.ts's
 * createEngine) pointed at by the one shared CanvasView, so every 2D command
 * works on it unchanged. The 3D side (three.js + view3d/) is loaded on the
 * first switch to 3D only; this module itself stays tiny and 3D-free.
 */

import type { CanvasView } from "../ui/canvasView";
import type { CommandBar } from "../ui/commandBar";
import type { DrawingToolAction, ModelAction, ToolbarHandle, ToolbarWorkspaceHost } from "../ui/toolbar";
import type { TabSession } from "../engine/session";
import { createEngine } from "../engine/session";
import type { Engine } from "../engine/engine";
import type { PlaneRef, SketchData } from "../part/types";
import { emptyPart, parsePart } from "../part/types";
import type { ModelController } from "../view3d/modelController";
import type { DrawingController } from "../drawing/drawingController";
import { showToast } from "../ui/toast";

export interface WorkspaceDeps {
  canvasEl: HTMLCanvasElement;
  glCanvasEl: HTMLCanvasElement;
  browserEl: HTMLElement;
  commandBar: CommandBar;
  getView(): CanvasView;
  getSession(): TabSession;
  requestRedraw(): void;
  onCommandChanged(): void;
  /** Open (or switch to) the drawing tab of `source`. */
  openDrawingTab(source: TabSession): void;
  findSession(id: string): TabSession | undefined;
}

export class WorkspaceController implements ToolbarWorkspaceHost {
  private toolbar: ToolbarHandle | null = null;
  private model: ModelController | null = null;
  private modelLoading: Promise<ModelController> | null = null;
  /** One sheet controller per drawing tab (the module loads on first use). */
  private drawings = new Map<string, DrawingController>();
  private drawingModule: Promise<typeof import("../drawing/drawingController")> | null = null;

  constructor(private deps: WorkspaceDeps) {}

  attachToolbar(toolbar: ToolbarHandle): void {
    this.toolbar = toolbar;
  }

  /** The Engine that input should go to: the open sketch's, else the tab's. */
  activeEngine(session: TabSession = this.deps.getSession()): Engine {
    return session.sketch?.engine ?? session.engine;
  }

  isModel(): boolean {
    return this.deps.getSession().workspace === "model";
  }

  // --- ToolbarWorkspaceHost ---

  switchTo(workspace: "drafting" | "model"): void {
    const session = this.deps.getSession();
    if (session.workspace === workspace || session.workspace === "sketch" || session.workspace === "drawing") return;
    session.engine.cancelCommand();
    session.workspace = workspace;
    this.apply(session);
  }

  modelAction(action: ModelAction): void {
    // Only meaningful in 3D (a hidden toolbar button must not start a 3D
    // command under a 2D sketch -- that left a stale prompt behind).
    if (!this.isModel()) return;
    void this.loadModel().then((m) => m.action(action));
  }

  documentChanged(): void {
    const session = this.deps.getSession();
    // Opened a drawing file: this tab becomes a drawing tab.
    if (session.engine.document.sheets !== undefined && session.workspace !== "sketch") {
      session.workspace = "drawing";
      this.apply(session);
      return;
    }
    // Opening a pure 3D part file drops you straight into 3D.
    if (session.workspace === "drafting" && session.engine.document.part !== undefined && session.engine.document.entities.length === 0) {
      session.workspace = "model";
      this.apply(session);
      return;
    }
    if (session.workspace === "model") this.model?.refresh();
    // Opened a model file in 2D: offer Finish 2D / Drawing right away.
    else if (session.workspace === "drafting") this.apply(session);
  }

  finish2d(): void {
    const session = this.deps.getSession();
    if (session.workspace !== "drafting") return;
    session.engine.cancelCommand();
    session.workspace = "model";
    this.apply(session);
  }

  /** Edit the 2D drawing (the model's XY plane), Inventor "Edit Sketch" style. */
  enterDrawing(): void {
    const session = this.deps.getSession();
    session.workspace = "drafting";
    this.apply(session);
    session.engine.zoomExtents();
  }

  finishSketch(): void {
    const session = this.deps.getSession();
    const edit = session.sketch;
    if (edit === null) return;
    edit.engine.cancelCommand();

    const doc = session.engine.document;
    const part = parsePart(doc.part) ?? emptyPart();
    const snapshot = edit.engine.document.toDict();
    const existing = part.sketches.find((s) => s.id === edit.sketchId);
    const isEmpty = snapshot.entities.length === 0;

    if (existing === undefined && isEmpty) {
      // A brand-new sketch left empty: just discard it.
    } else {
      const next: SketchData = {
        id: edit.sketchId,
        plane: existing?.plane ?? edit.plane,
        entities: snapshot.entities,
        constraints: snapshot.constraints,
      };
      if (JSON.stringify(existing) !== JSON.stringify(next)) {
        session.engine.undo.push(doc.toDict());
        if (existing === undefined) part.sketches.push(next);
        else part.sketches[part.sketches.indexOf(existing)] = next;
        doc.part = part;
      }
    }
    session.sketch = null;
    session.workspace = "model";
    this.apply(session);
  }

  // --- sketch editing (called by the model module) ---

  enterSketch(sketchId: string, plane: PlaneRef): void {
    const session = this.deps.getSession();
    const part = parsePart(session.engine.document.part) ?? emptyPart();
    const existing = part.sketches.find((s) => s.id === sketchId);
    const { engine, viewport } = createEngine(
      () => this.deps.canvasEl.clientWidth,
      () => this.deps.canvasEl.clientHeight,
      this.deps.commandBar,
      this.deps.requestRedraw,
      this.deps.onCommandChanged,
    );
    if (existing !== undefined) {
      const { skippedCount } = engine.document.restoreFromDict({
        entities: existing.entities,
        constraints: existing.constraints,
      });
      if (skippedCount > 0) showToast(`${skippedCount} unsupported sketch entities were skipped.`);
    }
    const sketchPlane = existing?.plane ?? plane;
    const reference = this.model?.referenceFor(sketchPlane);
    if (reference !== undefined) {
      engine.underlay = reference.underlay;
      engine.ucsLabels = reference.labels;
    }
    session.sketch = { sketchId, engine, viewport, plane: sketchPlane };
    session.workspace = "sketch";
    this.apply(session);
    if (engine.document.entities.length > 0 || engine.underlay.length > 0) engine.zoomExtents();
  }

  // --- drawing tabs ---

  openDrawing(): void {
    const session = this.deps.getSession();
    if (session.workspace === "drawing" || session.workspace === "sketch") return;
    this.deps.openDrawingTab(session);
  }

  drawingAction(action: DrawingToolAction): void {
    const session = this.deps.getSession();
    if (session.workspace !== "drawing") return;
    void this.loadDrawing(session).then((d) => {
      if (action === "fit") d.zoomSheet();
      else d.action(action);
    });
  }

  private loadDrawing(session: TabSession): Promise<DrawingController> {
    const have = this.drawings.get(session.id);
    if (have !== undefined) return Promise.resolve(have);
    this.drawingModule ??= import("../drawing/drawingController");
    return this.drawingModule.then((mod) => {
      const again = this.drawings.get(session.id);
      if (again !== undefined) return again;
      const d = new mod.DrawingController(session.engine, session.viewport, {
        source: () => {
          const model = session.drawingOf === null ? undefined : this.deps.findSession(session.drawingOf);
          if (model === undefined || model.engine.document.part === undefined) return null;
          return {
            name: model.name,
            part: structuredClone(model.engine.document.part),
            entities: model.engine.document.entities.map((e) => e.serialize()),
          };
        },
        dialogParent: this.deps.canvasEl.parentElement!,
        requestRedraw: this.deps.requestRedraw,
      });
      this.drawings.set(session.id, d);
      return d;
    });
  }

  // --- applying a session's workspace to the shared UI ---

  /** Shows the right canvas + toolbar for `session`. Also used on tab switch. */
  apply(session: TabSession): void {
    const ws = session.workspace;
    const is3d = ws === "model";
    this.deps.canvasEl.hidden = is3d;
    this.deps.glCanvasEl.hidden = !is3d;
    this.deps.browserEl.hidden = !is3d;
    document.body.dataset.workspace = ws;

    const sketch = session.sketch;
    const where =
      sketch === null ? "" : sketch.plane.base === "face" ? `face of ${sketch.plane.face?.feature ?? "?"}` : `${sketch.plane.base} plane`;
    const model = session.drawingOf === null ? undefined : this.deps.findSession(session.drawingOf);
    const label =
      sketch !== null
        ? `${sketch.sketchId} on ${where}`
        : ws === "drawing"
          ? `Drawing${model !== undefined ? ` of ${model.name}` : ""}`
          : "";
    // The 2D drawing is the XY plane: show the solids' plan outline under it.
    if (ws === "drafting") {
      session.engine.underlay =
        session.engine.document.part !== undefined ? (this.model?.referenceFor({ base: "XY", offset: 0 }).underlay ?? []) : [];
    }
    this.toolbar?.setWorkspace(ws, label, session.engine.document.part !== undefined);

    const engine = this.activeEngine(session);
    const viewport = sketch?.viewport ?? session.viewport;
    this.deps.getView().setActiveSession(engine, viewport);

    if (is3d) {
      void this.loadModel().then((m) => {
        if (this.deps.getSession() === session && session.workspace === "model") m.show();
      });
    } else {
      this.model?.hide();
      if (ws === "drawing") {
        const first = !this.drawings.has(session.id);
        void this.loadDrawing(session).then((d) => {
          if (this.deps.getSession() !== session) return;
          d.enter(first);
          this.deps.requestRedraw();
        });
      }
      this.deps.commandBar.setReady();
      if (ws === "sketch") this.deps.commandBar.setStatus("SKETCH", `${label} - draw a closed profile, then Finish Sketch`);
      else if (ws === "drawing") this.deps.commandBar.setStatus("DRAWING", `${label} - place views, then dimension them`);
      else if (session.engine.document.part !== undefined) {
        this.deps.commandBar.setStatus("2D", "Editing the XY drawing of the 3D model - Finish 2D to return to 3D");
      }
      this.deps.canvasEl.focus();
    }
  }

  // --- command bar routing while in 3D ---

  textInput(text: string): void {
    this.model?.textInput(text);
  }

  escape(): void {
    this.model?.escape();
  }

  private loadModel(): Promise<ModelController> {
    if (this.model !== null) return Promise.resolve(this.model);
    this.modelLoading ??= import("../view3d/modelController").then((mod) => {
      this.model = new mod.ModelController(this.deps.glCanvasEl, this.deps.browserEl, {
        commandBar: this.deps.commandBar,
        getEngine: () => this.deps.getSession().engine,
        enterSketch: (id, plane) => this.enterSketch(id, plane),
        enterDrawing: () => this.enterDrawing(),
      });
      return this.model;
    });
    return this.modelLoading;
  }
}
