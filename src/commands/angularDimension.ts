/**
 * MinimalCAD Web
 * commands/angularDimension.ts
 *
 * Ported from commands/angular_dimension.py: pick two (non-parallel) Line
 * entities, then place the dimension arc between them.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Line } from "../entities/line";
import { Dimension, type DimData } from "../entities/dimension";

function linesIntersect(a: Line, b: Line): boolean {
  const d1x = a.endPoint.x - a.startPoint.x;
  const d1y = a.endPoint.y - a.startPoint.y;
  const d2x = b.endPoint.x - b.startPoint.x;
  const d2y = b.endPoint.y - b.startPoint.y;
  return Math.abs(d1x * d2y - d1y * d2x) > 1e-12;
}

export class AngularDimensionCommand extends BaseCommand {
  private state: 0 | 1 | 2 = 0;
  private line1: Line | null = null;
  private line2: Line | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.line1 = null;
    this.line2 = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("DIMANGULAR", "Select first line");
  }

  leftClick(worldPos: Point): void {
    const tolerance = this.engine.pickTolerance();

    if (this.state === 0) {
      for (const entity of [...this.document.getEntities(), ...this.engine.underlay]) {
        if (entity instanceof Line && entity.hitTest(worldPos, tolerance)) {
          this.line1 = entity;
          this.state = 1;
          this.commandBar.setStatus("DIMANGULAR", "Select second line");
          break;
        }
      }
    } else if (this.state === 1) {
      for (const entity of [...this.document.getEntities(), ...this.engine.underlay]) {
        if (!(entity instanceof Line) || !entity.hitTest(worldPos, tolerance) || entity === this.line1) continue;

        if (!linesIntersect(this.line1!, entity)) {
          this.commandBar.setStatus("DIMANGULAR", "Lines are parallel");
          this.state = 0;
          return;
        }
        this.line2 = entity;
        this.state = 2;
        this.commandBar.setStatus("DIMANGULAR", "Place dimension arc");
        break;
      }
    } else if (this.state === 2) {
      const { point } = this.engine.snap(worldPos);
      this.currentMousePos = point;
      this.executeGeneration();
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    if (this.state === 2) {
      const { point } = this.engine.snap(worldPos);
      this.currentMousePos = point;
      this.engine.requestRedraw();
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state >= 1 && this.line1 !== null) {
      this.line1.drawSelected(ctx, this.engine.viewport);
    }
    if (this.state === 2 && this.line1 !== null && this.line2 !== null && this.currentMousePos !== null) {
      const preview = new Dimension("angular", this.buildData(this.currentMousePos));
      preview.draw(ctx, this.engine.viewport, true);
    }
  }

  cancel(): void {
    this.commandBar.setReady();
  }

  private buildData(textPosition: Point): DimData {
    return {
      line1_p1: this.line1!.startPoint,
      line1_p2: this.line1!.endPoint,
      line2_p1: this.line2!.startPoint,
      line2_p2: this.line2!.endPoint,
      text_position: textPosition,
    };
  }

  private executeGeneration(): void {
    this.undo.push(this.document.toDict());
    const dim = new Dimension("angular", this.buildData(this.currentMousePos!));
    this.document.addEntity(dim);
    this.start();
  }
}
