/**
 * MinimalCAD Web
 * commands/move.ts
 *
 * Ported from commands/move.py.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { PickTransformCommand } from "./transformBase";
import { parsePoint } from "../input/dynamicInput";

export class MoveCommand extends PickTransformCommand {
  private state: 0 | 1 | 2 = 0;
  private referencePoint: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.commandBar.disableDualInput();
    const preSelected = this.preSelected();
    if (preSelected.length > 0) {
      this.targetEntities = preSelected;
      this.state = 1;
      this.commandBar.setStatus("MOVE", `${preSelected.length} selected - Pick Reference Point`);
    } else {
      this.targetEntities = [];
      this.state = 0;
      this.commandBar.setStatus("MOVE", "Select Object(s)");
    }
    this.referencePoint = null;
    this.currentMousePos = null;
    this.engine.requestRedraw();
  }

  private currentAngle(): number {
    if (this.referencePoint === null || this.currentMousePos === null) return 0;
    const dx = this.currentMousePos.x - this.referencePoint.x;
    const dy = this.currentMousePos.y - this.referencePoint.y;
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const pick = this.pickTargetAt(worldPos);
      if (pick === null) return;
      this.targetEntities = [pick];
      this.state = 1;
      this.commandBar.setStatus("MOVE", "1 selected - Pick Reference Point");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.referencePoint = point;
      this.currentMousePos = point;
      this.state = 2;
      this.commandBar.enableDualInput("0.00", "0.0");
    } else {
      const { point, snapType } = this.engine.snap(worldPos, this.referencePoint);
      const resolved =
        snapType === null ? this.engine.applyOrtho(this.referencePoint!, point) : point;
      this.executeMove(resolved.x - this.referencePoint!.x, resolved.y - this.referencePoint!.y);
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    // Matches the desktop app's own mouse_move: snap previews from the
    // FIRST point-pick state onward (state 1, "Pick Reference Point"), not
    // just the final displacement state -- only state 0 (still choosing
    // which entity to move) has no point to snap toward at all.
    if (this.state === 0) return;
    const reference = this.state === 2 ? this.referencePoint : null;
    const { point, snapType } = this.engine.snap(worldPos, reference);
    this.currentMousePos =
      this.state === 2 && this.referencePoint !== null && snapType === null
        ? this.engine.applyOrtho(this.referencePoint, point)
        : point;

    if (this.state === 2 && this.referencePoint !== null) {
      const dx = this.currentMousePos.x - this.referencePoint.x;
      const dy = this.currentMousePos.y - this.referencePoint.y;
      const distance = Math.hypot(dx, dy);
      const angleDeg = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360; // CCW, Y up
      this.commandBar.setLiveValue(distance.toFixed(2));
      this.commandBar.setLiveAngle(angleDeg.toFixed(1));
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state !== 2 || this.referencePoint === null) return;
    const point = parsePoint(text, this.referencePoint, this.currentAngle());
    if (point === null) {
      this.commandBar.setStatus("MOVE", "Invalid - use x,y, dist<angle, or a bare distance");
      return;
    }
    this.executeMove(point.x - this.referencePoint.x, point.y - this.referencePoint.y);
  }

  private executeMove(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) {
      this.start();
      return;
    }
    this.commitMutate((e) => e.move(dx, dy));
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state < 1) return;
    this.drawTargetsSelected(ctx);

    if (this.state === 2 && this.referencePoint !== null && this.currentMousePos !== null) {
      const viewport = this.engine.viewport;
      const p1 = viewport.worldToScreen(this.referencePoint);
      const p2 = viewport.worldToScreen(this.currentMousePos);
      ctx.strokeStyle = "#1e90ff";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);

      const dx = this.currentMousePos.x - this.referencePoint.x;
      const dy = this.currentMousePos.y - this.referencePoint.y;
      this.drawGhosts(ctx, (e) => e.move(dx, dy));
    }
  }

  cancel(): void {
    this.state = 0;
    this.targetEntities = [];
    this.referencePoint = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
