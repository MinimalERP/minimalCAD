/**
 * MinimalCAD Web
 * commands/join.ts
 *
 * Ported from commands/join.py. Merges entities in two different ways,
 * tried in this order:
 *   1. Primitive merge: colinear Line segments (even with a gap or an
 *      overlap) collapse into a single Line; Arc segments sharing the same
 *      center and radius collapse into a single Arc, or a Circle if their
 *      combined sweep closes the full 360.
 *   2. Connect: anything else that shares a coincident endpoint -- a Line
 *      and an Arc meeting at an angle, two Arcs on different circles, a
 *      Line onto an already-joined Polyline, etc. -- is strung together
 *      into a single Polyline, the same way AutoCAD's JOIN turns a
 *      connected-but-not-colinear chain of objects into one polyline. If
 *      the chain loops back to its own start, the result is a closed
 *      Polyline.
 *
 * Two ways to invoke it:
 *   1. Pre-select two or more Line/Arc/Polyline entities before running
 *      JOIN -- every joinable/connectable pair in the selection is merged
 *      immediately, repeatedly (so a whole connected chain -- even a
 *      closed outline made of several different entity types -- collapses
 *      in a single run), as one undo step.
 *   2. With nothing pre-selected, click a first Line/Arc/Polyline, then a
 *      second -- mirrors commands/fillet.ts's pick-first/pick-second state
 *      machine, minus the corner math.
 *
 * In bulk mode, connect-merging is refused through any point where a third
 * entity in the selection also meets (an ambiguous T/Y-junction) -- same as
 * AutoCAD, and the same degree-2-only rule io/dxf.ts already applies before
 * it will walk a chain into a closed loop for export. A colinear primitive
 * merge is exempt from this check since two segments running straight
 * through a point stay unambiguous regardless of what else touches that
 * same point.
 *
 * Bulk mode also refuses to *bridge a real gap* between two colinear lines
 * when either facing end is already claimed by other connected geometry in
 * the selection -- e.g. two colinear edges of an outline with a
 * tab/bracket detour physically wired in between them. Interactive
 * click-click JOIN is exempt (a gap is always bridged there) since the
 * user explicitly picked those two exact lines.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import { BaseCommand } from "./base";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { Circle } from "../entities/circle";
import { Polyline, segmentBulge } from "../entities/polyline";
import type { Vertex } from "../entities/polyline";

const ANGLE_TOLERANCE_RAD = (0.5 * Math.PI) / 180; // how close two arc endpoints must be to count as "touching"
const LINE_ANGLE_TOLERANCE = (0.5 * Math.PI) / 180; // how close two line directions must be to count as colinear

/** World-unit tolerance for "coincident enough to join" checks -- fixed and
 *  absolute, matching io/dxf.ts's own POINT_MATCH_TOLERANCE for the same
 *  kind of chain-walking join, rather than derived from zoom or entity
 *  size (either of which would make JOIN swallow clearly-separate
 *  entities, or "connect" across a visible gap). */
const GEOMETRIC_TOLERANCE = 1e-4;

type Joinable = Line | Arc | Polyline;

function isJoinable(entity: Entity): entity is Joinable {
  return entity instanceof Line || entity instanceof Arc || entity instanceof Polyline;
}

function normalizeAngle(angle: number): number {
  const twoPi = 2.0 * Math.PI;
  return ((angle % twoPi) + twoPi) % twoPi;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Snaps a point to a GEOMETRIC_TOLERANCE grid for adjacency/degree
 *  matching -- same convention as io/dxf.ts's own pointKey. */
function pointKey(pt: Point): string {
  return `${Math.round(pt.x / GEOMETRIC_TOLERANCE)},${Math.round(pt.y / GEOMETRIC_TOLERANCE)}`;
}

/** Returns (start, end) for an open (connectable) entity, or null for
 *  anything with no free ends to connect (a closed Polyline, a Circle, or
 *  any other entity type JOIN doesn't handle at all). */
function endpointsOf(e: Entity): [Point, Point] | null {
  if (e instanceof Line) return [e.startPoint, e.endPoint];
  if (e instanceof Arc) return [e.pointAt(e.startAngle), e.pointAt(e.endAngle)];
  if (e instanceof Polyline && !e.closed && e.vertices.length > 0) {
    return [e.vertices[0]!.point, e.vertices[e.vertices.length - 1]!.point];
  }
  return null;
}

/** Returns `e`'s own geometry as a [(vertex, bulgeToNext), ...] list, as if
 *  it were already a small open Polyline -- a Line becomes 2 vertices with
 *  bulge 0, an Arc becomes 2 vertices with the bulge that reconstructs it,
 *  and an existing Polyline passes through as-is (copied, not shared). */
function asOpenSegments(e: Joinable): Vertex[] {
  if (e instanceof Line) {
    return [
      { point: { ...e.startPoint }, bulge: 0 },
      { point: { ...e.endPoint }, bulge: 0 },
    ];
  }
  if (e instanceof Arc) {
    const [p0, p1] = endpointsOf(e)!;
    return [
      { point: p0, bulge: segmentBulge(e) },
      { point: p1, bulge: 0 },
    ];
  }
  return e.vertices.map((v) => ({ point: { ...v.point }, bulge: v.bulge }));
}

/** Reverses a [(vertex, bulgeToNext), ...] chain so it describes the same
 *  physical path walked backward -- edge bulges shift down by one position
 *  and negate (reversing a curved segment's direction of travel reverses
 *  its CCW/CW sense), matching the exact convention io/dxf.ts's flipY uses
 *  for a mirrored Arc. */
function reverseSegments(segs: Vertex[]): Vertex[] {
  const n = segs.length;
  const revPoints = segs.map((s) => s.point).reverse();
  const revBulges = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    revBulges[i] = -segs[n - 2 - i]!.bulge;
  }
  return revPoints.map((point, i) => ({ point, bulge: revBulges[i]! }));
}

/** Counts, per point, how many free endpoints among `entities` land there.
 *  Bulk JOIN uses this so it never strings two entities together through a
 *  point where a third (or more) also meets -- an ambiguous T/Y-junction. */
function endpointDegreeMap(entities: Entity[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const e of entities) {
    const ends = endpointsOf(e);
    if (ends === null) continue;
    for (const p of ends) {
      const key = pointKey(p);
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  }
  return degree;
}

interface JoinResult {
  // Entity, not Joinable: two joined Arcs that close the full circle merge
  // into a Circle, which isn't itself further-joinable input.
  merged: Entity | null;
  reason: string | null;
}

function tryJoinLines(l1: Line, l2: Line, degreeMap: Map<string, number> | null): JoinResult {
  const d1x = l1.endPoint.x - l1.startPoint.x;
  const d1y = l1.endPoint.y - l1.startPoint.y;
  const len1 = Math.hypot(d1x, d1y);
  if (len1 === 0) return { merged: null, reason: "Degenerate (zero-length) line" };
  const ux = d1x / len1;
  const uy = d1y / len1;

  const d2x = l2.endPoint.x - l2.startPoint.x;
  const d2y = l2.endPoint.y - l2.startPoint.y;
  const len2 = Math.hypot(d2x, d2y);
  if (len2 === 0) return { merged: null, reason: "Degenerate (zero-length) line" };
  const u2x = d2x / len2;
  const u2y = d2y / len2;

  // Both unit vectors -- their cross product magnitude is directly
  // sin(angle between them), so this check is scale-independent.
  const cross = ux * u2y - uy * u2x;
  if (Math.abs(cross) > Math.sin(LINE_ANGLE_TOLERANCE)) return { merged: null, reason: "Lines are not colinear" };

  // Perpendicular offset of l2's start from l1's infinite line.
  const px = l2.startPoint.x - l1.startPoint.x;
  const py = l2.startPoint.y - l1.startPoint.y;
  const perpDist = Math.abs(px * uy - py * ux);
  if (perpDist > GEOMETRIC_TOLERANCE) return { merged: null, reason: "Lines are not colinear" };

  // Project every endpoint of both lines onto l1's own direction and span
  // the extremes -- handles a gap, an overlap, or either line being drawn
  // "backwards" relative to the other, the same way AutoCAD's JOIN does.
  const p0 = l1.startPoint;
  const t2 = [l2.startPoint, l2.endPoint].map((p) => (p.x - p0.x) * ux + (p.y - p0.y) * uy);
  const t2Min = Math.min(t2[0]!, t2[1]!);
  const t2Max = Math.max(t2[0]!, t2[1]!);
  const tMin = Math.min(0, t2Min);
  const tMax = Math.max(len1, t2Max);

  // A real (non-touching, non-overlapping) gap only gets bridged when both
  // facing ends are actually free -- unclaimed by any other entity in this
  // bulk-join pass. Interactive click-click JOIN (degreeMap is null) skips
  // this check -- the user explicitly chose these exact two lines to bridge.
  const gap = t2Min > len1 + GEOMETRIC_TOLERANCE || t2Max < -GEOMETRIC_TOLERANCE;
  if (gap && degreeMap !== null) {
    const facing1 = t2Min > len1 ? l1.endPoint : l1.startPoint;
    let facing2 = t2[0]! < t2[1]! ? l2.startPoint : l2.endPoint;
    if (t2Max < -GEOMETRIC_TOLERANCE) {
      facing2 = t2[0]! < t2[1]! ? l2.endPoint : l2.startPoint;
    }
    if ((degreeMap.get(pointKey(facing1)) ?? 0) > 1 || (degreeMap.get(pointKey(facing2)) ?? 0) > 1) {
      return { merged: null, reason: "Colinear but the gap is spanned by other connected geometry - not bridging it" };
    }
  }

  const newStart = { x: p0.x + ux * tMin, y: p0.y + uy * tMin };
  const newEnd = { x: p0.x + ux * tMax, y: p0.y + uy * tMax };
  return {
    merged: new Line(newStart, newEnd, { lineType: l1.lineType, dxfLayer: l1.dxfLayer, dxfColor: l1.dxfColor }),
    reason: null,
  };
}

/** Both arcs share [0, sweep1] (arc1, relative to its own start) and
 *  [off2, off2+sweep2] (arc2, `off2` already relative to arc1's start) on
 *  the same circle. Returns the union's (start, end), relative to arc1's
 *  own start, if the two spans overlap or touch within ANGLE_TOLERANCE_RAD
 *  -- trying `off2` and its wrapped-around alternative `off2 - 2*pi` --
 *  or null if there's a genuine gap between them. */
function mergeAngularSpan(sweep1: number, off2: number, sweep2: number): [number, number] | null {
  const twoPi = 2.0 * Math.PI;
  for (const candidate of [off2, off2 - twoPi]) {
    if (candidate <= sweep1 + ANGLE_TOLERANCE_RAD && candidate + sweep2 >= -ANGLE_TOLERANCE_RAD) {
      return [Math.min(0, candidate), Math.max(sweep1, candidate + sweep2)];
    }
  }
  return null;
}

function tryJoinArcs(a1: Arc, a2: Arc): JoinResult {
  if (dist(a1.center, a2.center) > GEOMETRIC_TOLERANCE || Math.abs(a1.radius - a2.radius) > GEOMETRIC_TOLERANCE) {
    return { merged: null, reason: "Arcs don't share the same center and radius" };
  }

  const twoPi = 2.0 * Math.PI;
  const sweep1 = normalizeAngle(a1.endAngle - a1.startAngle) || twoPi;
  const sweep2 = normalizeAngle(a2.endAngle - a2.startAngle) || twoPi;
  const off2 = normalizeAngle(a2.startAngle - a1.startAngle);

  const merged = mergeAngularSpan(sweep1, off2, sweep2);
  if (merged === null) return { merged: null, reason: "Arcs are not adjacent - cannot join" };
  const [spanStartRel, spanEndRel] = merged;
  const totalSweep = spanEndRel - spanStartRel;

  if (totalSweep >= twoPi - ANGLE_TOLERANCE_RAD) {
    // The merged span closes the full circle -- an Arc can't represent
    // that, so a Circle is the correct, unambiguous result here.
    return {
      merged: new Circle(a1.center, a1.radius, { lineType: a1.lineType, dxfLayer: a1.dxfLayer, dxfColor: a1.dxfColor }),
      reason: null,
    };
  }

  const newStart = a1.startAngle + spanStartRel;
  const newEnd = a1.startAngle + spanEndRel;
  return {
    merged: new Arc(a1.center, a1.radius, newStart, newEnd, {
      lineType: a1.lineType,
      dxfLayer: a1.dxfLayer,
      dxfColor: a1.dxfColor,
    }),
    reason: null,
  };
}

function tryConnect(e1: Joinable, e2: Joinable, degreeMap: Map<string, number> | null): JoinResult {
  const ends1 = endpointsOf(e1);
  const ends2 = endpointsOf(e2);
  if (ends1 === null || ends2 === null) {
    return { merged: null, reason: "Can only join two lines or two arcs, or connect open shapes at a shared endpoint" };
  }

  const seg1 = asOpenSegments(e1);
  const seg2 = asOpenSegments(e2);
  const [a0, a1] = ends1;
  const [b0, b1] = ends2;

  const close = (p: Point, q: Point) => dist(p, q) <= GEOMETRIC_TOLERANCE;
  const ambiguous = (p: Point) => degreeMap !== null && (degreeMap.get(pointKey(p)) ?? 0) > 2;
  const ambiguousReason = "Ambiguous junction (3+ entities meet here) - not joining";

  let mergedVertices: Vertex[];
  if (close(a1, b0)) {
    if (ambiguous(a1)) return { merged: null, reason: ambiguousReason };
    mergedVertices = [...seg1.slice(0, -1), ...seg2];
  } else if (close(a1, b1)) {
    if (ambiguous(a1)) return { merged: null, reason: ambiguousReason };
    mergedVertices = [...seg1.slice(0, -1), ...reverseSegments(seg2)];
  } else if (close(a0, b1)) {
    if (ambiguous(a0)) return { merged: null, reason: ambiguousReason };
    mergedVertices = [...seg2.slice(0, -1), ...seg1];
  } else if (close(a0, b0)) {
    if (ambiguous(a0)) return { merged: null, reason: ambiguousReason };
    mergedVertices = [...reverseSegments(seg1).slice(0, -1), ...seg2];
  } else {
    return { merged: null, reason: "Not connected (no shared endpoint) and not colinear/same-circle" };
  }

  const closed = close(mergedVertices[0]!.point, mergedVertices[mergedVertices.length - 1]!.point);
  if (closed) mergedVertices = mergedVertices.slice(0, -1);

  // line_type/layer/color follow whichever of the two originals is already
  // a Polyline (extending it keeps its own style), or e1 by default.
  const styleSource = e1 instanceof Polyline ? e1 : e2 instanceof Polyline ? e2 : e1;
  return {
    merged: new Polyline(mergedVertices, closed, {
      lineType: styleSource.lineType,
      dxfLayer: styleSource.dxfLayer,
      dxfColor: styleSource.dxfColor,
    }),
    reason: null,
  };
}

/** Tries a clean primitive merge first (plain Line/Arc/Circle, preferred
 *  whenever it applies), falling back to connecting the two into a
 *  Polyline via a shared endpoint. `degreeMap`, when given (bulk-join
 *  only), blocks the connect fallback through a point where a third entity
 *  also meets; a colinear primitive merge is never blocked by it. */
function tryJoin(e1: Joinable, e2: Joinable, degreeMap: Map<string, number> | null = null): JoinResult {
  if (e1 instanceof Line && e2 instanceof Line) {
    const result = tryJoinLines(e1, e2, degreeMap);
    if (result.merged !== null) return result;
  } else if (e1 instanceof Arc && e2 instanceof Arc) {
    const result = tryJoinArcs(e1, e2);
    if (result.merged !== null) return result;
  }
  return tryConnect(e1, e2, degreeMap);
}

/** Repeatedly merges any joinable/connectable pair within `entities` until
 *  none is left: what they come to, and how many merges it took. The
 *  entities themselves are not changed. */
export function joinAll(entities: Entity[]): { result: Entity[]; joinCount: number } {
  // Entity, not Joinable: a merge can produce a Circle (two Arcs closing
  // the full circle), which then just sits inert in `working` -- like
  // every other non-Joinable type, isJoinable() below skips ever pairing
  // it again, the same graceful no-op commands/join.py's own duck-typed
  // _endpoints_of()/_as_open_segments() (both return None for a Circle)
  // fall through to.
  const working: Entity[] = [...entities];
  let joinCount = 0;
  let changed = true;

  while (changed) {
    changed = false;
    const degreeMap = endpointDegreeMap(working);
    const n = working.length;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const left = working[i]!;
        const right = working[j]!;
        if (!isJoinable(left) || !isJoinable(right)) continue;
        const { merged } = tryJoin(left, right, degreeMap);
        if (merged !== null) {
          // Remove the higher index first so the lower index stays valid.
          working.splice(j, 1);
          working.splice(i, 1);
          working.push(merged);
          joinCount++;
          changed = true;
          break outer;
        }
      }
    }
  }
  return { result: working, joinCount };
}

export class JoinCommand extends BaseCommand {
  private state: 0 | 1 = 0;
  private entity1: Joinable | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.entity1 = null;

    const preSelected = this.engine.selection.getEntities().filter(isJoinable);
    if (preSelected.length >= 2) {
      this.runBulkJoin(preSelected);
      return;
    }

    this.commandBar.setStatus("JOIN", "Select first line/arc/polyline (or window-select several, then run JOIN)");
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  pick(): (entity: Entity) => boolean {
    return (e) => e !== this.entity1 && isJoinable(e);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      for (const entity of this.document.getEntities()) {
        if (isJoinable(entity) && entity.hitTest(worldPos, this.engine.pickTolerance())) {
          this.entity1 = entity;
          this.state = 1;
          this.commandBar.setStatus("JOIN", "Select second line/arc/polyline");
          break;
        }
      }
    } else {
      for (const entity of this.document.getEntities()) {
        if (entity === this.entity1) continue;
        if (isJoinable(entity) && entity.hitTest(worldPos, this.engine.pickTolerance())) {
          this.executeJoin(entity);
          break;
        }
      }
    }
    this.engine.requestRedraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state >= 1 && this.entity1 !== null) {
      this.entity1.drawSelected(ctx, this.engine.viewport);
    }
  }

  cancel(): void {
    this.state = 0;
    this.entity1 = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }

  private executeJoin(entity2: Joinable): void {
    const { merged, reason } = tryJoin(this.entity1!, entity2);
    if (merged === null) {
      this.commandBar.setStatus("JOIN", reason ?? "Cannot join");
      this.start();
      return;
    }

    this.undo.push(this.document.toDict());
    this.document.removeEntity(this.entity1!);
    this.document.removeEntity(entity2);
    this.document.addEntity(merged);
    this.start();
  }

  /** Repeatedly merges any joinable/connectable pair within `entities` (so
   *  a whole connected chain -- even a closed outline made of several
   *  different entity types -- collapses in one run) and commits every
   *  merge as a single undo step. Recomputes the endpoint degree map before
   *  each pass, since it must reflect `working`'s current entities -- a
   *  merge changes which points are still free endpoints. */
  private runBulkJoin(entities: Joinable[]): void {
    const { result: working, joinCount } = joinAll(entities);

    this.engine.selection.clear();
    this.state = 0;
    this.entity1 = null;
    this.commandBar.enableInput();

    if (joinCount === 0) {
      this.commandBar.setStatus("JOIN", `${entities.length} selected - none are colinear/connected enough to join`);
      this.engine.requestRedraw();
      return;
    }

    this.undo.push(this.document.toDict());
    for (const e of entities) this.document.removeEntity(e);
    for (const e of working) this.document.addEntity(e);

    const closedNote = working.some((e) => e instanceof Polyline && e.closed) ? " (closed loop)" : "";
    this.commandBar.setStatus(
      "JOIN",
      `Joined ${joinCount} pair(s) - ${entities.length} entities -> ${working.length}${closedNote}`,
    );
    this.engine.requestRedraw();
  }
}
