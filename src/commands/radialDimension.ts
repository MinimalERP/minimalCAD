/**
 * MinimalCAD Web
 * commands/radialDimension.ts
 *
 * Ported from commands/diameter_dimension.py and commands/radius_dimension.py --
 * "Structurally identical to DiameterDimensionCommand -- only the produced
 * dim_type differs" per radius_dimension.py's own comment, since Dimension's
 * leader-style diameter/radius renderer shares the same (center,
 * radius_point, text_position) data shape. Rather than duplicate the ~90
 * lines of pick/preview/commit logic across two files (as the Python source
 * does), both concrete commands below share one base, overriding only the
 * three things that actually differ: dim_type, the status label, and the
 * commit prompt text.
 *
 * Pick a Circle/Arc, then place the leader text -- radius_point is derived
 * from the placement direction (true Euclidean angle from center to the
 * mouse) so the leader's arrow always touches the actual circle/arc
 * boundary.
 */

import type { Point } from "../core/types";
import { pointDistance } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Dimension, type DimData, type DimType } from "../entities/dimension";

type RadialCurve = Circle | Arc;

/** Where the leader's arrow actually touches the boundary: `center` offset
 *  toward `towards` by exactly `radius`, guarding the degenerate
 *  zero-distance case the same way the Python source does. */
function radiusPointToward(center: Point, towards: Point, radius: number): Point {
  const lineLen = Math.max(pointDistance(center, towards), 0.01);
  const ux = (towards.x - center.x) / lineLen;
  const uy = (towards.y - center.y) / lineLen;
  return { x: center.x + ux * radius, y: center.y + uy * radius };
}

abstract class RadialDimensionCommandBase extends BaseCommand {
  private state: 0 | 1 = 0;
  private targetCurve: RadialCurve | null = null;
  private currentMousePos: Point | null = null;

  protected abstract dimType(): DimType;
  protected abstract statusLabel(): string;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.targetCurve = null;
    this.currentMousePos = null;
    this.commandBar.setStatus(this.statusLabel(), "Select Circle or Arc");
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const tolerance = this.engine.pickTolerance();
      for (const entity of [...this.document.getEntities(), ...this.engine.underlay]) {
        if ((entity instanceof Circle || entity instanceof Arc) && entity.hitTest(worldPos, tolerance)) {
          this.targetCurve = entity;
          this.state = 1;
          this.commandBar.setStatus(this.statusLabel(), "Place dimension text");
          break;
        }
      }
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos, this.targetCurve!.center);
      this.currentMousePos = point;
      this.executeGeneration();
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    if (this.state === 1) {
      const { point } = this.engine.snap(worldPos, this.targetCurve!.center);
      this.currentMousePos = point;
      this.engine.requestRedraw();
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state >= 1 && this.targetCurve !== null) {
      this.targetCurve.drawSelected(ctx, this.engine.viewport);
    }
    if (this.state === 1 && this.targetCurve !== null && this.currentMousePos !== null) {
      const preview = new Dimension(this.dimType(), this.buildData(this.currentMousePos));
      preview.draw(ctx, this.engine.viewport, true);
    }
  }

  cancel(): void {
    this.commandBar.setReady();
  }

  private buildData(textPosition: Point): DimData {
    const center = this.targetCurve!.center;
    return {
      center,
      radius_point: radiusPointToward(center, textPosition, this.targetCurve!.radius),
      text_position: textPosition,
    };
  }

  private executeGeneration(): void {
    this.undo.push(this.document.toDict());
    const dim = new Dimension(this.dimType(), this.buildData(this.currentMousePos!));
    this.document.addEntity(dim);
    this.start();
  }
}

export class DiameterDimensionCommand extends RadialDimensionCommandBase {
  protected dimType(): DimType {
    return "diameter";
  }
  protected statusLabel(): string {
    return "DIMDIAMETER";
  }
}

export class RadiusDimensionCommand extends RadialDimensionCommandBase {
  protected dimType(): DimType {
    return "radius";
  }
  protected statusLabel(): string {
    return "DIMRADIUS";
  }
}
