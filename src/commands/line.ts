/**
 * MinimalCAD Web
 * commands/line.ts
 *
 * Ported from commands/line.py: multi-segment continuous line chaining --
 * after each committed segment, state loops back to "pick next point" (not
 * back to "pick first point"), so consecutive clicks trace a connected
 * polyline of independent Line entities without re-invoking the tool.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Line } from "../entities/line";
import { evalNumber, parsePoint } from "../input/dynamicInput";
import { drawAngleReferenceAxis, drawPolarTrackingRay } from "../ui/dynamicInputOverlay";

export class LineCommand extends BaseCommand {
  private state: 0 | 1 = 0;
  private startPoint: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.startPoint = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("LINE", "Pick First Point (or type x,y)");
    this.commandBar.disableDualInput();
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  private currentAngle(): number {
    if (this.startPoint === null || this.currentMousePos === null) return 0;
    const dx = this.currentMousePos.x - this.startPoint.x;
    const dy = this.currentMousePos.y - this.startPoint.y;
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.startPoint = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("LINE", "Pick Next Point (Tab: Distance -> Angle, Enter to commit)");
      this.commandBar.enableDualInput("0.00", "0.0");
      this.engine.requestRedraw();
    } else {
      const { point, snapType } = this.engine.snap(worldPos, this.startPoint);
      const resolved = snapType === null ? this.engine.applyOrtho(this.startPoint!, point) : point;
      this.commitNextPoint(resolved);
    }
  }

  private commitNextPoint(worldPos: Point): void {
    const snapshotBefore = this.document.toDict();
    this.document.addEntity(new Line(this.startPoint!, worldPos));
    this.undo.push(snapshotBefore);

    this.startPoint = worldPos;
    this.currentMousePos = worldPos;
    this.state = 1;
    this.commandBar.setStatus("LINE", "Pick Next Point (Tab: Distance -> Angle, Enter to commit)");
    this.commandBar.enableDualInput("0.00", "0.0");
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    const reference = this.state === 1 ? this.startPoint : null;
    const { point, snapType } = this.engine.snap(worldPos, reference);
    const resolved =
      this.state === 1 && snapType === null ? this.engine.applyOrtho(this.startPoint!, point) : point;
    this.currentMousePos = resolved;

    if (this.state !== 1 || this.startPoint === null) return;

    const dx = this.currentMousePos.x - this.startPoint.x;
    const dy = this.currentMousePos.y - this.startPoint.y;
    const distance = Math.hypot(dx, dy);
    // Unsigned deviation from the horizontal reference axis (drawn in
    // draw()), in [0, 180]: folds "above" and "below" the axis onto the
    // same reading (Math.abs(dy)) instead of one side wrapping around to a
    // 300s-looking complement -- the ghost line itself already shows which
    // side you're on, so the number never needs a sign either way.
    const displayAngleDeg = (Math.atan2(Math.abs(dy), dx) * 180) / Math.PI;
    this.commandBar.setLiveValue(distance.toFixed(2));
    this.commandBar.setLiveAngle(displayAngleDeg.toFixed(1));
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 0) {
      const point = parsePoint(text, null);
      if (point === null) {
        this.commandBar.setStatus("LINE", "Invalid point - use x,y");
        return;
      }
      this.startPoint = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("LINE", "Pick Next Point (Tab: Distance -> Angle, Enter to commit)");
      this.commandBar.enableDualInput("0.00", "0.0");
    } else {
      const point = this.resolveTypedNextPoint(text);
      if (point === null) {
        this.commandBar.setStatus("LINE", "Invalid - use x,y, dist<angle, or a bare distance");
        return;
      }
      this.commitNextPoint(point);
    }
  }

  /**
   * The live angle readout (mouseMove()) is an unsigned magnitude off the
   * horizontal reference axis, not a signed bearing -- committing it as-is
   * via Enter (dual-input's "dist<angle" grammar) would always resolve to
   * the same side regardless of which one the ghost line was actually
   * showing. Applying the CURRENT drag side (above/below that axis) to a
   * bare "dist<angle" submission's angle fixes that; anything else (x,y,
   * a bare distance) parses unchanged.
   */
  private resolveTypedNextPoint(text: string): Point | null {
    const t = text.trim();
    const sepIdx = t.indexOf("<");
    if (sepIdx !== -1 && this.startPoint !== null && this.currentMousePos !== null) {
      const angleMag = evalNumber(t.slice(sepIdx + 1));
      if (angleMag !== null) {
        // Above the start (smaller world y, since world is Y-down) = positive angle.
        const side = this.currentMousePos.y < this.startPoint.y ? 1 : -1;
        return parsePoint(`${t.slice(0, sepIdx)}<${angleMag * side}`, this.startPoint, this.currentAngle());
      }
    }
    return parsePoint(t, this.startPoint, this.currentAngle());
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state !== 1 || this.startPoint === null || this.currentMousePos === null) return;
    drawAngleReferenceAxis(ctx, this.engine.viewport, this.startPoint);
    const ghost = new Line(this.startPoint, this.currentMousePos);
    ghost.draw(ctx, this.engine.viewport, true);
    drawPolarTrackingRay(ctx, this.engine.viewport, this.startPoint, this.currentMousePos);
  }

  cancel(): void {
    this.state = 0;
    this.startPoint = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
