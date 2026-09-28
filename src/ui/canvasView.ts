/**
 * MinimalCAD Web
 * ui/canvasView.ts
 *
 * Owns the <canvas> element: HiDPI-correct backing-store sizing, the
 * pan/zoom/grid/entity/selection/command-preview render pass, and
 * dispatches pointer/keyboard events (converted to world coordinates) into
 * the Engine -- the direct analogue of graphics/canvas.py's
 * mousePressEvent/mouseMoveEvent/wheelEvent/keyPressEvent.
 *
 * HiDPI note: viewport.zoom/panOffset and every pointer-event coordinate stay
 * in CSS-pixel space throughout. devicePixelRatio only ever enters the
 * picture via the one-time backing-store resize and the per-frame
 * ctx.scale(dpr, dpr) below -- mixing CSS-pixel and device-pixel coordinates
 * anywhere else would silently break picking/pan/zoom.
 *
 * Touch/pointer note: this listens for Pointer Events (not separate mouse/
 * touch listeners), which mouse, pen, and touch input all dispatch alike --
 * `e.pointerType` distinguishes them where behavior actually needs to
 * differ. Mouse and pen input run through EXACTLY the same
 * runPointerDown/runPointerMove/runPointerUp core as before this was pointer-
 * based (unchanged behavior, just re-entered via a differently-named event);
 * touch gets its own gesture layer on top of that same core -- see
 * handleTouchPointerDown's own doc comment for why single-finger taps/drags
 * defer committing to that core by a small movement threshold (so a second
 * finger arriving to start a pinch doesn't first fire a spurious point-pick/
 * click), while two fingers drive pan+zoom directly and never reach it at
 * all. `touch-action: none` on the canvas (style.css) hands ALL gesture
 * recognition to this code -- the browser performs no scroll/pinch-zoom of
 * its own on this element.
 */

import { computeGridLines } from "../engine/grid";
import { entityAt, gripAt } from "../engine/picking";
import type { Viewport } from "../engine/viewport";
import { pointDistance, type Bounds, type Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { Engine } from "../engine/engine";
import type { GripCommand } from "../commands/types";
import { Text } from "../entities/text";
import { Dimension } from "../entities/dimension";
import { constraintAt, constraintLinePoints } from "../core/constraints";
import type { Constraint } from "../core/constraints";
import { copySelection, pasteClipboard } from "../engine/clipboard";

const COLOR_BACKGROUND = "#1e1e1e";
const COLOR_GRID = "#2d2d2d";
const COLOR_AXIS = "#454545";
const COLOR_WINDOW_SELECT = "rgba(80, 140, 255, 1)";
const COLOR_CROSSING_SELECT = "rgba(90, 210, 110, 1)";
const COLOR_SNAP_MARKER = "#ffff00";
const SNAP_MARKER_SCREEN_SIZE = 9.0;
const COLOR_CONSTRAINT = "#c586c0";
const COLOR_CONSTRAINT_ACTIVE = "#ff69ff";

// Screen-pixel movement a pending single-touch point must exceed before it
// commits to a drag/select (rather than staying eligible to become a tap on
// release, or being discarded entirely if a second finger joins) -- matches
// Viewport's own default pick-tolerance pixel radius so "did I actually mean
// to move" reads the same threshold picking itself already uses.
const TOUCH_DRAG_THRESHOLD_PX = 6.0;

// How far above a finger's actual contact point the touch point-pick preview
// cursor is drawn (see handleTouchPointerDown's doc comment) -- large enough
// to clear a fingertip on a phone/tablet digitizer, which is considerably
// fatter than the pen tip this app already handles fine. If the finger is
// close enough to the canvas's top edge that raising the cursor by this much
// would push it off-screen, the offset flips below the finger instead (see
// offsetTouchCursor()) rather than clamping it to some fixed on-screen row,
// which would make the cursor jump discontinuously as the finger crosses
// that boundary.
const TOUCH_CURSOR_OFFSET_PX = 70.0;
const TOUCH_CURSOR_TOP_MARGIN_PX = 24.0;

const GRIP_COMMAND_NAMES: Record<"line_extend" | "move_grip" | "circle_resize" | "dimension_grip", string> = {
  line_extend: "gripextend",
  move_grip: "movegrip",
  circle_resize: "gripresize",
  dimension_grip: "dimensiongrip",
};

interface PendingTouch {
  pointerId: number;
  screenPos: Point;
  worldPos: Point;
}

interface TwoFingerGesture {
  midpoint: Point;
  distance: number;
}

function midpointOf(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  // Not readonly: setActiveSession() repoints both together whenever the
  // active tab (engine/session.ts) changes -- see that method's own comment.
  private viewport: Viewport;
  private engine: Engine;

  private isPanning = false;
  private lastPanScreenPos: Point = { x: 0, y: 0 };
  private redrawScheduled = false;
  private homeInitialized = false;
  private commandBuffer = "";

  // Rubber-band window/crossing selection state.
  private selectOrigin: Point | null = null;
  private selectCurrent: Point | null = null;
  private selectActive = false;
  private selectAdditive = false;

  // Direct click-and-drag body relocation (armed by a plain, non-Shift click
  // that hits an entity body, resolved on move/release).
  private dragEntities: Entity[] | null = null;
  private dragLastPos: Point | null = null;
  private dragMoved = false;

  // Touch gesture state -- see handleTouchPointerDown's doc comment.
  private activeTouches = new Map<number, Point>();
  private pendingTouch: PendingTouch | null = null;
  private touchGesture: TwoFingerGesture | null = null;

  // Touch point-pick preview -- a two-phase aim/confirm model, see
  // handleTouchPointerDown's own doc comment for the full rationale.
  //
  // touchPointPickPointerId: set while a resolved single finger is actively
  // being dragged to aim the CURRENT point-pick step; null once it lifts.
  // touchFingerScreenPos/touchCursorScreenPos: the raw fingertip and its
  // OFFSET preview cursor (see offsetTouchCursor()) -- fed live into the
  // command's own mouseMove()/snap() exactly like a mouse hover would be, so
  // its existing preview/snap-marker drawing already tracks it with no new
  // drawing logic of its own needed. These deliberately survive a lift
  // (frozen in place) rather than clearing, so the ghost stays visible while
  // pendingCommandCandidate awaits confirmation -- see drawTouchOffsetCursor().
  // pendingCommandCandidate: the WORLD position of the current step's
  // candidate once a touch has resolved and lifted (or tapped) without
  // committing -- committed only by a LATER touch or a typed value.
  // pendingCommandTouch: mirrors pendingTouch's own pinch-safety deferral
  // (see handleTouchPointerDown's doc comment) but for a commandActive touch,
  // whose eventual resolution means something different -- confirm-then-aim
  // rather than click-or-drag.
  private touchPointPickPointerId: number | null = null;
  private touchFingerScreenPos: Point | null = null;
  private touchCursorScreenPos: Point | null = null;
  private pendingCommandCandidate: Point | null = null;
  private pendingCommandTouch: PendingTouch | null = null;

  constructor(canvas: HTMLCanvasElement, viewport: Viewport, engine: Engine) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.engine = engine;

    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.resizeToDisplaySize();
    // A ResizeObserver on the canvas itself, not just a window "resize"
    // listener -- the canvas's own CSS box can change size from a pure
    // layout reflow with no window resize at all (e.g. the toolbar wrapping
    // to a second row once buildToolbar() populates it, which happens right
    // after this constructor runs -- see main.ts's ordering comment). Without
    // this, the canvas's backing store stays sized for its pre-toolbar
    // layout and the browser silently stretches it to fit the real (now
    // shorter) box, throwing off every click's mapping back to world space.
    new ResizeObserver(() => this.resizeToDisplaySize()).observe(this.canvas);

    // Pointer Events, not separate mouse/touch listeners: mouse, pen, and
    // touch input all dispatch these alike (see this file's own header
    // comment), and `touch-action: none` on the canvas (style.css) tells the
    // browser to leave ALL gesture recognition here rather than performing
    // its own scroll/pinch-zoom on this element.
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
    this.canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.canvas.addEventListener("mouseleave", () => {
      this.engine.clearSnapFeedback();
      this.engine.commandBar.setTooltipPosition(null);
      this.requestRedraw();
    });

    this.requestRedraw();
  }

  /**
   * Repoints this shared CanvasView at a different tab's session
   * (engine/session.ts) -- called by main.ts whenever the active tab
   * changes (new/close/switch). `engine`/`viewport` are always the SAME
   * pair a session was built with (Engine just holds a reference to its own
   * Viewport), never mixed across sessions, since every pointer-event
   * coordinate this file computes has to agree with whichever Engine is
   * about to receive it.
   *
   * Discards (rather than migrates) any interaction that was mid-flight on
   * the OUTGOING tab -- a rubber-band select box, a body drag, an in-flight
   * touch gesture/point-pick preview -- since none of that state means
   * anything once it's pointed at a different tab's entities/selection.
   * Matches Escape's own cleanup in onKeyDown for the same reason: switching
   * tabs is "abandon whatever gesture was in progress", not "carry it over".
   */
  setActiveSession(engine: Engine, viewport: Viewport): void {
    this.isPanning = false;
    this.dragEntities = null;
    this.dragLastPos = null;
    this.dragMoved = false;
    this.selectOrigin = null;
    this.selectCurrent = null;
    this.selectActive = false;
    this.selectAdditive = false;
    this.commandBuffer = "";
    this.activeTouches.clear();
    this.pendingTouch = null;
    this.touchGesture = null;
    this.touchPointPickPointerId = null;
    this.touchFingerScreenPos = null;
    this.touchCursorScreenPos = null;
    this.pendingCommandCandidate = null;
    this.pendingCommandTouch = null;

    this.engine = engine;
    this.viewport = viewport;
    this.requestRedraw();
  }

  /** Batches repaint requests into at most one per animation frame. */
  requestRedraw(): void {
    if (this.redrawScheduled) return;
    this.redrawScheduled = true;
    requestAnimationFrame(() => {
      this.redrawScheduled = false;
      this.render();
    });
  }

  private resizeToDisplaySize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    if (!this.homeInitialized && width > 0 && height > 0) {
      this.viewport.resetView();
      this.homeInitialized = true;
    }
    this.requestRedraw();
  }

  private eventToScreenPoint(e: PointerEvent | MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.viewport.zoomAtCursor(this.eventToScreenPoint(e), e.deltaY);
    this.requestRedraw();
  }

  // --- Pointer entry points: mouse/pen run the shared core directly
  // (unchanged behavior from before this was pointer-based); touch gets its
  // own gesture layer first -- see handleTouchPointerDown's doc comment. ---

  private onPointerDown(e: PointerEvent): void {
    // Keeps a drag/pan/pinch tracking correctly even if the pointer moves
    // outside the canvas mid-gesture. Deliberately swallowed on failure --
    // setPointerCapture can throw (e.g. NotFoundError if the browser no
    // longer considers this pointer id "active" by the time this runs) in
    // edge cases that shouldn't take down the rest of pointerdown handling
    // with it; capture is a robustness nicety here, not a correctness
    // requirement, since every handler below still works from the events
    // themselves regardless of whether capture actually took.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignored -- see comment above */
    }

    if (e.pointerType === "touch") {
      // Same focus-steal prevention as the commandActive check below, for
      // the same reason (see its own comment) -- without this, touching the
      // canvas to point-pick mid-command stole focus back from the command
      // bar's own input field (set by enableInput()/enableDualInput()) the
      // moment you touched down, since an unprevented pointerdown's default
      // "focus the touched element" step runs after every listener returns
      // regardless of pointer type. That silently broke typing a dynamic-
      // input value (keyboard OR the popup numpad) into a still-live command
      // right after a touch-driven point pick.
      if (this.engine.commandManager.currentCommand !== null) {
        e.preventDefault();
      }
      this.handleTouchPointerDown(e);
      return;
    }

    if (e.button === 1) {
      this.isPanning = true;
      this.lastPanScreenPos = this.eventToScreenPoint(e);
      this.canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }

    if (this.engine.commandManager.currentCommand !== null) {
      // Without this, a click that makes the active command call
      // commandBar.enableInput() (e.g. Leader's landing-point pick, or
      // Rectangle's corner pick before its width/height prompt) gets its
      // focus silently stolen right back: per spec, an unprevented
      // pointerdown's default "focus the clicked element" step runs AFTER
      // every pointerdown listener returns, so it fires after -- and
      // overrides -- enableInput()'s own focus() call inside runPointerDown.
      // The next keystroke then goes nowhere a command is reading from.
      e.preventDefault();
    }

    const worldPos = this.viewport.screenToWorld(this.eventToScreenPoint(e));
    this.runPointerDown(worldPos, e.button, e.shiftKey);
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.handleTouchPointerMove(e);
      return;
    }

    if (this.isPanning) {
      const current = this.eventToScreenPoint(e);
      const delta = { x: current.x - this.lastPanScreenPos.x, y: current.y - this.lastPanScreenPos.y };
      this.viewport.pan(delta);
      this.lastPanScreenPos = current;
      this.requestRedraw();
      return;
    }

    // clientX/clientY (page coordinates), not eventToScreenPoint's
    // canvas-local ones -- the floating dynamic-input tooltip is `position:
    // fixed`, so it needs the same coordinate space getBoundingClientRect()
    // itself is measured in.
    this.engine.commandBar.setTooltipPosition({ x: e.clientX, y: e.clientY });
    this.runPointerMove(this.viewport.screenToWorld(this.eventToScreenPoint(e)));
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.handleTouchPointerEnd(e);
      return;
    }

    if (e.button === 1) {
      this.isPanning = false;
      this.canvas.style.cursor = "crosshair";
      return;
    }

    if (e.button !== 0) return;
    this.runPointerUp();
  }

  private onPointerCancel(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.handleTouchPointerEnd(e);
      return;
    }
    // Defensive cleanup for mouse/pen -- the OS interrupted the gesture
    // (e.g. a stylus lifted out of hover range mid-drag); mirrors
    // mouseleave's own "abandon whatever was in progress" cleanup.
    this.isPanning = false;
    this.canvas.style.cursor = "crosshair";
    this.dragEntities = null;
    this.dragLastPos = null;
    this.dragMoved = false;
    this.selectOrigin = null;
    this.selectCurrent = null;
    this.selectActive = false;
    this.requestRedraw();
  }

  /**
   * Ported from graphics/canvas.py's mouseDoubleClickEvent(): a double-click
   * on a Text or Dimension entity edits its label content in place (see
   * commands/editText.ts). The browser only sends "dblclick" for the second
   * click of the pair -- the first already ran through the normal
   * onPointerDown/runPointerDown/applySelectionPick path, so the entity is
   * already selected by the time this fires.
   *
   * Mouse/pen only, deliberately: "dblclick" isn't part of this file's own
   * Pointer Events touch gesture layer (handleTouchPointerDown/Move/End) at
   * all, so this can't interfere with -- or need to account for -- the
   * two-phase aim/confirm touch model elsewhere in this file. A touch
   * double-tap equivalent is a separate future addition, not something this
   * change touches.
   */
  private onDoubleClick(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (this.engine.commandManager.currentCommand !== null) return; // don't interrupt an already-active command/gesture

    const worldPos = this.viewport.screenToWorld(this.eventToScreenPoint(e));
    const tolerance = this.engine.pickTolerance();
    for (const entity of this.engine.document.getEntities()) {
      if (!(entity instanceof Text || entity instanceof Dimension) || !entity.hitTest(worldPos, tolerance)) continue;

      this.engine.selection.clear();
      this.engine.selection.select(entity);
      // The first click of this double-click already armed a potential body
      // drag (see runPointerDown) -- disarm it so an in-progress edit isn't
      // fighting a live move on the next pointermove.
      this.dragEntities = null;
      this.dragLastPos = null;
      this.dragMoved = false;

      this.engine.commandManager.startCommand("edittext");
      const cmd = this.engine.commandManager.currentCommand as GripCommand | null;
      cmd?.begin(entity, null);
      break;
    }
    this.requestRedraw();
  }

  // --- Shared pointer core: identical to this file's own pre-touch mouse
  // handling, just re-entered by name instead of inline in onPointerDown/
  // Move/Up. Mouse/pen call this directly; touch calls it once a gesture
  // actually commits (a tap on release, or a drag past the move threshold). ---

  private runPointerDown(worldPos: Point, button: number, shiftHeld: boolean): void {
    const commandActive = this.engine.commandManager.currentCommand !== null;

    if (commandActive) {
      if (button === 0) this.engine.commandManager.leftClick(worldPos);
      else if (button === 2) this.engine.commandManager.rightClick(worldPos);
      this.engine.commandBar.enableInput();
      this.requestRedraw();
      return;
    }

    if (button !== 0) return; // no command active: only the primary button/touch drives selection/grips

    const tolerance = this.engine.pickTolerance();
    const gripHit = gripAt(this.engine.selection, worldPos, tolerance);
    const hit = entityAt(this.engine.document.getEntities(), worldPos, tolerance);

    // A grip only wins when it belongs to the entity the click actually lands
    // on (or nothing else is there) -- e.g. the shared corner of two
    // connected lines, where the OTHER line's endpoint grip sits at the
    // exact same point as the selected line's own grip. Without this, that
    // click always re-grabs the already-selected line's grip and clicking
    // the neighboring line to select it becomes impossible from there.
    if (gripHit !== null && (hit === null || hit === gripHit.entity)) {
      this.engine.activeConstraintId = null;
      const commandName = GRIP_COMMAND_NAMES[gripHit.kind];
      this.engine.commandManager.startCommand(commandName);
      const grip = this.engine.commandManager.currentCommand as GripCommand | null;
      grip?.begin(gripHit.entity, gripHit.extra);
      this.requestRedraw();
      return;
    }

    if (hit !== null) {
      this.engine.activeConstraintId = null;
      this.applySelectionPick(hit, shiftHeld);
      if (!shiftHeld) {
        this.dragEntities = this.engine.selection.getEntities();
        this.dragLastPos = worldPos;
        this.dragMoved = false;
      }
    } else {
      // Only checked once a normal entity/grip hit-test comes up empty, so a
      // faint constraint line never steals a click away from real geometry
      // it happens to run alongside (see core/constraints.ts's constraintAt).
      const constraint = constraintAt(this.engine.document, worldPos, tolerance);
      if (constraint !== null) {
        this.engine.selection.clear();
        this.engine.quickEdit.refreshStatus();
        this.engine.activeConstraintId = constraint.id;
      } else {
        this.engine.activeConstraintId = null;
        this.selectOrigin = worldPos;
        this.selectCurrent = worldPos;
        this.selectActive = false;
        this.selectAdditive = shiftHeld;
      }
    }

    this.requestRedraw();
  }

  private applySelectionPick(entity: Entity, shiftHeld: boolean): void {
    if (shiftHeld) {
      if (this.engine.selection.isSelected(entity)) {
        this.engine.selection.deselect(entity);
      } else {
        this.engine.selection.select(entity);
      }
    } else {
      this.engine.selection.clear();
      this.engine.selection.select(entity);
    }
    this.engine.quickEdit.refreshStatus();
  }

  private runPointerMove(worldPos: Point): void {
    if (this.dragEntities !== null && this.dragLastPos !== null) {
      const delta = { x: worldPos.x - this.dragLastPos.x, y: worldPos.y - this.dragLastPos.y };
      if (!this.dragMoved) {
        const threshold = this.engine.pickTolerance(3.0);
        if (Math.abs(delta.x) < threshold && Math.abs(delta.y) < threshold) {
          return; // sub-threshold jitter -- don't pollute undo with a no-op click
        }
        this.engine.undo.push(this.engine.document.toDict());
        this.dragMoved = true;
      }
      for (const entity of this.dragEntities) entity.move(delta.x, delta.y);
      this.dragLastPos = worldPos;
      this.requestRedraw();
      return;
    }

    if (this.selectOrigin !== null) {
      this.selectCurrent = worldPos;
      this.selectActive = true;
      this.requestRedraw();
      return;
    }

    this.engine.commandManager.mouseMove(worldPos);
    this.requestRedraw();
  }

  private runPointerUp(): void {
    if (this.dragEntities !== null) {
      this.dragEntities = null;
      this.dragLastPos = null;
      this.dragMoved = false;
      return;
    }

    if (this.selectOrigin !== null) {
      if (this.selectActive) {
        this.finishBoxSelect();
      } else if (!this.selectAdditive) {
        this.engine.selection.clear();
        this.engine.quickEdit.refreshStatus();
      }
      this.selectOrigin = null;
      this.selectCurrent = null;
      this.selectActive = false;
      this.requestRedraw();
    }
  }

  // --- Touch gesture layer ---
  //
  // One finger: deferred tap/drag. A touch's "down" doesn't immediately call
  // runPointerDown() the way mouse/pen does -- it's held as `pendingTouch`
  // until EITHER it moves past TOUCH_DRAG_THRESHOLD_PX (commits to a drag,
  // replaying runPointerDown at the ORIGINAL touch point so the drag starts
  // from where the finger actually landed, then immediately feeding in the
  // current position so it continues with no visible jump) OR it lifts
  // first (a tap: runPointerDown+runPointerUp back to back, exactly like a
  // quick mouse click) OR a second finger arrives, in which case it's
  // discarded outright -- nothing was ever committed, so there's nothing to
  // undo. Without this deferral, the ordinary two-finger pinch gesture's
  // first finger would fire a spurious point-pick/selection click every time
  // before the second finger's pointerdown even arrives.
  //
  // Two fingers: pan by the midpoint's own movement and zoom (pinch) around
  // that same midpoint, every move -- never reaches runPointerDown/Move/Up
  // at all, so it can never interfere with an active command. Dropping back
  // to fewer than 2 fingers simply ends the gesture; it does not resume
  // single-touch tracking with whichever finger remains (the same
  // conservative choice most touch drawing/map apps make).
  //
  // One finger while a command is actively awaiting a point (point-picking,
  // e.g. Line's next vertex): a two-phase AIM / CONFIRM model, not a tap-or-
  // drag deferral like the plain-selection case above -- a fingertip
  // inevitably covers the very thing it's pointing at, so a touch-driven
  // point-pick previews (offset cursor, see offsetTouchCursor()) but never
  // commits on its own lift. Lifting just freezes the preview in place as
  // `pendingCommandCandidate`, staying visible so you can look at it,
  // uncovered, before deciding. That candidate is committed only by:
  //   - a LATER touch (resolveCommandTouch()) -- using the candidate's own
  //     stored position, never that new touch's -- which then immediately
  //     starts aiming the NEXT step with that same touch, so a whole
  //     multi-point command chains as one continuous aim-confirm-aim-confirm
  //     motion; or
  //   - a typed dynamic-input value submitted via the command bar
  //     (discardInFlightTouchPointPick(), called from main.ts).
  // Resolving "is this new touch a genuine single-finger confirm, or the
  // first finger of an incoming pinch" uses the exact same deferred-
  // threshold mechanism as pendingTouch above (pendingCommandTouch), for the
  // same reason: unconditionally confirming on raw pointerdown would fire a
  // spurious commit the instant a pinch's first finger lands.

  private handleTouchPointerDown(e: PointerEvent): void {
    const screenPos = this.eventToScreenPoint(e);
    this.activeTouches.set(e.pointerId, screenPos);

    if (this.activeTouches.size === 1) {
      if (this.engine.commandManager.currentCommand !== null) {
        this.pendingCommandTouch = { pointerId: e.pointerId, screenPos, worldPos: this.viewport.screenToWorld(screenPos) };
        return;
      }
      this.pendingTouch = { pointerId: e.pointerId, screenPos, worldPos: this.viewport.screenToWorld(screenPos) };
      return;
    }

    if (this.activeTouches.size === 2) {
      this.pendingTouch = null;
      this.pendingCommandTouch = null;
      this.freezeActiveTouchPointPick();
      this.abortSingleTouchInteraction();
      const [a, b] = [...this.activeTouches.values()] as [Point, Point];
      this.touchGesture = { midpoint: midpointOf(a, b), distance: pointDistance(a, b) };
      this.requestRedraw();
    }
    // 3rd+ finger: ignored -- an existing 2-finger gesture, if any, keeps going untouched.
  }

  private handleTouchPointerMove(e: PointerEvent): void {
    if (!this.activeTouches.has(e.pointerId)) return;
    this.activeTouches.set(e.pointerId, this.eventToScreenPoint(e));

    if (this.touchPointPickPointerId === e.pointerId) {
      this.updateTouchPointPickPreview(this.eventToScreenPoint(e));
      return;
    }

    if (this.pendingCommandTouch !== null && this.pendingCommandTouch.pointerId === e.pointerId) {
      const currentScreen = this.eventToScreenPoint(e);
      if (pointDistance(currentScreen, this.pendingCommandTouch.screenPos) < TOUCH_DRAG_THRESHOLD_PX) return;
      this.pendingCommandTouch = null;
      this.resolveCommandTouch();
      this.touchPointPickPointerId = e.pointerId;
      this.updateTouchPointPickPreview(currentScreen);
      return;
    }

    if (this.touchGesture !== null) {
      const pts = [...this.activeTouches.values()];
      if (pts.length < 2) return; // ended via pointerup below; ignore any late move for the survivor
      const [a, b] = pts as [Point, Point];
      const newMid = midpointOf(a, b);
      const newDist = pointDistance(a, b);

      this.viewport.pan({ x: newMid.x - this.touchGesture.midpoint.x, y: newMid.y - this.touchGesture.midpoint.y });
      if (this.touchGesture.distance > 1e-6) {
        this.viewport.zoomByFactor(newMid, newDist / this.touchGesture.distance);
      }
      this.touchGesture = { midpoint: newMid, distance: newDist };
      this.requestRedraw();
      return;
    }

    if (this.pendingTouch !== null && this.pendingTouch.pointerId === e.pointerId) {
      const currentScreen = this.eventToScreenPoint(e);
      if (pointDistance(currentScreen, this.pendingTouch.screenPos) < TOUCH_DRAG_THRESHOLD_PX) return;

      const { worldPos } = this.pendingTouch;
      this.pendingTouch = null;
      this.runPointerDown(worldPos, 0, false);
      this.runPointerMove(this.viewport.screenToWorld(currentScreen));
      return;
    }

    // An already-committed single-touch drag/select/command-point-tracking.
    this.runPointerMove(this.viewport.screenToWorld(this.eventToScreenPoint(e)));
  }

  private handleTouchPointerEnd(e: PointerEvent): void {
    const wasTracked = this.activeTouches.delete(e.pointerId);
    if (!wasTracked) return;

    if (this.touchPointPickPointerId === e.pointerId) {
      // An ordinary lift at the end of an active aim: freeze wherever the
      // preview currently is as the new pending candidate. Deliberately
      // does NOT commit -- see this section's own header comment.
      this.touchPointPickPointerId = null;
      if (this.touchCursorScreenPos !== null) {
        this.pendingCommandCandidate = this.viewport.screenToWorld(this.touchCursorScreenPos);
      }
      this.requestRedraw();
      return;
    }

    if (this.pendingCommandTouch !== null && this.pendingCommandTouch.pointerId === e.pointerId) {
      // A plain tap (never moved past the drag threshold): resolves exactly
      // like a drag would -- confirms whatever was PREVIOUSLY pending using
      // its own stored position, then freezes this tap's own (undragged)
      // position as the new pending candidate, rather than committing it
      // immediately, for the same "look before you commit" reason as a drag.
      const { screenPos } = this.pendingCommandTouch;
      this.pendingCommandTouch = null;
      this.resolveCommandTouch();
      if (this.engine.commandManager.currentCommand !== null) {
        this.touchFingerScreenPos = screenPos;
        this.touchCursorScreenPos = this.offsetTouchCursor(screenPos);
        this.engine.commandManager.mouseMove(this.viewport.screenToWorld(this.touchCursorScreenPos));
        this.pendingCommandCandidate = this.viewport.screenToWorld(this.touchCursorScreenPos);
      }
      this.requestRedraw();
      return;
    }

    if (this.touchGesture !== null) {
      if (this.activeTouches.size < 2) this.touchGesture = null;
      return;
    }

    if (this.pendingTouch !== null && this.pendingTouch.pointerId === e.pointerId) {
      const { worldPos } = this.pendingTouch;
      this.pendingTouch = null;
      this.runPointerDown(worldPos, 0, false);
      this.runPointerUp();
      return;
    }

    this.runPointerUp();
  }

  /** Feeds the OFFSET preview position (never the raw fingertip) into the
   *  active command's mouseMove(), so its existing live-preview/snap-marker
   *  drawing already renders at the right place with no changes of its own. */
  private updateTouchPointPickPreview(fingerScreenPos: Point): void {
    this.touchFingerScreenPos = fingerScreenPos;
    this.touchCursorScreenPos = this.offsetTouchCursor(fingerScreenPos);
    this.engine.commandManager.mouseMove(this.viewport.screenToWorld(this.touchCursorScreenPos));
    this.requestRedraw();
  }

  private offsetTouchCursor(fingerScreenPos: Point): Point {
    const raised = fingerScreenPos.y - TOUCH_CURSOR_OFFSET_PX;
    const y = raised < TOUCH_CURSOR_TOP_MARGIN_PX ? fingerScreenPos.y + TOUCH_CURSOR_OFFSET_PX : raised;
    return { x: fingerScreenPos.x, y };
  }

  /** Commits whatever candidate was left pending from the PREVIOUS point-pick
   *  step (if any) using ITS stored position -- never the new touch that
   *  triggered this -- so that touch is free to immediately start aiming the
   *  step that follows. A no-op the first time a command asks for a point,
   *  when nothing is pending yet, and if the command was cancelled (e.g.
   *  Escape) while the candidate sat pending -- there's nothing left to
   *  confirm into. */
  private resolveCommandTouch(): void {
    if (this.pendingCommandCandidate === null) return;
    const candidate = this.pendingCommandCandidate;
    this.pendingCommandCandidate = null;
    if (this.engine.commandManager.currentCommand === null) return;
    this.runPointerDown(candidate, 0, false);
  }

  /** Freezes whatever's currently being actively aimed (if anything) as the
   *  pending candidate, exactly as an ordinary lift would -- used when a
   *  second finger interrupts an in-progress aim to start a pinch, so the
   *  in-progress aim is paused, not lost (mirrors abortSingleTouchInteraction's
   *  own "whatever happened stays applied" precedent for plain drags). */
  private freezeActiveTouchPointPick(): void {
    if (this.touchPointPickPointerId === null) return;
    if (this.touchCursorScreenPos !== null) {
      this.pendingCommandCandidate = this.viewport.screenToWorld(this.touchCursorScreenPos);
    }
    this.touchPointPickPointerId = null;
  }

  /** Call whenever a point/value commits some way OTHER than this touch
   *  layer's own aim/confirm flow -- currently: typing a value into the
   *  command bar (physical keyboard or the popup numpad) and submitting it,
   *  whether that lands mid-aim (a finger still down) or with a candidate
   *  already frozen pending confirmation. Either way, fully clears this
   *  touch layer's point-pick state so it doesn't linger visually (a stale
   *  frozen ghost) or double-fire (a stray extra commit) the next time a
   *  finger touches the canvas. Safe to call unconditionally (main.ts does,
   *  on every submitted value): a no-op whenever none of this state is set,
   *  e.g. every desktop mouse/keyboard submission. */
  discardInFlightTouchPointPick(): void {
    if (this.touchPointPickPointerId !== null) this.activeTouches.delete(this.touchPointPickPointerId);
    if (this.pendingCommandTouch !== null) this.activeTouches.delete(this.pendingCommandTouch.pointerId);
    const hadSomething =
      this.touchPointPickPointerId !== null || this.pendingCommandTouch !== null || this.pendingCommandCandidate !== null;
    this.touchPointPickPointerId = null;
    this.pendingCommandTouch = null;
    this.pendingCommandCandidate = null;
    this.touchFingerScreenPos = null;
    this.touchCursorScreenPos = null;
    if (hadSomething) this.requestRedraw();
  }

  /** Cleanly abandons an in-progress single-touch drag/box-select the moment
   *  a second finger arrives to start a pinch -- e.g. dragging an entity
   *  with one finger, then accidentally touching a second finger down.
   *  Whatever movement already happened stays applied (same as releasing
   *  the finger right there); this doesn't attempt to also undo it. */
  private abortSingleTouchInteraction(): void {
    this.dragEntities = null;
    this.dragLastPos = null;
    this.dragMoved = false;
    this.selectOrigin = null;
    this.selectCurrent = null;
    this.selectActive = false;
  }

  private finishBoxSelect(): void {
    if (this.selectOrigin === null || this.selectCurrent === null) return;
    const x0 = Math.min(this.selectOrigin.x, this.selectCurrent.x);
    const x1 = Math.max(this.selectOrigin.x, this.selectCurrent.x);
    const y0 = Math.min(this.selectOrigin.y, this.selectCurrent.y);
    const y1 = Math.max(this.selectOrigin.y, this.selectCurrent.y);
    const leftToRight = this.selectCurrent.x >= this.selectOrigin.x;

    if (!this.selectAdditive) this.engine.selection.clear();

    for (const entity of this.engine.document.getEntities()) {
      const [ex0, ey0, ex1, ey1] = entity.getBounds();
      const hit = leftToRight
        ? ex0 >= x0 && ex1 <= x1 && ey0 >= y0 && ey1 <= y1 // window: fully enclosed
        : ex0 <= x1 && ex1 >= x0 && ey0 <= y1 && ey1 >= y0; // crossing: any overlap
      if (hit) this.engine.selection.select(entity);
    }
    this.engine.quickEdit.refreshStatus();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "F8") {
      this.engine.toggleOrtho();
      e.preventDefault();
      this.requestRedraw();
      return;
    }

    if (e.key === "Escape") {
      this.engine.cancelCommand(); // also clears snap feedback -- see engine/engine.ts
      this.commandBuffer = "";
      this.engine.selection.clear();
      this.selectOrigin = null;
      this.selectCurrent = null;
      this.selectActive = false;
      this.dragEntities = null;
      this.dragLastPos = null;
      this.dragMoved = false;
      this.engine.commandBar.setReady();
      this.engine.quickEdit.refreshStatus();
      e.preventDefault();
      this.requestRedraw();
      return;
    }

    const commandActive = this.engine.commandManager.currentCommand !== null;

    if (commandActive) {
      this.engine.commandManager.keyPress(e.key);
      return;
    }

    // Copy/paste, READY state only (matches Delete/Escape's own "only at
    // rest" convention below) -- Ctrl or Cmd so this works the same on
    // Windows/Linux and macOS. engine/clipboard.ts is plain module state
    // shared across every tab (engine/session.ts), not the browser's real
    // system clipboard, so this is how a selection made in one tab gets
    // pasted into another: copy here, switch tabs, paste there -- `this.engine`
    // is always whichever tab is currently active (see setActiveSession()).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "c") {
      copySelection(this.engine);
      e.preventDefault();
      this.requestRedraw();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v") {
      pasteClipboard(this.engine);
      e.preventDefault();
      this.requestRedraw();
      return;
    }

    if (e.key === " " || e.code === "Space") {
      // Zoom Extents -- same as the Home/Zoom Extents toolbar button.
      this.engine.zoomExtents();
      e.preventDefault();
      return;
    }

    // READY state: no command owns the keyboard, so plain keystrokes build a
    // typed command-line entry -- unless exactly one Line/Text is selected,
    // in which case digits/math instead feed a live length/size quick-edit
    // buffer (see engine/quickEdit.ts). Checked ahead of the plain typed-
    // command buffer and Delete handling below, matching graphics/canvas.py's
    // own keyPressEvent ordering.
    const quickEditTarget = this.engine.quickEdit.target();

    if (e.key === "Enter") {
      e.preventDefault();
      if (quickEditTarget !== null && this.engine.quickEdit.hasBuffer()) {
        this.engine.quickEdit.submit(quickEditTarget);
      } else if (this.commandBuffer !== "") {
        this.engine.commandManager.tryStartFromText(this.commandBuffer);
        this.commandBuffer = "";
      } else {
        this.engine.commandManager.repeatLast();
      }
      this.requestRedraw();
      return;
    }

    if (e.key === "Backspace" && quickEditTarget !== null && this.engine.quickEdit.backspace(quickEditTarget)) {
      e.preventDefault();
      return;
    }

    if (e.key === "Backspace" && this.commandBuffer !== "") {
      this.commandBuffer = this.commandBuffer.slice(0, -1);
      this.engine.commandBar.setTypedCommand(this.commandBuffer);
      e.preventDefault();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      this.engine.deleteSelected();
      e.preventDefault();
      this.requestRedraw();
      return;
    }

    if (quickEditTarget !== null && this.engine.quickEdit.handleChar(e.key, quickEditTarget)) {
      e.preventDefault();
      return;
    }

    if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.commandBuffer += e.key.toLowerCase();
      this.engine.commandBar.setTypedCommand(this.commandBuffer);
      e.preventDefault();
    }
  }

  /** AutoCAD-style UCS icon: sits on the origin while it's on screen,
   *  otherwise parks in the bottom-left corner -- so you always know which
   *  way X/Y (or the sketch plane's own axes) run. */
  private drawUcsIcon(): void {
    const ctx = this.ctx;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const SIZE = 38;
    const MARGIN = 28;
    const o = this.viewport.worldToScreen({ x: 0, y: 0 });
    const onScreen = o.x >= MARGIN && o.x <= width - SIZE - MARGIN && o.y >= SIZE + MARGIN && o.y <= height - MARGIN;
    const x = onScreen ? o.x : MARGIN;
    const y = onScreen ? o.y : height - MARGIN;
    const [xLabel, yLabel] = this.engine.ucsLabels;

    ctx.save();
    ctx.strokeStyle = "rgba(220, 220, 220, 0.85)";
    ctx.fillStyle = "rgba(220, 220, 220, 0.85)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + SIZE, y);
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - SIZE);
    ctx.stroke();
    ctx.strokeRect(x - 3, y - 3, 6, 6);
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(xLabel, x + SIZE + 4, y);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(yLabel, x, y - SIZE - 3);
    ctx.restore();
  }

  /** Engine.underlay: reference geometry (e.g. a projected 3D solid),
   *  dimmed so it reads as "not part of this drawing". */
  private drawUnderlay(): void {
    const underlay = this.engine.underlay;
    if (underlay.length === 0) return;
    this.ctx.save();
    this.ctx.globalAlpha = 0.35;
    for (const entity of underlay) entity.draw(this.ctx, this.viewport);
    this.ctx.restore();
  }

  private render(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ctx = this.ctx;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    this.drawGrid();
    this.drawUnderlay();
    this.drawEntities();
    this.drawConstraints();
    this.drawSelectionHighlights();
    this.drawSelectionBox();
    this.engine.commandManager.draw(this.ctx);
    this.drawSnapMarker();
    this.drawUcsIcon();
    this.drawTouchOffsetCursor();

    ctx.restore();
  }

  /** The touch point-pick preview cursor itself (see
   *  handleTouchPointerDown's doc comment): a crosshair at the OFFSET
   *  position -- not the fingertip -- so it's unambiguous which glyph is the
   *  actual pick location while the fingertip itself covers that spot.
   *  Drawn last, on top of the ordinary snap marker (which lands at
   *  essentially the same spot whenever a snap is active), so it's never
   *  hidden by anything. Two visually distinct states: while a finger is
   *  actively aiming it (touchPointPickPointerId set), a hollow crosshair
   *  plus a dashed connector back to the real fingertip; once frozen
   *  awaiting confirmation (the finger has lifted, nothing connects to it
   *  any more), a filled center dot instead -- a "tap or type to confirm"
   *  affordance that needs no separate text/UI chrome. */
  private drawTouchOffsetCursor(): void {
    if (this.touchCursorScreenPos === null) return;
    const { x, y } = this.touchCursorScreenPos;
    const isActive = this.touchPointPickPointerId !== null;
    const ctx = this.ctx;

    ctx.save();

    if (isActive && this.touchFingerScreenPos !== null) {
      const finger = this.touchFingerScreenPos;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(finger.x, finger.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(80, 160, 255, 0.25)";
      ctx.beginPath();
      ctx.arc(finger.x, finger.y, 14, 0, Math.PI * 2);
      ctx.fill();
    }

    const half = 11;
    ctx.strokeStyle = "#50a0ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - half, y);
    ctx.lineTo(x + half, y);
    ctx.moveTo(x, y - half);
    ctx.lineTo(x, y + half);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, half * 0.55, 0, Math.PI * 2);
    if (!isActive) {
      ctx.fillStyle = "#50a0ff";
      ctx.fill();
    }
    ctx.stroke();

    ctx.restore();
  }

  /** Distinct glyph per osnap type, drawn at a fixed on-screen pixel size
   *  regardless of zoom, matching the desktop app's own marker set. */
  private drawSnapMarker(): void {
    const point = this.engine.activeSnapPoint;
    const type = this.engine.activeSnapType;
    if (point === null || type === null) return;

    const { x, y } = this.viewport.worldToScreen(point);
    const half = SNAP_MARKER_SCREEN_SIZE / 2;
    const ctx = this.ctx;

    ctx.save();
    ctx.strokeStyle = COLOR_SNAP_MARKER;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([]);

    switch (type) {
      case "ENDPOINT":
        ctx.strokeRect(x - half, y - half, SNAP_MARKER_SCREEN_SIZE, SNAP_MARKER_SCREEN_SIZE);
        break;
      case "MIDPOINT":
        ctx.beginPath();
        ctx.moveTo(x, y - half);
        ctx.lineTo(x - half, y + half);
        ctx.lineTo(x + half, y + half);
        ctx.closePath();
        ctx.stroke();
        break;
      case "CENTER":
        ctx.beginPath();
        ctx.arc(x, y, half * 0.85, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "QUADRANT":
        ctx.beginPath();
        ctx.moveTo(x, y - half);
        ctx.lineTo(x + half, y);
        ctx.lineTo(x, y + half);
        ctx.lineTo(x - half, y);
        ctx.closePath();
        ctx.stroke();
        break;
      case "INTERSECTION":
        ctx.beginPath();
        ctx.moveTo(x - half, y - half);
        ctx.lineTo(x + half, y + half);
        ctx.moveTo(x + half, y - half);
        ctx.lineTo(x - half, y + half);
        ctx.stroke();
        break;
      case "PERPENDICULAR":
        ctx.strokeRect(x - half, y - half, SNAP_MARKER_SCREEN_SIZE, SNAP_MARKER_SCREEN_SIZE);
        ctx.beginPath();
        ctx.moveTo(x - half, y);
        ctx.lineTo(x - half + half * 0.6, y);
        ctx.lineTo(x - half + half * 0.6, y - half * 0.6);
        ctx.stroke();
        break;
      case "TANGENT":
        ctx.beginPath();
        ctx.arc(x, y, half, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - half, y + half);
        ctx.lineTo(x + half, y + half);
        ctx.stroke();
        break;
      default: // NEAREST / unstyled fallback -- plain crosshair
        ctx.beginPath();
        ctx.moveTo(x - half, y);
        ctx.lineTo(x + half, y);
        ctx.moveTo(x, y - half);
        ctx.lineTo(x, y + half);
        ctx.stroke();
        break;
    }

    ctx.restore();
  }

  private drawEntities(): void {
    const visible = this.viewport.visibleWorldRect();
    for (const entity of this.engine.document.getEntities()) {
      if (entityVisible(entity.getBounds(), visible)) {
        entity.draw(this.ctx, this.viewport, false);
      }
    }
  }

  /** Every distance constraint (core/constraints.ts) as a dashed line from
   *  its driven point feature to its reference -- the currently-picked one
   *  (Engine.activeConstraintId, set in runPointerDown's own fallback pick)
   *  drawn brighter/thicker, matching the desktop app's own selected-
   *  constraint highlight on graphics/canvas.py. */
  private drawConstraints(): void {
    const constraints = this.engine.document.constraints as Constraint[];
    if (constraints.length === 0) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([5, 4]);
    for (const constraint of constraints) {
      const pts = constraintLinePoints(this.engine.document, constraint);
      if (pts === null) continue;
      const active = constraint.id === this.engine.activeConstraintId;
      const [p1, p2] = pts;
      const a = this.viewport.worldToScreen(p1);
      const b = this.viewport.worldToScreen(p2);

      ctx.strokeStyle = active ? COLOR_CONSTRAINT_ACTIVE : COLOR_CONSTRAINT;
      ctx.lineWidth = active ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSelectionHighlights(): void {
    for (const entity of this.engine.selection.getEntities()) {
      entity.drawSelected(this.ctx, this.viewport);
    }
  }

  private drawSelectionBox(): void {
    if (!this.selectActive || this.selectOrigin === null || this.selectCurrent === null) return;
    const leftToRight = this.selectCurrent.x >= this.selectOrigin.x;
    const color = leftToRight ? COLOR_WINDOW_SELECT : COLOR_CROSSING_SELECT;

    const p1 = this.viewport.worldToScreen(this.selectOrigin);
    const p2 = this.viewport.worldToScreen(this.selectCurrent);
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);

    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash(leftToRight ? [] : [4, 4]);
    this.ctx.fillStyle = color.replace("1)", "0.15)");
    this.ctx.fillRect(x, y, w, h);
    this.ctx.strokeRect(x, y, w, h);
    this.ctx.restore();
  }

  private drawGrid(): void {
    const { verticals, horizontals } = computeGridLines(this.viewport);
    const ctx = this.ctx;
    const height = this.canvas.clientHeight;
    const width = this.canvas.clientWidth;

    ctx.lineWidth = 1;

    for (const { x, isAxis } of verticals) {
      const sx = this.viewport.worldToScreen({ x, y: 0 }).x;
      ctx.strokeStyle = isAxis ? COLOR_AXIS : COLOR_GRID;
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, 0);
      ctx.lineTo(sx + 0.5, height);
      ctx.stroke();
    }

    for (const { y, isAxis } of horizontals) {
      const sy = this.viewport.worldToScreen({ x: 0, y }).y;
      ctx.strokeStyle = isAxis ? COLOR_AXIS : COLOR_GRID;
      ctx.beginPath();
      ctx.moveTo(0, sy + 0.5);
      ctx.lineTo(width, sy + 0.5);
      ctx.stroke();
    }
  }
}

function entityVisible(entityBounds: Bounds, visibleRect: Bounds): boolean {
  const [ex0, ey0, ex1, ey1] = entityBounds;
  const [vx0, vy0, vx1, vy1] = visibleRect;
  return ex1 >= vx0 && ex0 <= vx1 && ey1 >= vy0 && ey0 <= vy1;
}
