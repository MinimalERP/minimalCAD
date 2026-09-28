/**
 * MinimalCAD Web
 * commands/mirror.ts
 *
 * Ported from commands/mirror.py. Same Line/Circle/Arc/Polyline eligibility
 * as commands/scale.ts. Arc mirroring reconstructs actual world-space
 * endpoint positions (not naive angle reflection -- wrong once the center
 * itself has moved), then swaps start/end because reflection reverses
 * winding direction (this app's Arc always sweeps CCW/increasing-angle from
 * start to end). Polyline mirroring applies the same principle per-edge:
 * mirror each vertex point and negate its bulge (bulge's sign encodes
 * winding the same way Arc's start/end order does), without reordering
 * vertices.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { PickTransformCommand } from "./transformBase";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Polyline } from "../entities/polyline";
import { parsePoint } from "../input/dynamicInput";
import { mirrorEntity } from "../geometry/reflect";

const AXIS_EXTENSION = 5000; // world units each direction, for the visual "infinite" axis line

export class MirrorCommand extends PickTransformCommand {
  private state: 0 | 1 | 2 = 0;
  private mirrorP1: Point | null = null;
  private mirrorP2: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
    this.eligibleTypes = [Line, Circle, Arc, Polyline];
  }

  start(): void {
    this.commandBar.disableDualInput();
    const preSelected = this.preSelected();
    if (preSelected.length > 0) {
      this.targetEntities = preSelected;
      this.state = 1;
      this.commandBar.setStatus("MIRROR", `${preSelected.length} selected - Pick First Axis Point`);
    } else {
      this.targetEntities = [];
      this.state = 0;
      this.commandBar.setStatus("MIRROR", "Select Object(s)");
    }
    this.mirrorP1 = null;
    this.mirrorP2 = null;
    this.currentMousePos = null;
    this.engine.requestRedraw();
  }

  private currentAngle(): number {
    if (this.mirrorP1 === null || this.currentMousePos === null) return 0;
    const dx = this.currentMousePos.x - this.mirrorP1.x;
    const dy = this.currentMousePos.y - this.mirrorP1.y;
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const pick = this.pickTargetAt(worldPos);
      if (pick === null) return;
      this.targetEntities = [pick];
      this.state = 1;
      this.commandBar.setStatus("MIRROR", "1 selected - Pick First Axis Point");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.mirrorP1 = point;
      this.currentMousePos = point;
      this.state = 2;
      this.commandBar.enableDualInput("0.00", "0.0");
    } else {
      const { point, snapType } = this.engine.snap(worldPos, this.mirrorP1);
      const resolved = snapType === null ? this.engine.applyOrtho(this.mirrorP1!, point) : point;
      if (resolved.x === this.mirrorP1!.x && resolved.y === this.mirrorP1!.y) return; // zero-length axis
      this.mirrorP2 = resolved;
      this.executeMirror();
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    // Matches the desktop app's own mouse_move: snap previews from the
    // FIRST point-pick state onward (state 1, "Pick First Axis Point"), not
    // just the final second-axis-point state -- only state 0 (still
    // choosing which entity to mirror) has no point to snap toward at all.
    if (this.state === 0) return;
    const reference = this.state === 2 ? this.mirrorP1 : null;
    const { point, snapType } = this.engine.snap(worldPos, reference);
    this.currentMousePos =
      this.state === 2 && this.mirrorP1 !== null && snapType === null
        ? this.engine.applyOrtho(this.mirrorP1, point)
        : point;

    if (this.state === 2 && this.mirrorP1 !== null) {
      const dx = this.currentMousePos.x - this.mirrorP1.x;
      const dy = this.currentMousePos.y - this.mirrorP1.y;
      const distance = Math.hypot(dx, dy);
      const angleDeg = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360; // CCW, Y up
      this.commandBar.setLiveValue(distance.toFixed(2));
      this.commandBar.setLiveAngle(angleDeg.toFixed(1));
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state !== 2 || this.mirrorP1 === null) return;
    const point = parsePoint(text, this.mirrorP1, this.currentAngle());
    if (point === null || (point.x === this.mirrorP1.x && point.y === this.mirrorP1.y)) {
      this.commandBar.setStatus("MIRROR", "Invalid - use x,y, dist<angle, or a bare distance");
      return;
    }
    this.mirrorP2 = point;
    this.executeMirror();
  }

  private executeMirror(): void {
    const p1 = this.mirrorP1!;
    const p2 = this.mirrorP2!;
    this.commitNew((entity) => mirrorEntity(entity, p1, p2));
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state < 1) return;
    this.drawTargetsSelected(ctx);

    if (this.state === 2 && this.mirrorP1 !== null && this.currentMousePos !== null) {
      const dx = this.currentMousePos.x - this.mirrorP1.x;
      const dy = this.currentMousePos.y - this.mirrorP1.y;
      const len = Math.hypot(dx, dy);
      const viewport = this.engine.viewport;

      if (len > 1e-9) {
        const ux = dx / len;
        const uy = dy / len;
        const extP1 = viewport.worldToScreen({
          x: this.mirrorP1.x - ux * AXIS_EXTENSION,
          y: this.mirrorP1.y - uy * AXIS_EXTENSION,
        });
        const extP2 = viewport.worldToScreen({
          x: this.mirrorP1.x + ux * AXIS_EXTENSION,
          y: this.mirrorP1.y + uy * AXIS_EXTENSION,
        });
        ctx.strokeStyle = "#1e90ff";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(extP1.x, extP1.y);
        ctx.lineTo(extP2.x, extP2.y);
        ctx.stroke();
        ctx.setLineDash([]);

        for (const entity of this.targetEntities) {
          const preview = mirrorEntity(entity, this.mirrorP1, this.currentMousePos);
          preview?.draw(ctx, viewport, true);
        }
      }
    }
  }

  cancel(): void {
    this.state = 0;
    this.targetEntities = [];
    this.mirrorP1 = null;
    this.mirrorP2 = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
