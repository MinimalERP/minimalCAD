/**
 * MinimalCAD Web
 * core/constraints.ts
 *
 * Ported from constraints.py: one-shot distance-constraint solver backing
 * commands/constrainDistance.ts.
 *
 * Scope: a "driven" point feature (a Circle/Arc/Ellipse center, or a Line's
 * start/end/midpoint) can be positioned by one or more distance constraints
 * against "reference" features (another such point, or a Line's own
 * infinite edge). This is NOT a persistent/live parametric link -- solving
 * happens once, at the moment a constraint is added, using the driven
 * point's current position as the seed. Later edits to a reference entity
 * do not retroactively re-solve anything.
 *
 * Not a general 2D sketch solver: only the driven point's own two
 * coordinates are unknowns. Every reference is treated as fixed for the
 * duration of the solve, and only one point moves per solve.
 *
 * Constraints are LIVE: enforceConstraints() re-applies all of them, so a
 * constrained shape keeps its place when what it is measured from moves
 * (it is run before every redraw, and on every part rebuild). Besides
 * distances there are simple geometric kinds -- horizontal, vertical,
 * parallel, perpendicular, equal, coincident -- each a rule the driven
 * entity follows from its reference.
 *
 * Constraints are stored as plain objects in Document.constraints (the
 * same passthrough array every other part of this app already round-trips
 * opaquely) -- this module is what first gives that array real meaning.
 */

import type { Point } from "./types";
import type { Document } from "./document";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Ellipse } from "../entities/ellipse";

export type PointFeature = "center" | "start" | "end" | "mid";
export type ReferenceFeature = "edge" | "center";
export type ConstraintKind = "distance" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "equal" | "coincident";

/** Matches the exact field names Document.constraints already round-trips
 *  opaquely (see core/document.ts) -- snake_case here isn't a style
 *  violation, it's the on-the-wire/on-disk shape shared with the desktop
 *  app's own constraints.py, and with any .jcad file it wrote. */
export interface Constraint {
  id: string;
  driven_entity_id: string;
  driven_feature: PointFeature;
  ref_entity_id: string;
  ref_feature: ReferenceFeature;
  target: number;
  /** Set when the reference is not an entity of this document but
   *  reference geometry shown behind a part sketch (a projected edge of the
   *  solid): the edge's two ends, or the centre point, as they were when the
   *  constraint was made. `ref_entity_id` is then "". */
  ref_geom?: { a: Point; b: Point } | { p: Point };
  /** Which edge of the solid that reference geometry is (opaque here; the
   *  part layer names it by the faces it runs between), so the constraint
   *  follows the model: Document.modelRef resolves it. */
  ref_model?: unknown;
  /** Absent = "distance". */
  kind?: ConstraintKind;
  /** Coincident: which point of a Line reference (its centre otherwise). */
  ref_point?: PointFeature;
}

export const kindOf = (c: Pick<Constraint, "kind">): ConstraintKind => c.kind ?? "distance";

/** Max leftover distance error (world units) after solving for a set of
 *  constraints to still count as satisfied -- above this, the constraints
 *  are mutually inconsistent (over-constrained) and the caller should
 *  treat the newest one as rejected rather than silently landing somewhere
 *  wrong. */
export const RESIDUAL_TOLERANCE = 1e-4;

const MAX_ITERATIONS = 50;

type PointEntity = Circle | Arc | Ellipse;
export type Drivable = Line | PointEntity;

function isPointEntity(e: Entity): e is PointEntity {
  return e instanceof Circle || e instanceof Arc || e instanceof Ellipse;
}

export function isDrivable(e: Entity): e is Drivable {
  return e instanceof Line || isPointEntity(e);
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** World-space point for a (entity, feature) pair. `feature` is "center"
 *  for Circle/Arc/Ellipse, or "start"/"end"/"mid" for a Line. */
export function featurePoint(entity: Drivable, feature: PointFeature): Point {
  if (isPointEntity(entity)) return { ...entity.center };
  if (feature === "start") return { ...entity.startPoint };
  if (feature === "end") return { ...entity.endPoint };
  return entity.midpoint();
}

/** Which feature a plain entity click implies as the DRIVEN point --
 *  center for Circle/Arc/Ellipse, or whichever of a Line's start/end/mid
 *  the click landed nearest to. null for entity types with no constrainable
 *  point feature (Polyline, Text, Dimension -- not Drivable). */
export function defaultFeatureForClick(entity: Entity, clickPt: Point): PointFeature | null {
  if (isPointEntity(entity)) return "center";
  if (entity instanceof Line) {
    const candidates: { key: PointFeature; point: Point }[] = [
      { key: "start", point: entity.startPoint },
      { key: "end", point: entity.endPoint },
      { key: "mid", point: entity.midpoint() },
    ];
    let best = candidates[0]!;
    for (const c of candidates) {
      if (dist(clickPt, c.point) < dist(clickPt, best.point)) best = c;
    }
    return best.key;
  }
  return null;
}

/** Which feature a plain entity click implies as a REFERENCE -- a Line's
 *  own infinite edge (for perpendicular distance), or a point entity's
 *  center. null if unsupported. */
export function referenceFeatureFor(entity: Entity): ReferenceFeature | null {
  if (entity instanceof Line) return "edge";
  if (isPointEntity(entity)) return "center";
  return null;
}

/**
 * Directed distance from `point` to a reference feature, and its gradient
 * (unit vector: the direction `point` would need to move to increase that
 * distance) -- the building block for the constraint solver below.
 *
 * - refFeature === "edge" (a Line): SIGNED perpendicular distance to the
 *   line's own infinite extension. Signed (not absolute) so it stays
 *   linear and differentiable even as the solve crosses the line, and so a
 *   constraint can pin the driven point to a specific side of it (see
 *   commands/constrainDistance.ts, which fixes the sign from the side the
 *   point was already on when the constraint was created).
 * - otherwise (a point feature): plain Euclidean distance (always >= 0);
 *   gradient points away from the reference point.
 */
export function rawDistanceAndGradient(
  refEntity: Drivable,
  refFeature: ReferenceFeature,
  point: Point,
): { distance: number; gradient: Point } {
  if (refFeature === "edge") {
    const line = refEntity as Line;
    const p1 = line.startPoint;
    const p2 = line.endPoint;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return { distance: 0, gradient: { x: 0, y: 0 } };
    // Unit normal (rotate direction by +90 degrees) -- constant everywhere,
    // so this residual is exactly linear in `point`.
    const nx = -dy / length;
    const ny = dx / length;
    const signed = (point.x - p1.x) * nx + (point.y - p1.y) * ny;
    return { distance: signed, gradient: { x: nx, y: ny } };
  }

  const refPt = featurePoint(refEntity, "center");
  const vx = point.x - refPt.x;
  const vy = point.y - refPt.y;
  const d = Math.hypot(vx, vy);
  if (d < 1e-9) return { distance: 0, gradient: { x: 1, y: 0 } }; // degenerate: point sits exactly on the reference; pick an arbitrary direction
  return { distance: d, gradient: { x: vx / d, y: vy / d } };
}

export interface ConstraintRef {
  refEntity: Drivable;
  refFeature: ReferenceFeature;
  target: number;
}

/**
 * Gauss-Newton least-squares solve for the 2D point satisfying every
 * {refEntity, refFeature, target} triple in `refs` as closely as possible,
 * seeded at `current` (so an under-determined system -- e.g. a single
 * reference -- lands at the *nearest* valid point instead of an arbitrary
 * one).
 *
 * Returns {point, residual}. `point` is null only if the normal equations
 * are degenerate throughout (e.g. no references at all, or every reference
 * gradient is parallel with no unique minimum) -- callers should treat
 * that the same as an unacceptably large residual.
 */
export function solvePoint(current: Point, refs: ConstraintRef[]): { point: Point | null; residual: number } {
  if (refs.length === 0) return { point: null, residual: Infinity };

  let p = { ...current };
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const rows = refs.map(({ refEntity, refFeature, target }) => {
      const { distance, gradient } = rawDistanceAndGradient(refEntity, refFeature, p);
      return { gx: gradient.x, gy: gradient.y, r: distance - target };
    });

    let jtj00 = 0;
    let jtj01 = 0;
    let jtj11 = 0;
    let jtr0 = 0;
    let jtr1 = 0;
    for (const { gx, gy, r } of rows) {
      jtj00 += gx * gx;
      jtj01 += gx * gy;
      jtj11 += gy * gy;
      jtr0 += gx * r;
      jtr1 += gy * r;
    }

    // Levenberg-Marquardt damping: J^T J is exactly singular whenever
    // there's only one constraint (or every constraint's gradient is
    // parallel) -- the ordinary, expected case for a single reference, not
    // a rare edge case. A tiny fixed damping on the diagonal makes the
    // system solvable in every case, converging to the minimum-norm
    // (least-movement) correction as damping -> 0, while leaving a
    // well-determined 2+-independent-constraint solve unperturbed (its jtj
    // magnitudes are O(1), swamping a 1e-9 damping term).
    const damping = 1e-9;
    jtj00 += damping;
    jtj11 += damping;

    const det = jtj00 * jtj11 - jtj01 * jtj01;
    if (Math.abs(det) < 1e-15) break; // still degenerate (e.g. zero constraints slipped through)

    const dx = -(jtj11 * jtr0 - jtj01 * jtr1) / det;
    const dy = -(jtj00 * jtr1 - jtj01 * jtr0) / det;
    p = { x: p.x + dx, y: p.y + dy };
    if (dx * dx + dy * dy < 1e-20) break;
  }

  let residual = 0;
  for (const { refEntity, refFeature, target } of refs) {
    const { distance } = rawDistanceAndGradient(refEntity, refFeature, p);
    residual = Math.max(residual, Math.abs(distance - target));
  }
  return { point: p, residual };
}

/** The entity a constraint measures from: one of the document's own, or a
 *  stand-in built from its stored reference geometry (see ref_geom). */
export function referenceEntity(document: Document, constraint: Pick<Constraint, "ref_entity_id" | "ref_geom" | "ref_model">): Drivable | null {
  // The solid's edge as it is now, if the part layer can still find it.
  if (constraint.ref_model !== undefined && document.modelRef !== null) {
    const live = document.modelRef(constraint);
    if (live instanceof Line || live instanceof Circle || live instanceof Arc || live instanceof Ellipse) return live;
  }
  const g = constraint.ref_geom;
  if (g !== undefined) return "p" in g ? new Circle({ ...g.p }, 1) : new Line({ ...g.a }, { ...g.b });
  const ent = entityById(document, constraint.ref_entity_id);
  return ent !== null && isDrivable(ent) ? ent : null;
}

/** ref_geom for reference geometry `entity` (not one of the document's). */
export function referenceGeometry(entity: Drivable): NonNullable<Constraint["ref_geom"]> {
  return entity instanceof Line ? { a: { ...entity.startPoint }, b: { ...entity.endPoint } } : { p: { ...entity.center } };
}

export function entityById(document: Document, entityId: string): Entity | null {
  for (const entity of document.getEntities()) {
    if (entity.id === entityId) return entity;
  }
  return null;
}

/** Perpendicular foot of `pt` on segment p1-p2, clamped to the segment --
 *  used to anchor a constraint line's visual endpoint on an "edge"
 *  reference at a sensible spot along the actual drawn wall, not off in
 *  space along its infinite extension. */
function closestPointOnSegment(pt: Point, p1: Point, p2: Point): Point {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return { ...p1 };
  let t = ((pt.x - p1.x) * dx + (pt.y - p1.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return { x: p1.x + t * dx, y: p1.y + t * dy };
}

/** (drivenPoint, refPoint) to draw/hit-test a constraint's visual line
 *  between, or null if either entity it references has since been deleted
 *  (shouldn't normally happen -- Document.removeEntity prunes constraints
 *  referencing a deleted entity -- but tolerate it rather than crash on
 *  stale/foreign data). */
export function constraintLinePoints(document: Document, constraint: Constraint): [Point, Point] | null {
  if (kindOf(constraint) !== "distance") return null; // geometric kinds show a glyph, not a line
  const driven = entityById(document, constraint.driven_entity_id);
  const ref = referenceEntity(document, constraint);
  if (driven === null || ref === null || !isDrivable(driven)) return null;

  const drivenPt = featurePoint(driven, constraint.driven_feature);
  const refPt =
    constraint.ref_feature === "edge"
      ? closestPointOnSegment(drivenPt, (ref as Line).startPoint, (ref as Line).endPoint)
      : featurePoint(ref, "center");
  return [drivenPt, refPt];
}

/** The constraint whose visual line falls within `tolerance` of `worldPos`,
 *  or null -- checked only after a normal entity hit-test comes up empty,
 *  so a faint constraint line never steals a click away from real geometry
 *  it happens to run alongside. */
export function constraintAt(document: Document, worldPos: Point, tolerance: number): Constraint | null {
  let best: Constraint | null = null;
  let bestDist = tolerance;
  for (const c of document.constraints as Constraint[]) {
    const pts = constraintLinePoints(document, c);
    if (pts === null) continue;
    const [p1, p2] = pts;
    const d = dist(worldPos, closestPointOnSegment(worldPos, p1, p2));
    if (d <= bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** The distance a constraint's line shows: the real one, as the geometry
 *  stands now. null if either end is gone. */
export function constraintValue(document: Document, constraint: Constraint): number | null {
  if (kindOf(constraint) !== "distance") return null;
  const driven = entityById(document, constraint.driven_entity_id);
  const ref = referenceEntity(document, constraint);
  if (driven === null || ref === null || !isDrivable(driven)) return null;
  return Math.abs(rawDistanceAndGradient(ref, constraint.ref_feature, featurePoint(driven, constraint.driven_feature)).distance);
}

/**
 * Changes one constraint's distance and moves its entity to suit, solving
 * together with the entity's other constraints (so a second one still
 * holds). Returns null when done, or why it can't be.
 */
export function setConstraintDistance(document: Document, id: string, magnitude: number): string | null {
  const all = document.constraints as Constraint[];
  const c = all.find((x) => x.id === id);
  const driven = c === undefined ? null : entityById(document, c.driven_entity_id);
  if (c === undefined || driven === null || !isDrivable(driven)) return "That constraint's entity is gone";
  // Same side of a reference edge as before.
  const target = c.ref_feature === "edge" && c.target < 0 ? -magnitude : magnitude;
  const refs: ConstraintRef[] = [];
  for (const k of all) {
    if (k.driven_entity_id !== c.driven_entity_id) continue;
    const ent = referenceEntity(document, k);
    if (ent !== null) refs.push({ refEntity: ent, refFeature: k.ref_feature, target: k === c ? target : k.target });
  }
  const { point, residual } = solvePoint(featurePoint(driven, c.driven_feature), refs);
  if (point === null || residual > RESIDUAL_TOLERANCE) return "Conflicts with another constraint on this entity";
  applyDrivenMove(driven, c.driven_feature, point);
  c.target = target;
  return null;
}

/** Relocates `entity` so its `feature` point lands at `newPoint`. */
export function applyDrivenMove(entity: Drivable, feature: PointFeature, newPoint: Point): void {
  if (isPointEntity(entity)) {
    const old = entity.center;
    entity.move(newPoint.x - old.x, newPoint.y - old.y);
    return;
  }
  if (feature === "start") entity.startPoint = { ...newPoint };
  else if (feature === "end") entity.endPoint = { ...newPoint };
  else {
    // "mid" -- translate the whole line so its midpoint lands there.
    const old = entity.midpoint();
    entity.move(newPoint.x - old.x, newPoint.y - old.y);
  }
}

// --- Live enforcement & the geometric kinds ---

function lineDir(l: Line): Point {
  const dx = l.endPoint.x - l.startPoint.x;
  const dy = l.endPoint.y - l.startPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Turns `line` about its middle to lie along `dir` (whichever way round is
 *  the smaller turn), keeping its length. Returns how far its ends moved. */
function alignLine(line: Line, dir: Point): number {
  const cur = lineDir(line);
  const d = cur.x * dir.x + cur.y * dir.y >= 0 ? dir : { x: -dir.x, y: -dir.y };
  const half = dist(line.startPoint, line.endPoint) / 2;
  const m = line.midpoint();
  const a = { x: m.x - d.x * half, y: m.y - d.y * half };
  const b = { x: m.x + d.x * half, y: m.y + d.y * half };
  const moved = Math.max(dist(a, line.startPoint), dist(b, line.endPoint));
  line.startPoint = a;
  line.endPoint = b;
  return moved;
}

/** Sets a line's length about its middle; returns how far its ends moved. */
function resizeLine(line: Line, length: number): number {
  const d = lineDir(line);
  const m = line.midpoint();
  const a = { x: m.x - (d.x * length) / 2, y: m.y - (d.y * length) / 2 };
  const moved = dist(a, line.startPoint);
  line.startPoint = a;
  line.endPoint = { x: m.x + (d.x * length) / 2, y: m.y + (d.y * length) / 2 };
  return moved;
}

/** The point a coincident constraint pins to, on its reference. */
function coincidentTarget(ref: Drivable, constraint: Constraint): Point {
  if (!(ref instanceof Line)) return featurePoint(ref, "center");
  // A point of the solid: whichever end / middle is nearest where it was picked.
  const g = constraint.ref_geom;
  if (constraint.ref_model !== undefined && g !== undefined && "p" in g) {
    const candidates = [ref.startPoint, ref.endPoint, ref.midpoint()];
    return { ...candidates.reduce((best, p) => (dist(p, g.p) < dist(best, g.p) ? p : best)) };
  }
  return featurePoint(ref, constraint.ref_point ?? "mid");
}

/** A coincident constraint's stand-in reference when its point is plain
 *  reference geometry (ref_geom {p} with no line behind it). */
function referenceFor(document: Document, constraint: Constraint): Drivable | null {
  return referenceEntity(document, constraint);
}

/** Applies one geometric constraint; returns how far it moved things, or
 *  null if it can't apply (wrong entity kinds, something deleted). */
function applyGeometric(document: Document, c: Constraint): number | null {
  const driven = entityById(document, c.driven_entity_id);
  if (driven === null || !isDrivable(driven)) return null;
  const kind = kindOf(c);
  if (kind === "horizontal" || kind === "vertical") {
    return driven instanceof Line ? alignLine(driven, kind === "horizontal" ? { x: 1, y: 0 } : { x: 0, y: 1 }) : null;
  }
  const ref = referenceFor(document, c);
  if (ref === null) return null;
  if (kind === "parallel" || kind === "perpendicular") {
    if (!(driven instanceof Line) || !(ref instanceof Line)) return null;
    const d = lineDir(ref);
    return alignLine(driven, kind === "parallel" ? d : { x: -d.y, y: d.x });
  }
  if (kind === "equal") {
    if (driven instanceof Line && ref instanceof Line) return resizeLine(driven, dist(ref.startPoint, ref.endPoint));
    if ((driven instanceof Circle || driven instanceof Arc) && (ref instanceof Circle || ref instanceof Arc)) {
      const moved = Math.abs(driven.radius - ref.radius);
      driven.radius = ref.radius;
      return moved;
    }
    return null;
  }
  if (kind === "coincident") {
    const target = coincidentTarget(ref, c);
    const moved = dist(featurePoint(driven, c.driven_feature), target);
    if (moved > 0) applyDrivenMove(driven, c.driven_feature, target);
    return moved;
  }
  return null;
}

/** How far a constraint is from holding right now (world units; 0 = it
 *  holds), or null if it can't be evaluated. */
export function constraintError(document: Document, c: Constraint): number | null {
  const driven = entityById(document, c.driven_entity_id);
  if (driven === null || !isDrivable(driven)) return null;
  const kind = kindOf(c);
  if (kind === "horizontal" || kind === "vertical") {
    if (!(driven instanceof Line)) return null;
    const d = lineDir(driven);
    return Math.abs(kind === "horizontal" ? d.y : d.x) * dist(driven.startPoint, driven.endPoint);
  }
  const ref = referenceEntity(document, c);
  if (ref === null) return null;
  if (kind === "distance") return Math.abs(rawDistanceAndGradient(ref, c.ref_feature, featurePoint(driven, c.driven_feature)).distance - c.target);
  if (kind === "parallel" || kind === "perpendicular") {
    if (!(driven instanceof Line) || !(ref instanceof Line)) return null;
    const a = lineDir(driven);
    const b = lineDir(ref);
    const off = kind === "parallel" ? a.x * b.y - a.y * b.x : a.x * b.x + a.y * b.y;
    return Math.abs(off) * dist(driven.startPoint, driven.endPoint);
  }
  if (kind === "equal") {
    if (driven instanceof Line && ref instanceof Line) return Math.abs(dist(driven.startPoint, driven.endPoint) - dist(ref.startPoint, ref.endPoint));
    if ((driven instanceof Circle || driven instanceof Arc) && (ref instanceof Circle || ref instanceof Arc)) return Math.abs(driven.radius - ref.radius);
    return null;
  }
  return dist(featurePoint(driven, c.driven_feature), coincidentTarget(ref, c));
}

/**
 * Makes every constraint hold again, moving each driven entity as its
 * constraints require. Run after anything may have moved (every redraw;
 * every part rebuild). Constraints are applied in turn and the whole set
 * repeated until nothing moves, so a shape measured from another
 * constrained shape settles too. Returns true if anything was moved.
 */
export function enforceConstraints(document: Document): boolean {
  const all = document.constraints as Constraint[];
  if (all.length === 0) return false;
  const EPS = 1e-9;
  let any = false;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    // Shape rules first (they turn / resize the entity about its middle)...
    for (const c of all) {
      if (kindOf(c) === "distance") continue;
      const d = applyGeometric(document, c);
      if (d !== null && d > EPS) moved = true;
    }
    // ...then where it sits: all of an entity point's distances solved together.
    const seen = new Set<string>();
    for (const c of all) {
      if (kindOf(c) !== "distance") continue;
      const key = `${c.driven_entity_id}|${c.driven_feature}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const driven = entityById(document, c.driven_entity_id);
      if (driven === null || !isDrivable(driven)) continue;
      const refs: ConstraintRef[] = [];
      for (const k of all) {
        if (kindOf(k) !== "distance" || k.driven_entity_id !== c.driven_entity_id || k.driven_feature !== c.driven_feature) continue;
        const ent = referenceEntity(document, k);
        if (ent !== null) refs.push({ refEntity: ent, refFeature: k.ref_feature, target: k.target });
      }
      const at = featurePoint(driven, c.driven_feature);
      const { point, residual } = solvePoint(at, refs);
      if (point === null || residual > RESIDUAL_TOLERANCE) continue; // can't all hold: leave it where it is
      if (dist(point, at) > EPS) {
        applyDrivenMove(driven, c.driven_feature, point);
        moved = true;
      }
    }
    if (!moved) break;
    any = true;
  }
  return any;
}
