/**
 * MinimalCAD Web
 * commands/fillet.ts
 *
 * Ported from commands/fillet.py -- all three cases: Line-Line (closed-form
 * tangent-setback trig), Line-Arc and Arc-Arc (offset-curve-intersection:
 * offset each curve by the radius, intersect the offset curves, project
 * tangent points back onto the ORIGINAL un-offset curves -- see
 * geometry/filletGeometry.ts).
 *
 * Radius 0 is valid for the Line-Line case: trims both lines back to a
 * sharp corner with no arc, matching AutoCAD convention. (Line-Arc/Arc-Arc
 * fillet doesn't extend that same radius-0 special case -- a zero-radius
 * "fillet" between a line and a curve is really a different operation,
 * trim-to-intersection, not a degenerate case of this one.)
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import type { Entity } from "../entities/entity";
import { Polyline } from "../entities/polyline";
import { PolylineCorners } from "./polylineCorners";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { entityAt } from "../engine/picking";
import { clickDirectionVector, infiniteLineIntersection, keptEndpoint } from "../geometry/pickSide";
import {
  arcRelOffset,
  arcTotalSweep,
  circleCircleIntersectPoints,
  filletArcBetween,
  footOnLine,
  keptArcSpan,
  lineCircleIntersectPoints,
  lineParam,
  offsetArcRadius,
  offsetLineToward,
} from "../geometry/filletGeometry";
import { evalNumber } from "../input/dynamicInput";

const TWO_PI = 2.0 * Math.PI;

type FilletEntity = Line | Arc;

interface FilletPlan {
  remove: FilletEntity[];
  add: FilletEntity[];
  kept: FilletEntity[];
  trimmed: FilletEntity[];
  connector: Arc | null;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function closestTo(candidates: Point[], hint: Point): Point {
  return candidates.reduce((best, c) => (dist(c, hint) < dist(best, hint) ? c : best));
}

export class FilletCommand extends BaseCommand {
  private state: 0 | 1 = 0;
  private entity1: FilletEntity | null = null;
  private entity2: FilletEntity | null = null;
  private click1: Point | null = null;
  private click2: Point | null = null;
  private hoverPoint: Point | null = null;
  private radius = 10.0;
  private previewing = false;

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
    this.hoverPoint = null;
    this.commandBar.setStatus("FILLET", `Select First Line/Arc (Radius: ${this.radius.toFixed(2)})`);
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  pick(): (entity: Entity) => boolean {
    return (e) => e !== this.entity1 && (this.isFilletable(e) || e instanceof Polyline);
  }

  private isFilletable(e: unknown): e is FilletEntity {
    return e instanceof Line || e instanceof Arc;
  }

  leftClick(worldPos: Point): void {
    this.corners.openAt(worldPos);
    const candidates = this.document.getEntities().filter((e) => this.isFilletable(e)) as FilletEntity[];
    if (this.state === 0) {
      const hit = entityAt(candidates, worldPos, this.engine.pickTolerance());
      if (hit === null) return;
      this.entity1 = hit;
      this.click1 = worldPos;
      this.hoverPoint = null;
      this.state = 1;
      this.commandBar.setStatus("FILLET", "Hover to preview: green stays, red trims; click second edge");
    } else {
      const hit = entityAt(
        candidates.filter((e) => e !== this.entity1),
        worldPos,
        this.engine.pickTolerance(),
      );
      if (hit === null) return;
      this.entity2 = hit;
      this.click2 = worldPos;
      this.executeFillet();
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    const radius = evalNumber(text);
    if (radius === null || radius < 0) {
      this.commandBar.setStatus("FILLET", "Invalid - enter a radius >= 0");
      return;
    }
    this.radius = radius;
    this.start();
  }

  mouseMove(worldPos: Point): void {
    if (this.state !== 1) return;
    this.hoverPoint = worldPos;
    this.engine.requestRedraw();
  }

  private showError(message: string): void {
    if (!this.previewing) this.commandBar.setStatus("FILLET", message);
  }

  private executeFillet(): void {
    const e1 = this.entity1!, e2 = this.entity2!;
    const plan = this.calculateFillet(e1, this.click1!, e2, this.click2!);
    if (plan === null) {
      this.start();
      return;
    }

    this.undo.push(this.corners.undoState());
    for (const entity of plan.remove) this.document.removeEntity(entity);
    for (const entity of plan.add) this.document.addEntity(entity);
    this.start();
  }

  /** Calculate the exact result used both by the live preview and by the commit. */
  private calculateFillet(e1: FilletEntity, click1: Point, e2: FilletEntity, click2: Point): FilletPlan | null {
    if (e1 instanceof Line && e2 instanceof Line) return this.calculateLineLine(e1, click1, e2, click2);
    if (e1 instanceof Line && e2 instanceof Arc) return this.calculateLineArc(e1, click1, e2, click2);
    if (e1 instanceof Arc && e2 instanceof Line) return this.calculateLineArc(e2, click2, e1, click1);
    return this.calculateArcArc(e1 as Arc, click1, e2 as Arc, click2);
  }

  // --- Line-Line: closed-form tangent-setback trig ---

  private calculateLineLine(l1: Line, click1: Point, l2: Line, click2: Point): FilletPlan | null {
    const intersection = infiniteLineIntersection(l1, l2);
    if (intersection === null) {
      this.showError("Parallel lines - no fillet possible");
      return null;
    }

    const u1 = clickDirectionVector(l1, intersection, click1);
    const u2 = clickDirectionVector(l2, intersection, click2);
    if (u1 === null || u2 === null) {
      this.showError("Corner coincides with an endpoint - can't fillet");
      return null;
    }

    const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const theta = Math.acos(dot);
    const sinHalf = Math.sin(theta / 2);
    if (Math.abs(sinHalf) < 1e-9) {
      this.showError("Lines are parallel at this corner - no fillet possible");
      return null;
    }

    const tangentDist = this.radius / Math.tan(theta / 2);
    const kept1 = keptEndpoint(l1, u1);
    const kept2 = keptEndpoint(l2, u2);
    const available1 = dist(kept1, intersection);
    const available2 = dist(kept2, intersection);
    if (tangentDist > available1 || tangentDist > available2) {
      this.showError("Radius too large for this corner");
      return null;
    }

    const t1: Point = { x: intersection.x + u1.x * tangentDist, y: intersection.y + u1.y * tangentDist };
    const t2: Point = { x: intersection.x + u2.x * tangentDist, y: intersection.y + u2.y * tangentDist };

    const add: FilletEntity[] = [new Line(t1, kept1, { lineType: l1.lineType }), new Line(t2, kept2, { lineType: l2.lineType })];
    const connector: Arc | null = null;

    if (this.radius > 0) {
      const bisectorX = u1.x + u2.x, bisectorY = u1.y + u2.y;
      const bisectorLen = Math.hypot(bisectorX, bisectorY);
      const ub = { x: bisectorX / bisectorLen, y: bisectorY / bisectorLen };
      const centerDist = this.radius / sinHalf;
      const center: Point = { x: intersection.x + ub.x * centerDist, y: intersection.y + ub.y * centerDist };

      let startAngle = Math.atan2(t1.y - center.y, t1.x - center.x);
      let endAngle = Math.atan2(t2.y - center.y, t2.x - center.x);
      const sweep = ((endAngle - startAngle) % TWO_PI + TWO_PI) % TWO_PI;
      if (sweep > Math.PI) [startAngle, endAngle] = [endAngle, startAngle];

      const arc = new Arc(center, this.radius, startAngle, endAngle, { lineType: l1.lineType });
      add.push(arc);
      return { remove: [l1, l2], add, kept: add.slice(0, 2), trimmed: [], connector: arc };
    }

    return { remove: [l1, l2], add, kept: add.slice(0, 2), trimmed: [], connector };
  }

  // --- Line-Arc: offset-curve intersection ---

  private calculateLineArc(line: Line, lineClick: Point, arc: Arc, arcClick: Point): FilletPlan | null {
    const offsetLine = offsetLineToward(line.startPoint, line.endPoint, this.radius, arcClick);
    if (offsetLine === null) {
      this.showError("Degenerate line - can't fillet");
      return null;
    }
    const offRadius = offsetArcRadius(arc, this.radius, lineClick);
    if (offRadius <= 0) {
      this.showError("Radius too large for this arc");
      return null;
    }
    const candidates = lineCircleIntersectPoints(offsetLine.point, offsetLine.direction, arc.center, offRadius);
    if (candidates.length === 0) {
      this.showError("No fillet solution for this radius");
      return null;
    }

    const cornerHint = { x: (lineClick.x + arcClick.x) / 2, y: (lineClick.y + arcClick.y) / 2 };
    const centerPt = closestTo(candidates, cornerHint);

    const { point: tLine, t: tParam } = footOnLine(line.startPoint, line.endPoint, centerPt);
    if (tParam < 0 || tParam > 1) {
      this.showError("Radius too large for this line");
      return null;
    }

    const tArcAngle = Math.atan2(centerPt.y - arc.center.y, centerPt.x - arc.center.x);
    const tArc: Point = {
      x: arc.center.x + arc.radius * Math.cos(tArcAngle),
      y: arc.center.y + arc.radius * Math.sin(tArcAngle),
    };
    const arcOffset = arcRelOffset(arc, tArcAngle);
    const totalSweep = arcTotalSweep(arc);
    if (!(arcOffset > 1e-4 && arcOffset < totalSweep - 1e-4)) {
      this.showError("Radius too large for this arc");
      return null;
    }

    const keptLineEnd = lineParam(line.startPoint, line.endPoint, lineClick) > tParam ? line.endPoint : line.startPoint;
    const [keptArcStart, keptArcEnd] = keptArcSpan(arc, tArcAngle, arcClick);

    const keptLine = new Line(tLine, keptLineEnd, { lineType: line.lineType });
    const keptArc = new Arc(arc.center, arc.radius, keptArcStart, keptArcEnd, { lineType: arc.lineType });
    const otherLineEnd = keptLineEnd === line.startPoint ? line.endPoint : line.startPoint;
    const trimmedLine = new Line(otherLineEnd, tLine, { lineType: line.lineType });
    const clickOffset = arcRelOffset(arc, Math.atan2(arcClick.y - arc.center.y, arcClick.x - arc.center.x));
    const tangentOffset = arcRelOffset(arc, tArcAngle);
    const trimmedArc = clickOffset < tangentOffset
      ? new Arc(arc.center, arc.radius, tArcAngle, arc.endAngle, { lineType: arc.lineType })
      : new Arc(arc.center, arc.radius, arc.startAngle, tArcAngle, { lineType: arc.lineType });
    const add: FilletEntity[] = [keptLine, keptArc];
    let connector: Arc | null = null;
    if (this.radius > 0) {
      connector = filletArcBetween(centerPt, tLine, tArc, this.radius, line.lineType);
      add.push(connector);
    }
    return {
      remove: [line, arc],
      add,
      kept: [keptLine, keptArc],
      trimmed: [trimmedLine, trimmedArc],
      connector,
    };
  }

  // --- Arc-Arc: offset-curve intersection ---

  private calculateArcArc(arc1: Arc, click1: Point, arc2: Arc, click2: Point): FilletPlan | null {
    const offRadius1 = offsetArcRadius(arc1, this.radius, click2);
    const offRadius2 = offsetArcRadius(arc2, this.radius, click1);
    if (offRadius1 <= 0 || offRadius2 <= 0) {
      this.showError("Radius too large for these arcs");
      return null;
    }
    const candidates = circleCircleIntersectPoints(arc1.center, offRadius1, arc2.center, offRadius2);
    if (candidates.length === 0) {
      this.showError("No fillet solution for this radius");
      return null;
    }

    const cornerHint = { x: (click1.x + click2.x) / 2, y: (click1.y + click2.y) / 2 };
    const centerPt = closestTo(candidates, cornerHint);

    const tangentOn = (arc: Arc) => {
      const angle = Math.atan2(centerPt.y - arc.center.y, centerPt.x - arc.center.x);
      const point: Point = { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) };
      return { point, angle };
    };
    const tan1 = tangentOn(arc1);
    const tan2 = tangentOn(arc2);

    const offset1 = arcRelOffset(arc1, tan1.angle);
    const sweep1 = arcTotalSweep(arc1);
    const offset2 = arcRelOffset(arc2, tan2.angle);
    const sweep2 = arcTotalSweep(arc2);
    if (!(offset1 > 1e-4 && offset1 < sweep1 - 1e-4) || !(offset2 > 1e-4 && offset2 < sweep2 - 1e-4)) {
      this.showError("Radius too large for these arcs");
      return null;
    }

    const [start1, end1] = keptArcSpan(arc1, tan1.angle, click1);
    const [start2, end2] = keptArcSpan(arc2, tan2.angle, click2);
    const click1Angle = Math.atan2(click1.y - arc1.center.y, click1.x - arc1.center.x);
    const click2Angle = Math.atan2(click2.y - arc2.center.y, click2.x - arc2.center.x);

    const keptArc1 = new Arc(arc1.center, arc1.radius, start1, end1, { lineType: arc1.lineType });
    const keptArc2 = new Arc(arc2.center, arc2.radius, start2, end2, { lineType: arc2.lineType });
    const trim1 = arcRelOffset(arc1, click1Angle) < offset1
      ? new Arc(arc1.center, arc1.radius, tan1.angle, arc1.endAngle, { lineType: arc1.lineType })
      : new Arc(arc1.center, arc1.radius, arc1.startAngle, tan1.angle, { lineType: arc1.lineType });
    const trim2 = arcRelOffset(arc2, click2Angle) < offset2
      ? new Arc(arc2.center, arc2.radius, tan2.angle, arc2.endAngle, { lineType: arc2.lineType })
      : new Arc(arc2.center, arc2.radius, arc2.startAngle, tan2.angle, { lineType: arc2.lineType });
    const add: FilletEntity[] = [keptArc1, keptArc2];
    let connector: Arc | null = null;
    if (this.radius > 0) {
      connector = filletArcBetween(centerPt, tan1.point, tan2.point, this.radius, arc1.lineType);
      add.push(connector);
    }
    return { remove: [arc1, arc2], add, kept: [keptArc1, keptArc2], trimmed: [trim1, trim2], connector };
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.entity1 !== null) {
      this.entity1.drawSelected(ctx, this.engine.viewport);
    }
    if (this.state !== 1 || this.entity1 === null || this.click1 === null || this.hoverPoint === null) return;

    const candidates = this.document.getEntities().filter((e) => e !== this.entity1 && this.isFilletable(e)) as FilletEntity[];
    const second = entityAt(candidates, this.hoverPoint, this.engine.pickTolerance());
    if (second === null) return;

    this.previewing = true;
    let plan: FilletPlan | null;
    try {
      plan = this.calculateFillet(this.entity1, this.click1, second, this.hoverPoint);
    } finally {
      this.previewing = false;
    }
    if (plan === null) return;

    this.drawTinted(ctx, plan.trimmed, "#ff5c5c");
    this.drawTinted(ctx, plan.kept, "#3ddc84");
    if (plan.connector !== null) this.drawTinted(ctx, [plan.connector], "#55dfff");
  }

  private drawTinted(ctx: CanvasRenderingContext2D, entities: FilletEntity[], color: string): void {
    const tinted = new Proxy(ctx, {
      set(target, key, value) {
        if (key === "strokeStyle" || key === "fillStyle" || key === "lineWidth") return true;
        return Reflect.set(target, key, value);
      },
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    for (const entity of entities) entity.draw(tinted, this.engine.viewport, true);
    ctx.restore();
  }

  cancel(): void {
    this.corners.close();
    this.state = 0;
    this.entity1 = null;
    this.entity2 = null;
    this.click1 = null;
    this.click2 = null;
    this.hoverPoint = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
