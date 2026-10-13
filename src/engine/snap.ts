/**
 * MinimalCAD Web
 * engine/snap.ts
 *
 * Ported from graphics/snap.py -- full priority-ordered osnap search:
 * Endpoint, Intersection, Midpoint, Center, Quadrant, Perpendicular (needs a
 * reference point), Tangent (needs a reference point), Center-via-curve-
 * hover fallback, Nearest. Within one kind, the point closest to the cursor
 * wins.
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

const TWO_PI = 2.0 * Math.PI;

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

/** The candidate closest to the cursor, if any lies within `tolerance` --
 *  never just the first one found, so where two snap points of one kind
 *  are both in reach the marker goes to the one being pointed at. */
function closestOf(worldPos: Point, points: Point[], tolerance: number): Point | null {
  let best: Point | null = null;
  let bestDist = Infinity;
  for (const pt of points) {
    const d = dist(worldPos, pt);
    if (d <= tolerance && d < bestDist) {
      best = pt;
      bestDist = d;
    }
  }
  return best;
}

/** Is `pt` (a point of the full ellipse) on the part that is drawn? */
function onEllipseSweep(ellipse: Ellipse, pt: Point, tolerance: number): boolean {
  return ellipse.isFull() || ellipse.hitTest(pt, tolerance);
}

function findEndpoint(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Line) {
      points.push({ ...entity.startPoint }, { ...entity.endPoint });
    } else if (entity instanceof Arc) {
      points.push(entity.pointAt(entity.startAngle), entity.pointAt(entity.endAngle));
    } else if (entity instanceof Ellipse && !entity.isFull()) {
      // A full ellipse (unlike Arc, which has no "full" representation of
      // its own -- see trim.ts) has no real endpoints to snap to; skip it,
      // same as Circle never reaching this function's Line/Arc-only branches.
      points.push(entity.pointAt(entity.startAngle), entity.pointAt(entity.endAngle));
    }
  }
  return closestOf(worldPos, points, tolerance);
}

/** Every crossing of two lines / circles / arcs / ellipses, reusing
 *  geometry/intersect.ts's own (gap=0, i.e. genuinely bounded/touching, no
 *  near-miss widening) intersection math -- the same correctness Trim
 *  already relies on. */
function findIntersection(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const curves = entities.filter(
    (e) => e instanceof Line || e instanceof Circle || e instanceof Arc || e instanceof Ellipse,
  );
  const bounds = curves.map((c) => c.getBounds());
  const points: Point[] = [];
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      if (!boundsOverlap(bounds[i]!, bounds[j]!, tolerance)) continue;
      points.push(...findIntersections(curves[i]!, curves[j]!, 0));
    }
  }
  return closestOf(worldPos, points, tolerance);
}

function findMidpoint(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Line) {
      points.push(entity.midpoint());
    } else if (entity instanceof Arc) {
      const sweep = (((entity.endAngle - entity.startAngle) % TWO_PI) + TWO_PI) % TWO_PI;
      if (sweep > 0) points.push(entity.pointAt(entity.startAngle + sweep / 2));
    }
  }
  return closestOf(worldPos, points, tolerance);
}

function findCenter(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Circle || entity instanceof Arc || entity instanceof Ellipse) {
      points.push({ ...entity.center });
    }
  }
  return closestOf(worldPos, points, tolerance);
}

function findQuadrant(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Circle) {
      points.push(...entity.quadrantPoints());
    } else if (entity instanceof Arc) {
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        if (entity.angleInSweep(angle)) points.push(entity.pointAt(angle));
      }
    } else if (entity instanceof Ellipse) {
      for (const pt of entity.axisPoints()) {
        if (onEllipseSweep(entity, pt, tolerance)) points.push(pt);
      }
    }
  }
  return closestOf(worldPos, points, tolerance);
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
 *  two radius-aligned points (near side and far side) on a circle/arc.
 *
 *  `referencePoint` must be a point that stays put while the cursor moves
 *  (a line's start, the fixed end of a line being stretched). A foot that
 *  falls on the reference point itself -- the reference lies on that very
 *  entity -- is no perpendicular at all (a zero-length segment) and is
 *  left out. */
function findPerpendicular(
  worldPos: Point,
  entities: Entity[],
  tolerance: number,
  referencePoint: Point | null,
): Point | null {
  if (referencePoint === null) return null;
  const degenerate = tolerance * 1e-3;
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Line) {
      const foot = perpendicularFoot(referencePoint, entity.startPoint, entity.endPoint);
      if (foot !== null) points.push(foot);
    } else if (entity instanceof Circle || entity instanceof Arc) {
      const c = entity.center;
      if (dist(referencePoint, c) <= degenerate) continue; // from the center every radius is perpendicular
      const angle = Math.atan2(referencePoint.y - c.y, referencePoint.x - c.x);
      for (const a of [angle, angle + Math.PI]) {
        if (entity instanceof Arc && !entity.angleInSweep(a)) continue;
        points.push({ x: c.x + entity.radius * Math.cos(a), y: c.y + entity.radius * Math.sin(a) });
      }
    }
  }
  return closestOf(
    worldPos,
    points.filter((pt) => dist(referencePoint, pt) > degenerate),
    tolerance,
  );
}

/** Points on a circle/arc where a line from referencePoint touches tangentially. */
function findTangent(
  worldPos: Point,
  entities: Entity[],
  tolerance: number,
  referencePoint: Point | null,
): Point | null {
  if (referencePoint === null) return null;
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Circle || entity instanceof Arc) {
      const c = entity.center, r = entity.radius;
      const d = dist(referencePoint, c);
      if (d <= r) continue; // reference point is inside/on the circle: no external tangent

      const theta = Math.atan2(referencePoint.y - c.y, referencePoint.x - c.x);
      const alpha = Math.acos(r / d);

      for (const angle of [theta + alpha, theta - alpha]) {
        if (entity instanceof Arc && !entity.angleInSweep(angle)) continue;
        points.push({ x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) });
      }
    }
  }
  return closestOf(worldPos, points, tolerance);
}

/** Fallback for Center: hovering the exact center point is a tiny target --
 *  this triggers as soon as the cursor is anywhere on the entity's own
 *  drawn curve, same as how AutoCAD's Center osnap shows its marker as soon
 *  as the cursor nears the object. */
function findCenterOnCurve(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  for (const entity of entities) {
    if (
      (entity instanceof Circle || entity instanceof Arc || entity instanceof Ellipse) &&
      entity.hitTest(worldPos, tolerance)
    ) {
      return { ...entity.center };
    }
  }
  return null;
}

function findNearest(worldPos: Point, entities: Entity[], tolerance: number): Point | null {
  const points: Point[] = [];
  for (const entity of entities) {
    if (entity instanceof Line) {
      const { startPoint: p1, endPoint: p2 } = entity;
      const px = p2.x - p1.x;
      const py = p2.y - p1.y;
      const lenSq = px * px + py * py;
      if (lenSq === 0) continue;
      let u = ((worldPos.x - p1.x) * px + (worldPos.y - p1.y) * py) / lenSq;
      u = Math.max(0, Math.min(1, u));
      points.push({ x: p1.x + u * px, y: p1.y + u * py });
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
      points.push(nearest);
    } else if (entity instanceof Ellipse) {
      const nearest = entity.nearestBoundaryPoint(worldPos);
      if (nearest !== null && entity.hitTest(worldPos, tolerance)) points.push(nearest);
    }
  }
  return closestOf(worldPos, points, tolerance);
}

/** Scans `allEntities` and returns the highest-priority snap point within
 *  `tolerance`, or null if nothing resolves. `referencePoint` (the previous
 *  point picked in the active command, e.g. a line's start point) enables
 *  the direction-dependent Perpendicular/Tangent osnaps -- it has to be a
 *  point that stays where it is while the cursor moves, never the point
 *  being dragged: from the cursor itself, every point of a line is the
 *  foot of a perpendicular. */
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
