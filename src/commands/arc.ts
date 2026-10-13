/**
 * MinimalCAD Web
 * commands/arc.ts
 *
 * Ported from commands/arc.py: Start/End/Radius arc (AutoCAD 3-point-style
 * method) -- the center is never picked directly, it's solved from 2 points
 * + either a third point the arc must pass through (circumcircle fit) or a
 * typed radius (minor-arc fit, side-disambiguated by the live mouse hint).
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { circleOfRadiusThrough2Points, circumcircleThrough3Points } from "../geometry/fit";
import type { ArcFit } from "../geometry/fit";
import { parsePoint, parsePositiveFloat } from "../input/dynamicInput";

export class ArcCommand extends BaseCommand {
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
    this.commandBar.disableDualInput();
    this.commandBar.setStatus("ARC", "Pick Start Point (or type x,y)");
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.p1 = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("ARC", "Pick End Point");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos, this.p1);
      this.commitEndPoint(point);
    } else {
      const { point } = this.engine.snap(worldPos);
      const fit = circumcircleThrough3Points(this.p1!, this.p2!, point);
      if (fit === null) {
        this.commandBar.setStatus("ARC", "Points are collinear - pick a different point");
        return;
      }
      this.addArc(fit);
    }
    this.engine.requestRedraw();
  }

  private commitEndPoint(point: Point): void {
    this.p2 = point;
    this.currentMousePos = point;
    this.state = 2;
    this.commandBar.setStatus("ARC", "Pick a point on the arc (or type a radius)");
    this.commandBar.enableInput();
  }

  mouseMove(worldPos: Point): void {
    // The third pick is a point ON the arc: nothing straight runs to it.
    const reference = this.state === 1 ? this.p1 : null;
    const { point } = this.engine.snap(worldPos, reference);
    this.currentMousePos = point;

    if (this.state === 2 && this.p1 !== null && this.p2 !== null) {
      const fit = circumcircleThrough3Points(this.p1, this.p2, point);
      if (fit === null) {
        this.commandBar.setStatus("ARC", "Points are collinear - pick a different point");
      } else {
        this.commandBar.setStatus("ARC", `Radius: ${fit.radius.toFixed(2)} (click to place, or type a value)`);
        this.commandBar.setLiveValue(fit.radius.toFixed(2));
      }
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 0) {
      const point = parsePoint(text, null);
      if (point === null) {
        this.commandBar.setStatus("ARC", "Invalid point - use x,y");
        return;
      }
      this.p1 = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("ARC", "Pick End Point");
    } else if (this.state === 1) {
      const point = parsePoint(text, this.p1);
      if (point === null) {
        this.commandBar.setStatus("ARC", "Invalid point - use x,y");
        return;
      }
      this.commitEndPoint(point);
    } else if (this.state === 2) {
      const radius = parsePositiveFloat(text);
      if (radius === null) {
        this.commandBar.setStatus("ARC", "Invalid - enter a positive radius");
        return;
      }
      const hint = this.currentMousePos ?? this.p2!;
      const fit = circleOfRadiusThrough2Points(this.p1!, this.p2!, radius, hint);
      if (fit === null) {
        const minRadius = Math.hypot(this.p2!.x - this.p1!.x, this.p2!.y - this.p1!.y) / 2;
        this.commandBar.setStatus("ARC", `Radius too small - needs to be at least ${minRadius.toFixed(2)}`);
        return;
      }
      this.addArc(fit);
    }
  }

  private addArc(fit: ArcFit): void {
    this.undo.push(this.document.toDict());
    this.document.addEntity(new Arc(fit.center, fit.radius, fit.startAngle, fit.endAngle));
    this.start();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state === 1 && this.p1 !== null && this.currentMousePos !== null) {
      const ghost = new Line(this.p1, this.currentMousePos);
      ghost.draw(ctx, this.engine.viewport, true);
    } else if (this.state === 2 && this.p1 !== null && this.p2 !== null && this.currentMousePos !== null) {
      const fit = circumcircleThrough3Points(this.p1, this.p2, this.currentMousePos);
      if (fit !== null) {
        const ghost = new Arc(fit.center, fit.radius, fit.startAngle, fit.endAngle);
        ghost.draw(ctx, this.engine.viewport, true);
      }
    }
  }

  cancel(): void {
    this.state = 0;
    this.p1 = null;
    this.p2 = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
