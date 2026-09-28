/**
 * MinimalCAD Web
 * commands/ellipse.ts
 *
 * Ported from commands/ellipse.py: three-click Center/Major-Axis/Minor-Axis
 * ellipse creation, matching AutoCAD's classic ELLIPSE "Center" method --
 * pick the center, pick the end of one axis (sets that axis's length AND
 * the ellipse's rotation together, same distance/angle typed-input
 * convention as Line's next point), then pick a perpendicular distance for
 * the other axis (or type a plain positive number directly).
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Ellipse } from "../entities/ellipse";
import { Line } from "../entities/line";
import { parsePoint, parsePositiveFloat } from "../input/dynamicInput";

export class EllipseCommand extends BaseCommand {
  private state: 0 | 1 | 2 = 0;
  private center: Point | null = null;
  private majorPoint: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.center = null;
    this.majorPoint = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("ELLIPSE", "Pick Center Point (or type x,y)");
    this.commandBar.disableDualInput();
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  private currentAngle(): number {
    if (this.center === null || this.currentMousePos === null) return 0;
    const dx = this.currentMousePos.x - this.center.x;
    const dy = this.currentMousePos.y - this.center.y;
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx);
  }

  private rotationAngle(): number {
    const dx = this.majorPoint!.x - this.center!.x;
    const dy = this.majorPoint!.y - this.center!.y;
    return Math.atan2(dy, dx);
  }

  private radiusX(): number {
    return Math.hypot(this.majorPoint!.x - this.center!.x, this.majorPoint!.y - this.center!.y);
  }

  /** Perpendicular distance from `pos` to the major-axis line through the
   *  center -- state 2's live/committed minor radius, regardless of how far
   *  along the major-axis direction the pick actually lands. */
  private minorRadiusAt(pos: Point): number {
    const rotation = this.rotationAngle();
    const nx = -Math.sin(rotation);
    const ny = Math.cos(rotation);
    const dx = pos.x - this.center!.x;
    const dy = pos.y - this.center!.y;
    return Math.abs(dx * nx + dy * ny);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.center = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("ELLIPSE", "Pick Major Axis Endpoint (Tab: Distance -> Angle, Enter to commit)");
      this.commandBar.enableDualInput("0.00", "0.0");
    } else if (this.state === 1) {
      const { point, snapType } = this.engine.snap(worldPos, this.center);
      const resolved = snapType === null ? this.engine.applyOrtho(this.center!, point) : point;
      this.commitMajorPoint(resolved);
    } else {
      const { point } = this.engine.snap(worldPos, this.majorPoint);
      this.currentMousePos = point;
      this.addEllipse(this.minorRadiusAt(point));
    }
    this.engine.requestRedraw();
  }

  private commitMajorPoint(point: Point): void {
    if (point.x === this.center!.x && point.y === this.center!.y) return;
    this.majorPoint = point;
    this.currentMousePos = point;
    this.state = 2;
    this.commandBar.disableDualInput();
    this.commandBar.setStatus("ELLIPSE", "Pick Minor Axis Distance (or type a value)");
    this.commandBar.enableInput();
  }

  mouseMove(worldPos: Point): void {
    if (this.state === 0) return;

    if (this.state === 1) {
      const { point, snapType } = this.engine.snap(worldPos, this.center);
      const resolved = snapType === null ? this.engine.applyOrtho(this.center!, point) : point;
      this.currentMousePos = resolved;
      const distance = Math.hypot(resolved.x - this.center!.x, resolved.y - this.center!.y);
      // AutoCAD bearing: counter-clockwise with Y up (the world is Y-down).
      const angleDeg = ((-this.currentAngle() * 180) / Math.PI + 360) % 360;
      this.commandBar.setLiveValue(distance.toFixed(2));
      this.commandBar.setLiveAngle(angleDeg.toFixed(1));
    } else {
      const { point } = this.engine.snap(worldPos, this.majorPoint);
      this.currentMousePos = point;
      const radiusY = this.minorRadiusAt(point);
      this.commandBar.setStatus("ELLIPSE", `Minor Radius: ${radiusY.toFixed(2)} (or type a value)`);
      this.commandBar.setLiveValue(radiusY.toFixed(2));
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 0) {
      const point = parsePoint(text, null);
      if (point === null) {
        this.commandBar.setStatus("ELLIPSE", "Invalid point - use x,y");
        return;
      }
      this.center = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("ELLIPSE", "Pick Major Axis Endpoint (Tab: Distance -> Angle, Enter to commit)");
      this.commandBar.enableDualInput("0.00", "0.0");
    } else if (this.state === 1) {
      const point = parsePoint(text, this.center, this.currentAngle());
      if (point === null) {
        this.commandBar.setStatus("ELLIPSE", "Invalid - use dist, dist<angle or dist/angle, dx,dy");
        return;
      }
      this.commitMajorPoint(point);
    } else {
      const radiusY = parsePositiveFloat(text);
      if (radiusY === null) {
        this.commandBar.setStatus("ELLIPSE", "Invalid radius - enter a positive number");
        return;
      }
      this.addEllipse(radiusY);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state === 1 && this.center !== null && this.currentMousePos !== null) {
      const ghost = new Line(this.center, this.currentMousePos);
      ghost.draw(ctx, this.engine.viewport, true);
    } else if (this.state === 2 && this.center !== null && this.majorPoint !== null && this.currentMousePos !== null) {
      const radiusY = this.minorRadiusAt(this.currentMousePos);
      if (radiusY > 0) {
        const ghost = new Ellipse(this.center, this.radiusX(), radiusY, this.rotationAngle());
        ghost.draw(ctx, this.engine.viewport, true);
      }
    }
  }

  cancel(): void {
    this.state = 0;
    this.center = null;
    this.majorPoint = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }

  private addEllipse(radiusY: number): void {
    if (radiusY <= 0) return;
    this.undo.push(this.document.toDict());
    this.document.addEntity(new Ellipse(this.center!, this.radiusX(), radiusY, this.rotationAngle()));
    this.start();
  }
}
