/**
 * MinimalCAD Web
 * commands/offset.ts
 *
 * Ported from commands/offset.py. Distance is cached across uses (default
 * 10.0); a single click both indicates which side to offset toward AND
 * commits -- no separate confirm step. The original entity is always kept;
 * offset adds a new entity alongside it. The command then waits for the
 * next entity, at the same distance, until Esc.
 *
 * A Polyline (a rectangle, a filleted outline) is offset as a WHOLE: every
 * side moves the same way, sharp corners stay sharp, rounded ones keep
 * their centre, and the result is one outline again.
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { entityAt } from "../engine/picking";
import { Polyline, bulgeToArc } from "../entities/polyline";
import { joinAll } from "./join";
import { parsePositiveFloat } from "../input/dynamicInput";

export class OffsetCommand extends BaseCommand {
  private targetEntity: Entity | null = null;
  private currentMousePos: Point | null = null;
  private distance = 10.0;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.targetEntity = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("OFFSET", `Select Entity (Distance: ${this.distance.toFixed(2)}, or type a new distance)`);
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  pick(): ((entity: Entity) => boolean) | null {
    return this.targetEntity === null ? (e) => this.isOffsettable(e) : null;
  }

  private isOffsettable(e: Entity): boolean {
    return e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Polyline;
  }

  /** The whole outline, `distance` to the side `sidePos` is on -- or null if
   *  it cannot be done (the outline would collapse on itself). */
  private offsetPolyline(pl: Polyline, sidePos: Point): Entity[] | null {
    const n = pl.vertices.length;
    const count = pl.closed ? n : n - 1;
    if (count < 1) return null;
    const edges = Array.from({ length: count }, (_, i) => ({ p1: pl.vertices[i]!.point, p2: pl.vertices[(i + 1) % n]!.point, bulge: pl.vertices[i]!.bulge }));
    const cross = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

    // Which side of the direction of travel: +1 = the side cross() is positive on.
    let side: number;
    if (pl.closed) {
      let area = 0;
      let inside = false;
      for (const { p1, p2 } of edges) {
        area += p1.x * p2.y - p2.x * p1.y;
        if (p1.y > sidePos.y !== p2.y > sidePos.y && sidePos.x < ((p2.x - p1.x) * (sidePos.y - p1.y)) / (p2.y - p1.y) + p1.x) inside = !inside;
      }
      side = area > 0 === inside ? 1 : -1;
    } else {
      let best = Infinity;
      side = 1;
      for (const { p1, p2 } of edges) {
        const len2 = (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((sidePos.x - p1.x) * (p2.x - p1.x) + (sidePos.y - p1.y) * (p2.y - p1.y)) / len2));
        const d = Math.hypot(sidePos.x - (p1.x + t * (p2.x - p1.x)), sidePos.y - (p1.y + t * (p2.y - p1.y)));
        if (d < best) {
          best = d;
          side = cross(p1, p2, sidePos) >= 0 ? 1 : -1;
        }
      }
    }

    const opts = { lineType: pl.lineType };
    const pieces: (Line | Arc)[] = [];
    for (const { p1, p2, bulge } of edges) {
      if (bulge === 0) {
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (len === 0) continue;
        const ox = (-(p2.y - p1.y) / len) * side * this.distance;
        const oy = ((p2.x - p1.x) / len) * side * this.distance;
        pieces.push(new Line({ x: p1.x + ox, y: p1.y + oy }, { x: p2.x + ox, y: p2.y + oy }, opts));
      } else {
        const arc = bulgeToArc(p1, p2, bulge, opts);
        // toward the arc's own centre the radius shrinks, away from it it grows
        const centreSide = cross(p1, p2, arc.center) > 0 ? 1 : -1;
        const radius = arc.radius + (centreSide === side ? -this.distance : this.distance);
        if (radius <= 0.01) return null;
        pieces.push(new Arc(arc.center, radius, arc.startAngle, arc.endAngle, opts));
      }
    }

    // Sharp corners: two straight sides meet again where their offsets cross.
    const pairs = pl.closed ? pieces.length : pieces.length - 1;
    for (let i = 0; i < pairs; i++) {
      const a = pieces[i]!;
      const b = pieces[(i + 1) % pieces.length]!;
      if (!(a instanceof Line) || !(b instanceof Line) || a === b) continue;
      const d1 = { x: a.endPoint.x - a.startPoint.x, y: a.endPoint.y - a.startPoint.y };
      const d2 = { x: b.endPoint.x - b.startPoint.x, y: b.endPoint.y - b.startPoint.y };
      const denom = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(denom) < 1e-12) continue;
      const t = ((b.startPoint.x - a.startPoint.x) * d2.y - (b.startPoint.y - a.startPoint.y) * d2.x) / denom;
      const corner = { x: a.startPoint.x + t * d1.x, y: a.startPoint.y + t * d1.y };
      a.endPoint = corner;
      b.startPoint = { ...corner };
    }
    // A side that came out pointing backwards: the distance is more than the outline has room for.
    let k = 0;
    for (const { p1, p2, bulge } of edges) {
      if (bulge !== 0) {
        k++;
        continue;
      }
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) === 0) continue;
      const line = pieces[k++] as Line;
      if ((line.endPoint.x - line.startPoint.x) * (p2.x - p1.x) + (line.endPoint.y - line.startPoint.y) * (p2.y - p1.y) <= 0) return null;
    }
    return joinAll(pieces).result;
  }

  leftClick(worldPos: Point): void {
    if (this.targetEntity === null) {
      const candidates = this.document.getEntities().filter((e) => this.isOffsettable(e));
      const hit = entityAt(candidates, worldPos, this.engine.pickTolerance());
      if (hit === null) return;
      this.targetEntity = hit;
      this.currentMousePos = { ...worldPos };
      this.commandBar.setStatus("OFFSET", "Click Offset Side");
    } else {
      this.currentMousePos = { ...worldPos };
      this.executeOffset();
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    if (this.targetEntity === null) return;
    this.currentMousePos = worldPos;
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    const distance = parsePositiveFloat(text);
    if (distance === null) {
      this.commandBar.setStatus("OFFSET", "Invalid - enter a positive distance");
      return;
    }
    this.distance = distance;
    this.start();
  }

  private calculateOffsetGeometry(sidePos: Point): Entity[] | null {
    const entity = this.targetEntity!;
    if (entity instanceof Polyline) return this.offsetPolyline(entity, sidePos);
    const one = this.offsetOne(entity, sidePos);
    return one === null ? null : [one];
  }

  private offsetOne(entity: Entity, sidePos: Point): Entity | null {
    if (entity instanceof Line) {
      const x1 = entity.startPoint.x, y1 = entity.startPoint.y;
      const x2 = entity.endPoint.x, y2 = entity.endPoint.y;
      const dx = x2 - x1, dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length === 0) return null;
      let nx = -dy / length, ny = dx / length;
      const cross = (x2 - x1) * (sidePos.y - y1) - (y2 - y1) * (sidePos.x - x1);
      if (cross < 0) {
        nx = -nx;
        ny = -ny;
      }
      const ox = nx * this.distance, oy = ny * this.distance;
      return new Line({ x: x1 + ox, y: y1 + oy }, { x: x2 + ox, y: y2 + oy }, { lineType: entity.lineType });
    }
    if (entity instanceof Circle || entity instanceof Arc) {
      const clickDist = Math.hypot(sidePos.x - entity.center.x, sidePos.y - entity.center.y);
      const newRadius = clickDist >= entity.radius ? entity.radius + this.distance : entity.radius - this.distance;
      if (newRadius <= 0.01) return null;
      return entity instanceof Circle
        ? new Circle(entity.center, newRadius, { lineType: entity.lineType })
        : new Arc(entity.center, newRadius, entity.startAngle, entity.endAngle, { lineType: entity.lineType });
    }
    return null;
  }

  private executeOffset(): void {
    const made = this.calculateOffsetGeometry(this.currentMousePos!);
    if (made === null) {
      this.start();
      return;
    }
    this.undo.push(this.document.toDict());
    for (const e of made) this.document.addEntity(e);
    this.start();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.targetEntity === null) return;
    this.targetEntity.drawSelected(ctx, this.engine.viewport);

    if (this.currentMousePos !== null) {
      for (const e of this.calculateOffsetGeometry(this.currentMousePos) ?? []) e.draw(ctx, this.engine.viewport, true);
    }
  }

  cancel(): void {
    this.targetEntity = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
