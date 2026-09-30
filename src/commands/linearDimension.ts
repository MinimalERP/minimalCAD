/**
 * MinimalCAD Web
 * commands/linearDimension.ts
 *
 * Ported from commands/linear_dimension.py: three-click bounded horizontal/
 * vertical linear dimension -- pick the two measured points, then place the
 * dimension line (its position relative to those two points decides
 * horizontal vs. vertical -- see entities/dimension.ts's drawLinear()).
 */

import type { Point } from "../core/types";
import { pointDistance } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Dimension } from "../entities/dimension";

export class LinearDimensionCommand extends BaseCommand {
  private state: 0 | 1 | 2 = 0;
  private p1: Point | null = null;
  private p2: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.p1 = null;
    this.p2 = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("DIMLINEAR", "Pick first point");
  }

  leftClick(worldPos: Point): void {
    const reference = this.state === 1 ? this.p1 : null;
    const { point } = this.engine.snap(worldPos, reference);

    if (this.state === 0) {
      this.p1 = point;
      this.state = 1;
      this.commandBar.setStatus("DIMLINEAR", "Pick second point");
    } else if (this.state === 1) {
      if (pointDistance(point, this.p1!) < 0.01) return;
      this.p2 = point;
      this.state = 2;
      this.commandBar.setStatus("DIMLINEAR", "Place dimension line");
    } else if (this.state === 2) {
      this.currentMousePos = point;
      this.executeGeneration();
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    if (this.state === 0) {
      this.engine.snap(worldPos);
    } else if (this.state === 1) {
      this.engine.snap(worldPos, this.p1);
    } else if (this.state === 2) {
      const { point } = this.engine.snap(worldPos);
      this.currentMousePos = point;
    }
    this.engine.requestRedraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state !== 2 || this.p1 === null || this.p2 === null || this.currentMousePos === null) return;
    const preview = new Dimension("linear", this.engine.styleDimension({ p1: this.p1, p2: this.p2, text_position: this.currentMousePos }));
    preview.draw(ctx, this.engine.viewport, true);
  }

  cancel(): void {
    this.commandBar.setReady();
  }

  private executeGeneration(): void {
    this.undo.push(this.document.toDict());
    const dim = new Dimension("linear", this.engine.styleDimension({ p1: this.p1!, p2: this.p2!, text_position: this.currentMousePos! }));
    this.document.addEntity(dim);
    this.start();
  }
}
