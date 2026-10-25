/**
 * MinimalCAD Web
 * commands/scale.ts
 *
 * Ported from commands/scale.py. Restricted to Line/Circle/Arc/Polyline
 * (Polyline is a deliberate v1 extension beyond the desktop app's own
 * Line/Circle/Arc/Ellipse restriction, since scaling its vertices about a
 * point is straightforward and its bulges are scale-invariant).
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { Engine } from "../engine/engine";
import { PickTransformCommand } from "./transformBase";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Polyline } from "../entities/polyline";
import { parsePositiveFloat } from "../input/dynamicInput";

const BASE_REFERENCE_LENGTH = 100.0;

export class ScaleCommand extends PickTransformCommand {
  private state: 0 | 1 | 2 = 0;
  private basePoint: Point | null = null;
  private currentMousePos: Point | null = null;
  private scaleFactor = 1.0;

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
      this.commandBar.setStatus("SCALE", `${preSelected.length} selected - Pick Base Point`);
    } else {
      this.targetEntities = [];
      this.state = 0;
      this.commandBar.setStatus("SCALE", "Select Object(s)");
    }
    this.basePoint = null;
    this.currentMousePos = null;
    this.engine.requestRedraw();
  }

  private scalePoint(pt: Point, base: Point, factor: number): Point {
    return { x: base.x + (pt.x - base.x) * factor, y: base.y + (pt.y - base.y) * factor };
  }

  private calculateScaleGeometry(entity: Entity, base: Point, factor: number): Entity | null {
    if (entity instanceof Line) {
      return new Line(this.scalePoint(entity.startPoint, base, factor), this.scalePoint(entity.endPoint, base, factor), {
        lineType: entity.lineType,
        dxfLayer: entity.dxfLayer,
        dxfColor: entity.dxfColor,
      });
    }
    if (entity instanceof Arc) {
      return new Arc(
        this.scalePoint(entity.center, base, factor),
        entity.radius * factor,
        entity.startAngle,
        entity.endAngle,
        { lineType: entity.lineType, dxfLayer: entity.dxfLayer, dxfColor: entity.dxfColor },
      );
    }
    if (entity instanceof Circle) {
      return new Circle(this.scalePoint(entity.center, base, factor), entity.radius * factor, {
        lineType: entity.lineType,
        dxfLayer: entity.dxfLayer,
        dxfColor: entity.dxfColor,
      });
    }
    if (entity instanceof Polyline) {
      return new Polyline(
        entity.vertices.map((v) => ({ point: this.scalePoint(v.point, base, factor), bulge: v.bulge })),
        entity.closed,
        { lineType: entity.lineType, dxfLayer: entity.dxfLayer, dxfColor: entity.dxfColor },
      );
    }
    return null;
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const pick = this.pickTargetAt(worldPos);
      if (pick === null) return;
      this.targetEntities = [pick];
      this.state = 1;
      this.commandBar.setStatus("SCALE", "1 selected - Pick Base Point");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.basePoint = point;
      this.currentMousePos = point;
      this.state = 2;
      this.commandBar.setStatus("SCALE", `Factor: ${this.scaleFactor.toFixed(3)} (drag or type a value)`);
      this.commandBar.enableInput();
      this.commandBar.setValue(this.scaleFactor.toFixed(3));
    } else {
      this.currentMousePos = worldPos; // raw, no snap -- factor is a pure screen-distance ratio
      const factor = this.calculateMouseFactor();
      if (factor > 0.001) {
        this.scaleFactor = factor;
        this.executeScale();
      }
    }
    this.engine.requestRedraw();
  }

  private calculateMouseFactor(): number {
    if (this.basePoint === null || this.currentMousePos === null) return this.scaleFactor;
    const currentLen = Math.hypot(
      this.currentMousePos.x - this.basePoint.x,
      this.currentMousePos.y - this.basePoint.y,
    );
    return Math.max(0.001, currentLen / BASE_REFERENCE_LENGTH);
  }

  mouseMove(worldPos: Point): void {
    // Matches the desktop app's own mouse_move: state 1 ("Pick Base Point")
    // gets a snap preview same as any other point-pick; state 2's factor is
    // a pure screen-distance ratio (see calculateMouseFactor()) and was
    // never snapped even on the desktop, so only state 0 (still choosing
    // which entity to scale) is skipped entirely.
    if (this.state === 0) return;
    if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.currentMousePos = point;
      this.engine.requestRedraw();
      return;
    }
    this.currentMousePos = worldPos;
    const factor = this.calculateMouseFactor();
    this.commandBar.setLiveValue(factor.toFixed(3));
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state !== 2) return;
    const factor = parsePositiveFloat(text);
    if (factor === null) {
      this.commandBar.setStatus("SCALE", "Invalid - enter a positive factor");
      return;
    }
    this.scaleFactor = factor;
    this.executeScale();
  }

  private executeScale(): void {
    const base = this.basePoint!;
    const factor = this.scaleFactor;
    this.commitMutate((entity) => {
      const scaled = this.calculateScaleGeometry(entity, base, factor);
      if (scaled === null) return;

      // Scale modifies the selected drawing in place, like AutoCAD's SCALE.
      // Keep the original entity object (and its identity) so the operation
      // never leaves a duplicate behind.
      if (entity instanceof Line && scaled instanceof Line) {
        entity.startPoint = scaled.startPoint;
        entity.endPoint = scaled.endPoint;
      } else if (entity instanceof Arc && scaled instanceof Arc) {
        entity.center = scaled.center;
        entity.radius = scaled.radius;
      } else if (entity instanceof Circle && scaled instanceof Circle) {
        entity.center = scaled.center;
        entity.radius = scaled.radius;
      } else if (entity instanceof Polyline && scaled instanceof Polyline) {
        entity.vertices = scaled.vertices;
      }
    });
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state < 1) return;
    this.drawTargetsSelected(ctx);

    if (this.state === 2 && this.basePoint !== null) {
      for (const entity of this.targetEntities) {
        const preview = this.calculateScaleGeometry(entity, this.basePoint, this.scaleFactor);
        preview?.draw(ctx, this.engine.viewport, true);
      }
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
