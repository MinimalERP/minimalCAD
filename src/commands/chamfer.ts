/**
 * MinimalCAD Web
 * commands/chamfer.ts
 *
 * Ported from commands/chamfer.py -- structurally identical corner-intent
 * math to fillet.ts's Line-Line case, but connects the two setback points
 * with a straight segment instead of a tangent arc (no trig beyond the
 * setback distance itself). Line-Line only, matching the desktop app's own
 * scope (Chamfer never supported Arc there either).
 *
 * Distance 0 trims both lines back to the sharp corner with no connector
 * segment (skipping a degenerate zero-length connector at t1===t2 -- a
 * small, deliberate improvement over adding a pointless zero-length Line).
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import type { Entity } from "../entities/entity";
import { Polyline } from "../entities/polyline";
import { PolylineCorners } from "./polylineCorners";
import { Line } from "../entities/line";
import { entityAt } from "../engine/picking";
import { clickDirectionVector, infiniteLineIntersection, keptEndpoint } from "../geometry/pickSide";
import { evalNumber } from "../input/dynamicInput";

export class ChamferCommand extends BaseCommand {
  private state: 0 | 1 = 0;
  private entity1: Line | null = null;
  private entity2: Line | null = null;
  private click1: Point | null = null;
  private click2: Point | null = null;
  private distance = 10.0;

  /** A rectangle (any polyline) clicked is opened into its sides for the
   *  command and joined back into one outline when it ends. */
  private corners: PolylineCorners;

  constructor(engine: Engine) {
    super(engine);
    this.corners = new PolylineCorners(engine);
  }

  start(): void {
    this.corners.close();
    this.state = 0;
    this.entity1 = null;
    this.entity2 = null;
    this.click1 = null;
    this.click2 = null;
    this.commandBar.setStatus("CHAMFER", `Select First Line (Distance: ${this.distance.toFixed(2)})`);
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  pick(): (entity: Entity) => boolean {
    return (e) => e !== this.entity1 && (e instanceof Line || e instanceof Polyline);
  }

  leftClick(worldPos: Point): void {
    this.corners.openAt(worldPos);
    const candidates = this.document.getEntities().filter((e): e is Line => e instanceof Line);
    if (this.state === 0) {
      const hit = entityAt(candidates, worldPos, this.engine.pickTolerance());
      if (hit === null) return;
      this.entity1 = hit;
      this.click1 = worldPos;
      this.state = 1;
      this.commandBar.setStatus("CHAMFER", "Select Second Line");
    } else {
      const hit = entityAt(
        candidates.filter((e) => e !== this.entity1),
        worldPos,
        this.engine.pickTolerance(),
      );
      if (hit === null) return;
      this.entity2 = hit;
      this.click2 = worldPos;
      this.executeChamfer();
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    const distance = evalNumber(text);
    if (distance === null || distance < 0) {
      this.commandBar.setStatus("CHAMFER", "Invalid - enter a distance >= 0");
      return;
    }
    this.distance = distance;
    this.start();
  }

  private executeChamfer(): void {
    const l1 = this.entity1!, l2 = this.entity2!;
    const intersection = infiniteLineIntersection(l1, l2);
    if (intersection === null) {
      this.commandBar.setStatus("CHAMFER", "Parallel lines - no chamfer possible");
      this.start();
      return;
    }

    const u1 = clickDirectionVector(l1, intersection, this.click1!);
    const u2 = clickDirectionVector(l2, intersection, this.click2!);
    if (u1 === null || u2 === null) {
      this.commandBar.setStatus("CHAMFER", "Corner coincides with an endpoint - can't chamfer");
      this.start();
      return;
    }

    const kept1 = keptEndpoint(l1, u1);
    const kept2 = keptEndpoint(l2, u2);
    const available1 = Math.hypot(kept1.x - intersection.x, kept1.y - intersection.y);
    const available2 = Math.hypot(kept2.x - intersection.x, kept2.y - intersection.y);
    if (this.distance > available1 || this.distance > available2) {
      this.commandBar.setStatus("CHAMFER", "Distance too large for this corner");
      this.start();
      return;
    }

    const t1: Point = { x: intersection.x + u1.x * this.distance, y: intersection.y + u1.y * this.distance };
    const t2: Point = { x: intersection.x + u2.x * this.distance, y: intersection.y + u2.y * this.distance };

    this.undo.push(this.corners.undoState());
    this.document.removeEntity(l1);
    this.document.removeEntity(l2);
    this.document.addEntity(new Line(t1, kept1, { lineType: l1.lineType }));
    this.document.addEntity(new Line(t2, kept2, { lineType: l2.lineType }));
    if (this.distance > 0) {
      this.document.addEntity(new Line(t1, t2, { lineType: l1.lineType }));
    }

    this.start();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.entity1 !== null) {
      this.entity1.drawSelected(ctx, this.engine.viewport);
    }
  }

  cancel(): void {
    this.corners.close();
    this.state = 0;
    this.entity1 = null;
    this.entity2 = null;
    this.click1 = null;
    this.click2 = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
