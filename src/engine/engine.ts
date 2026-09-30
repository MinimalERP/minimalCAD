/**
 * MinimalCAD Web
 * engine/engine.ts
 *
 * Owns document/undo/viewport/commandBar and the small set of shared
 * methods every command needs (snap, ortho, pick tolerance, undo/redo,
 * zoom extents) -- the single object commands receive at construction.
 * Deliberately holds no DOM references of its own (redraw requests go
 * through an injected callback) so command state machines can be driven and
 * asserted on directly in tests without any canvas/DOM present.
 *
 * `snap()` resolves real osnaps (engine/snap.ts) within a zoom-aware pick
 * tolerance -- commands don't need to know it was a Phase C no-op stub
 * before Phase E wired the real search in here.
 */

import type { Point } from "../core/types";
import { Document } from "../core/document";
import { Undo } from "../core/undo";
import { Selection } from "../core/selection";
import { Viewport } from "./viewport";
import { findSnap } from "./snap";
import type { CommandBar } from "../ui/commandBar";
import { CommandManager } from "../commands/manager";
import type { Constraint } from "../core/constraints";
import { QuickEditController } from "./quickEdit";
import type { Entity } from "../entities/entity";
import { boundsOf } from "../core/document";

export interface SnapResult {
  point: Point;
  snapType: string | null;
}

export class Engine {
  readonly document = new Document();
  readonly undo = new Undo();
  readonly selection = new Selection();
  readonly viewport: Viewport;
  readonly commandBar: CommandBar;
  readonly commandManager: CommandManager;
  readonly quickEdit: QuickEditController;

  orthoEnabled = false;

  /** Reference-only geometry drawn dimmed behind the document and offered
   *  to osnap -- e.g. a 3D solid's edges projected onto the sketch plane
   *  being edited (view3d/). Never selectable, never saved, never undone. */
  underlay: Entity[] = [];

  /** Drawing sheets (drawing/): the sheet paints itself behind the document
   *  instead of the grid, and its view geometry is underlay for osnap only
   *  (the painter draws it with real line weights, so it isn't drawn twice). */
  backdrop: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  underlayHidden = false;

  /** Dimension decimals for new dimensions (DIMDEC): 0-4, or null = the
   *  classic 2 decimals ("auto" trims zeros: 25, 12.5). */
  dimPrecision: number | "auto" | null = null;
  /** Extra data a new dimension gets from where it's measured -- a drawing
   *  sheet's view scale (drawing/). */
  dimensionStyle: ((anchor: Point | null) => Record<string, number>) | null = null;

  /** `data` for a new dimension (its live preview too), with this drawing's
   *  dimension settings applied -- so the value shown while placing it is
   *  the value it keeps. */
  styleDimension<T extends Record<string, unknown>>(data: T): T {
    const out: Record<string, unknown> = { ...data };
    if (this.dimPrecision === "auto") out.trim_zeros = 1;
    else if (typeof this.dimPrecision === "number") out.precision = this.dimPrecision;
    if (this.dimensionStyle !== null) {
      const anchor = Object.values(data).find(
        (v): v is Point => typeof v === "object" && v !== null && "x" in v && "y" in v,
      );
      Object.assign(out, this.dimensionStyle(anchor ?? null));
    }
    return out as T;
  }

  /** Axis names for the 2D UCS icon: which 3D axes this drawing's screen
   *  right/up are -- X/Y for the base drawing, e.g. X/Z on a Front sketch. */
  ucsLabels: [string, string] = ["X", "Y"];

  /** The currently-picked distance constraint's id (see core/constraints.ts),
   *  or null -- a constraint isn't a document entity and has its own
   *  narrower selection concept (a single id, not a Selection set), matching
   *  the desktop app's own selected_constraint_id on graphics/canvas.py.
   *  Read by ui/canvasView.ts (highlighting + pointer-down pick) and
   *  deleteSelected() below (constraint deletion takes priority over
   *  entity deletion when one is picked). */
  activeConstraintId: string | null = null;

  /** The last-resolved osnap point/type, updated as a side effect of every
   *  snap() call (mirrors the desktop app's own active_snap_point/
   *  active_snap_type) -- ui/canvasView.ts reads these to draw the yellow
   *  marker glyph. */
  activeSnapPoint: Point | null = null;
  activeSnapType: string | null = null;

  /** Which cloud `drawings` row (io/cloudDrawings.ts) this tab's Save button
   *  currently overwrites, or null if this tab has never been saved to/opened
   *  from the cloud yet. Lives here (rather than as module-level state in
   *  ui/cloudPanelImpl.ts, back when only one document could ever be open at
   *  once) so each tab (engine/session.ts) tracks its own cloud identity
   *  independently of every other open tab. */
  cloudDrawingId: string | null = null;
  cloudDrawingName = "Untitled";

  /** Called whenever this tab's document is replaced by something other than
   *  opening this exact cloud drawing (local Open, Import DXF, a fresh tab)
   *  -- so a subsequent cloud Save can't silently overwrite an unrelated
   *  cloud drawing's content under its old id. */
  clearCloudDrawing(): void {
    this.cloudDrawingId = null;
    this.cloudDrawingName = "Untitled";
  }

  constructor(
    viewport: Viewport,
    commandBar: CommandBar,
    private requestRedrawCallback: () => void,
    onCommandChanged?: () => void,
  ) {
    this.viewport = viewport;
    this.commandBar = commandBar;
    this.commandManager = new CommandManager(this, onCommandChanged);
    this.quickEdit = new QuickEditController(this);
  }

  requestRedraw(): void {
    this.requestRedrawCallback();
  }

  pickTolerance(screenPx?: number): number {
    return this.viewport.pickTolerance(screenPx);
  }

  /** Resolves the highest-priority osnap within pickTolerance()'s zoom-aware
   *  radius, or falls through to the raw click point untouched.
   *  `referencePoint` (the previous point picked in the active command, e.g.
   *  a line's start point) enables the direction-dependent Perpendicular/
   *  Tangent osnaps. */
  snap(worldPos: Point, referencePoint: Point | null = null): SnapResult {
    const candidates = this.underlay.length > 0 ? [...this.document.getEntities(), ...this.underlay] : this.document.getEntities();
    const match = findSnap(worldPos, candidates, this.pickTolerance(10.0), referencePoint);
    this.activeSnapPoint = match?.point ?? null;
    this.activeSnapType = match?.snapType ?? null;
    this.commandBar.setSnap(this.activeSnapType);
    return match ?? { point: worldPos, snapType: null };
  }

  /** Clears the yellow snap marker and the command bar's snap-type label --
   *  call whenever a command ends/cancels so stale feedback doesn't linger. */
  clearSnapFeedback(): void {
    this.activeSnapPoint = null;
    this.activeSnapType = null;
    this.commandBar.setSnap(null);
  }

  /** Axis-constrains `point` onto whichever of horizontal/vertical through
   *  `origin` the raw direction leans closer to. Only meaningful when Ortho
   *  is on and the caller already found no snap for this point. */
  applyOrtho(origin: Point, point: Point): Point {
    if (!this.orthoEnabled) return point;
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: point.x, y: origin.y } : { x: origin.x, y: point.y };
  }

  toggleOrtho(): void {
    this.orthoEnabled = !this.orthoEnabled;
    this.commandBar.setOrtho(this.orthoEnabled);
  }

  cancelCommand(): void {
    this.commandManager.cancel();
    this.clearSnapFeedback();
  }

  undoAction(): void {
    if (this.commandManager.currentCommand !== null) return;
    const snapshot = this.undo.undo(this.document.toDict());
    if (snapshot === null) return;
    this.document.restoreFromDict(snapshot);
    this.requestRedraw();
  }

  redoAction(): void {
    if (this.commandManager.currentCommand !== null) return;
    const snapshot = this.undo.redo(this.document.toDict());
    if (snapshot === null) return;
    this.document.restoreFromDict(snapshot);
    this.requestRedraw();
  }

  zoomExtents(): void {
    const all = [...this.document.entities, ...this.underlay];
    this.viewport.zoomExtents(all.length > 0 ? boundsOf(all) : null);
    this.requestRedraw();
  }

  /** Erases every currently selected entity from the drawing, with undo
   *  support -- or, if a constraint line (see core/constraints.ts) is the
   *  current pick instead, just that one constraint (the entities it
   *  references are untouched). */
  deleteSelected(): void {
    if (this.activeConstraintId !== null) {
      const constraintId = this.activeConstraintId;
      this.activeConstraintId = null;
      const constraints = this.document.constraints as Constraint[];
      if (constraints.some((c) => c.id === constraintId)) {
        this.undo.push(this.document.toDict());
        this.document.constraints = constraints.filter((c) => c.id !== constraintId);
        this.requestRedraw();
      }
      return;
    }

    const selected = this.selection.getEntities();
    if (selected.length === 0) return;

    this.undo.push(this.document.toDict());
    for (const entity of selected) {
      this.document.removeEntity(entity);
    }
    this.selection.clear();
    this.quickEdit.refreshStatus();
    this.requestRedraw();
  }
}
