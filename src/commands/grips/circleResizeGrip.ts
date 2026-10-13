/**
 * MinimalCAD Web
 * commands/grips/circleResizeGrip.ts
 *
 * Ported from commands/circle_grip_resize.py: drags a Circle's radius via
 * one of its quadrant grips. Contextual-only, armed via begin().
 */

import type { Point } from "../../core/types";
import type { Circle } from "../../entities/circle";
import type { Engine } from "../../engine/engine";
import { BaseCommand } from "../base";
import { parsePositiveFloat } from "../../input/dynamicInput";

export class CircleResizeGripCommand extends BaseCommand {
  private entity: Circle | null = null;
  private currentRadius = 0;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.entity = null;
    this.currentRadius = 0;
    this.commandBar.setStatus("CIRCLE", "Click a quadrant grip to resize it");
  }

  begin(entity: Circle, _quadrantPoint: Point): void {
    this.entity = entity;
    this.currentRadius = entity.radius;
    this.commandBar.setStatus("CIRCLE", "Drag, or type a new radius");
    this.commandBar.enableInput();
    this.commandBar.setValue(entity.radius.toFixed(2));
  }

  leftClick(worldPos: Point): void {
    if (this.entity === null) return;
    const { point } = this.engine.snap(worldPos, this.entity.center, this.entity);
    const radius =Math.hypot(point.x - this.entity.center.x, point.y - this.entity.center.y);
    this.execute(radius);
  }

  mouseMove(worldPos: Point): void {
    if (this.entity === null) return;
    const { point } = this.engine.snap(worldPos, this.entity.center, this.entity);
    this.currentRadius = Math.hypot(point.x - this.entity.center.x, point.y - this.entity.center.y);
    this.commandBar.setLiveValue(this.currentRadius.toFixed(2));
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    const radius = parsePositiveFloat(text);
    if (radius === null) {
      this.commandBar.setStatus("CIRCLE", "Invalid - enter a positive radius");
      return;
    }
    this.execute(radius);
  }

  private execute(radius: number): void {
    if (radius <= 0) return;
    this.undo.push(this.document.toDict());
    this.entity!.radius = radius;
    this.engine.selection.clear();
    this.engine.cancelCommand();
    this.engine.requestRedraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.entity === null) return;
    const ghost = this.entity.copy();
    ghost.radius = this.currentRadius;
    ghost.draw(ctx, this.engine.viewport, true);
  }

  cancel(): void {
    this.entity = null;
    this.currentRadius = 0;
    this.commandBar.setReady();
  }
}
