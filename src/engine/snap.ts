/**
 * MinimalCAD Web
 * engine/snap.ts
 *
 * Ported from graphics/snap.py -- full priority-ordered osnap search:
 * Endpoint, Intersection, Midpoint, Center, Quadrant, Perpendicular (needs a
 * reference point), Tangent (needs a reference point), Center-via-curve-
 * hover fallback, Nearest.
 */

import { boundsOverlap, type Point } from "../core/types";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Ellipse } from "../entities/ellipse";
import { Polyline } from "../entities/polyline";
import { findIntersections } from "../geometry/intersect";

export type SnapType =
  | "ENDPOINT"
  | "INTERSECTION"
  | "MIDPOINT"
  | "CENTER"
  | "QUADRANT"
  | "PERPENDICULAR"
  | "TANGENT"
  | "NEAREST";

export interface SnapMatch {
  point: Point;
  snapType: SnapType;
}

type CircleLike = Circle | Arc;

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function boundsNear(entity: Entity, pos: Point, radius: number): boolean {
  const [x0, y0, x1, y1] = entity.getBounds();
  return pos.x >= x0 - radius && pos.x <= x1 + radius && pos.y >= y0 - radius && pos.y <= y1 + radius;
}

/** Replaces every Polyline in the candidate list with its own throwaway
 *  per-segment Line/Arc entities, so every isinstance(Line)/isinstance(Arc)
 *  branch below picks up a polyline's vertices/edges for free. */
function expandPolylines(entities: Entity[]): Entity[] {
  const expanded: Entity[] = [];
  for (const entity of entities) {
    if (entity instanceof Polyline) {
      expanded.push(...entity.segmentEntities());
    } else {
      expanded.push(entity);
    }
  }
  return expanded;
}

function findEndpoint(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if (entity instanceof Line) {
      for (const pt of [entity.startPoint, entity.endPoint]) {
        if (dist(worldPos, pt) <= tolerance) return { ...pt };
      }
    } else if (entity instanceof Arc) {
      for (const pt of [entity.pointAt(entity.startAngle), entity.pointAt(entity.endAngle)]) {
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    } else if (entity instanceof Ellipse && !entity.isFull()) {
      // A full ellipse (unlike Arc, which has no "full" representation of
      // its own -- see trim.ts) has no real endpoints to snap to; skip it,
      // same as Circle never reaching this function's Line/Arc-only branches.
      for (const pt of [entity.pointAt(entity.startAngle), entity.pointAt(entity.endAngle)]) {
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    }
  }
  return null;
}

/** Line-Line, Line-Circle/Arc, and Circle/Arc-Circle/Arc intersections,
 *  reusing geometry/intersect.ts's own (gap=0, i.e. genuinely bounded/
 *  touching, no near-miss widening) intersection math -- the same
 *  correctness Trim already relies on. */
function findIntersection(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const lines = entities.filter((e): e is Line => e instanceof Line);
  const radials = entities.filter((e): e is CircleLike => e instanceof Circle || e instanceof Arc);
  const lineBounds = lines.map((l) => l.getBounds());
  const radialBounds = radials.map((r) => r.getBounds());

  for (let i = 0; i < lines.length; i++) {
    const b1 = lineBounds[i]!;
    for (let j = i + 1; j < lines.length; j++) {
      if (!boundsOverlap(b1, lineBounds[j]!, tolerance)) continue;
      for (const pt of findIntersections(lines[i]!, lines[j]!, 0)) {
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const bl = lineBounds[i]!;
    for (let j = 0; j < radials.length; j++) {
      if (!boundsOverlap(bl, radialBounds[j]!, tolerance)) continue;
      for (const pt of findIntersections(lines[i]!, radials[j]!, 0)) {
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    }
  }
  for (let i = 0; i < radials.length; i++) {
    const b1 = radialBounds[i]!;
    for (let j = i + 1; j < radials.length; j++) {
      if (!boundsOverlap(b1, radialBounds[j]!, tolerance)) continue;
      for (const pt of findIntersections(radials[i]!, radials[j]!, 0)) {
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    }
  }
  return null;
}

function findMidpoint(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if (entity instanceof Line) {
      const mid = entity.midpoint();
      if (dist(worldPos, mid) <= tolerance) return mid;
    }
  }
  return null;
}

function findCenter(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if (entity instanceof Circle || entity instanceof Arc) {
      if (dist(worldPos, entity.center) <= tolerance) return { ...entity.center };
    }
  }
  return null;
}

function findQuadrant(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if (entity instanceof Circle) {
      for (const q of entity.quadrantPoints()) {
        if (dist(worldPos, q) <= tolerance) return q;
      }
    } else if (entity instanceof Arc) {
      const c = entity.center;
      const r = entity.radius;
      const quadrants: [Point, number][] = [
        [{ x: c.x + r, y: c.y }, 0],
        [{ x: c.x, y: c.y - r }, -Math.PI / 2],
        [{ x: c.x - r, y: c.y }, Math.PI],
        [{ x: c.x, y: c.y + r }, Math.PI / 2],
      ];
      for (const [pt, angle] of quadrants) {
        if (!entity.angleInSweep(angle)) continue;
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    }
  }
  return null;
}

function perpendicularFoot(ref: Point, p1: Point, p2: Point): Point | null {
  const px = p2.x - p1.x, py = p2.y - p1.y;
  const lengthSq = px * px + py * py;
  if (lengthSq === 0) return null;
  const u = ((ref.x - p1.x) * px + (ref.y - p1.y) * py) / lengthSq;
  if (u < 0 || u > 1) return null; // only a foot landing within the segment counts
  return { x: p1.x + u * px, y: p1.y + u * py };
}

/** Point on an entity such that the segment from referencePoint to it is
 *  perpendicular to the entity -- foot of perpendicular on a line, or the
 *  radius-aligned point on a circle/arc. */
function findPerpendicular(
  worldPos: Point,
  entities: Entity[],
  tolerance: number,
  referencePoint: Point | null,
): Point | null {
  if (referencePoint === null) return null;
  for (const entity of entities) {
    if (entity instanceof Line) {
      const foot = perpendicularFoot(referencePoint, entity.startPoint, entity.endPoint);
      if (foot !== null && dist(worldPos, foot) <= tolerance) return foot;
    } else if (entity instanceof Circle || entity instanceof Arc) {
      const c = entity.center;
      const v = { x: referencePoint.x - c.x, y: referencePoint.y - c.y };
      const vLen = Math.sqrt(v.x * v.x + v.y * v.y);
      if (vLen === 0) continue;
      const pt: Point = { x: c.x + (v.x / vLen) * entity.radius, y: c.y + (v.y / vLen) * entity.radius };
      const angle = Math.atan2(pt.y - c.y, pt.x - c.x);
      if (entity instanceof Arc && !entity.angleInSweep(angle)) continue;
      if (dist(worldPos, pt) <= tolerance) return pt;
    }
  }
  return null;
}

/** Points on a circle/arc where a line from referencePoint touches tangentially. */
function findTangent(
  worldPos: Point,
  entities: Entity[],
  tolerance: number,
  referencePoint: Point | null,
): Point | null {
  if (referencePoint === null) return null;
  for (const entity of entities) {
    if (entity instanceof Circle || entity instanceof Arc) {
      const c = entity.center, r = entity.radius;
      const d = dist(referencePoint, c);
      if (d <= r) continue; // reference point is inside/on the circle: no external tangent

      const theta = Math.atan2(referencePoint.y - c.y, referencePoint.x - c.x);
      const alpha = Math.acos(r / d);

      for (const angle of [theta + alpha, theta - alpha]) {
        if (entity instanceof Arc && !entity.angleInSweep(angle)) continue;
        const pt: Point = { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
        if (dist(worldPos, pt) <= tolerance) return pt;
      }
    }
  }
  return null;
}

/** Fallback for Center: hovering the exact center point is a tiny target --
 *  this triggers as soon as the cursor is anywhere on the entity's own
 *  drawn curve, same as how AutoCAD's Center osnap shows its marker as soon
 *  as the cursor nears the object. */
function findCenterOnCurve(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if ((entity instanceof Circle || entity instanceof Arc) && entity.hitTest(worldPos, tolerance)) {
      return { ...entity.center };
    }
  }
  return null;
}

function findNearest(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if (entity instanceof Line) {
      const { startPoint: p1, endPoint: p2 } = entity;
      const px = p2.x - p1.x;
      const py = p2.y - p1.y;
      const lenSq = px * px + py * py;
      if (lenSq === 0) continue;
      let u = ((worldPos.x - p1.x) * px + (worldPos.y - p1.y) * py) / lenSq;
      u = Math.max(0, Math.min(1, u));
      const nearest: Point = { x: p1.x + u * px, y: p1.y + u * py };
      if (dist(worldPos, nearest) <= tolerance) return nearest;
    } else if (entity instanceof Circle || entity instanceof Arc) {
      const v = { x: worldPos.x - entity.center.x, y: worldPos.y - entity.center.y };
      const vLen = Math.sqrt(v.x * v.x + v.y * v.y);
      if (vLen === 0) continue;
      const nearest: Point = {
        x: entity.center.x + (v.x / vLen) * entity.radius,
        y: entity.center.y + (v.y / vLen) * entity.radius,
      };
      if (entity instanceof Arc) {
        const angle = Math.atan2(nearest.y - entity.center.y, nearest.x - entity.center.x);
        if (!entity.angleInSweep(angle)) continue;
      }
      if (dist(worldPos, nearest) <= tolerance) return nearest;
    }
  }
  return null;
}

/** Scans `allEntities` and returns the highest-priority snap point within
 *  `tolerance`, or null if nothing resolves. `referencePoint` (the previous
 *  point picked in the active command, e.g. a line's start point) enables
 *  the direction-dependent Perpendicular/Tangent osnaps. */
export function findSnap(
  worldPos: Point,
  allEntities: Entity[],
  tolerance: number,
  referencePoint: Point | null = null,
): SnapMatch | null {
  const candidates = expandPolylines(allEntities.filter((e) => boundsNear(e, worldPos, tolerance)));

  const endpoint = findEndpoint(worldPos, candidates, tolerance);
  if (endpoint !== null) return { point: endpoint, snapType: "ENDPOINT" };

  const intersection = findIntersection(worldPos, candidates, tolerance);
  if (intersection !== null) return { point: intersection, snapType: "INTERSECTION" };

  const midpoint = findMidpoint(worldPos, candidates, tolerance);
  if (midpoint !== null) return { point: midpoint, snapType: "MIDPOINT" };

  const center = findCenter(worldPos, candidates, tolerance);
  if (center !== null) return { point: center, snapType: "CENTER" };

  const quadrant = findQuadrant(worldPos, candidates, tolerance);
  if (quadrant !== null) return { point: quadrant, snapType: "QUADRANT" };

  const perpendicular = findPerpendicular(worldPos, candidates, tolerance, referencePoint);
  if (perpendicular !== null) return { point: perpendicular, snapType: "PERPENDICULAR" };

  const tangent = findTangent(worldPos, candidates, tolerance, referencePoint);
  if (tangent !== null) return { point: tangent, snapType: "TANGENT" };

  const centerOnCurve = findCenterOnCurve(worldPos, candidates, tolerance);
  if (centerOnCurve !== null) return { point: centerOnCurve, snapType: "CENTER" };

  const nearest = findNearest(worldPos, candidates, tolerance);
  if (nearest !== null) return { point: nearest, snapType: "NEAREST" };

  return null;
}
