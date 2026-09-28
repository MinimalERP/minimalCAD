/**
 * MinimalCAD Web
 * commands/rotate.ts
 *
 * Ported from commands/rotate.py. Angle field is single (not dual
 * Distance/Angle) -- only the angle itself is picked/typed, degrees on the wire.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { PickTransformCommand } from "./transformBase";
import { evalNumber } from "../input/dynamicInput";

export class RotateCommand extends PickTransformCommand {
  private state: 0 | 1 | 2 = 0;
  private basePoint: Point | null = null;
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
      this.commandBar.setStatus("ROTATE", `${preSelected.length} selected - Pick Base Point`);
    } else {
      this.targetEntities = [];
      this.state = 0;
      this.commandBar.setStatus("ROTATE", "Select Object(s)");
    }
    this.basePoint = null;
    this.currentMousePos = null;
    this.engine.requestRedraw();
  }

  private angleTo(pos: Point): number {
    if (this.basePoint === null) return 0;
    if (pos.x === this.basePoint.x && pos.y === this.basePoint.y) return 0;
    return Math.atan2(pos.y - this.basePoint.y, pos.x - this.basePoint.x);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const pick = this.pickTargetAt(worldPos);
      if (pick === null) return;
      this.targetEntities = [pick];
      this.state = 1;
      this.commandBar.setStatus("ROTATE", "1 selected - Pick Base Point");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.basePoint = point;
      this.currentMousePos = point;
      this.state = 2;
      this.commandBar.setStatus("ROTATE", "Pick Angle (or type degrees)");
      this.commandBar.enableInput();
      this.commandBar.setValue("0.0");
    } else {
      const { point, snapType } = this.engine.snap(worldPos, this.basePoint);
      const resolved = snapType === null ? this.engine.applyOrtho(this.basePoint!, point) : point;
      this.executeRotate(this.angleTo(resolved));
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    // Matches the desktop app's own mouse_move: snap previews from the
    // FIRST point-pick state onward (state 1, "Pick Base Point"), not just
    // the final angle state -- only state 0 (still choosing which entity to
    // rotate) has no point to snap toward at all.
    if (this.state === 0) return;
    const reference = this.state === 2 ? this.basePoint : null;
    const { point, snapType } = this.engine.snap(worldPos, reference);
    this.currentMousePos =
      this.state === 2 && this.basePoint !== null && snapType === null
        ? this.engine.applyOrtho(this.basePoint, point)
        : point;

    if (this.state === 2 && this.basePoint !== null) {
      // Shown AutoCAD-style: counter-clockwise positive (world is Y-down).
      const angleDeg = (-this.angleTo(this.currentMousePos) * 180) / Math.PI;
      this.commandBar.setLiveValue(angleDeg.toFixed(1));
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state !== 2) return;
    const angleDeg = evalNumber(text);
    if (angleDeg === null) {
      this.commandBar.setStatus("ROTATE", "Invalid - enter an angle in degrees");
      return;
    }
    // Typed +angle turns counter-clockwise on screen, as in AutoCAD: in the
    // Y-down world that is a negative rotation.
    this.executeRotate((-angleDeg * Math.PI) / 180);
  }

  private executeRotate(angleRad: number): void {
    if (angleRad === 0) {
      this.start();
      return;
    }
    const cx = this.basePoint!.x;
    const cy = this.basePoint!.y;
    this.commitMutate((e) => e.rotate(cx, cy, angleRad));
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state < 1) return;
    this.drawTargetsSelected(ctx);

    if (this.state === 2 && this.basePoint !== null && this.currentMousePos !== null) {
      const viewport = this.engine.viewport;
      const p1 = viewport.worldToScreen(this.basePoint);
      const p2 = viewport.worldToScreen(this.currentMousePos);
      ctx.strokeStyle = "#1e90ff";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);

      const angleRad = this.angleTo(this.currentMousePos);
      const cx = this.basePoint.x;
      const cy = this.basePoint.y;
      this.drawGhosts(ctx, (e) => e.rotate(cx, cy, angleRad));
    }
  }

  cancel(): void {
    this.state = 0;
    this.targetEntities = [];
    this.basePoint = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
