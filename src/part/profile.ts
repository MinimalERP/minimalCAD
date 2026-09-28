/**
 * MinimalCAD Web
 * part/profile.ts
 *
 * Sketch entities -> closed loops -> extrudable regions (outer loop + holes).
 *
 * Everything here is in plane-local coordinates (Y-up, see plane.ts's
 * toLocal), so a loop's signed area sign is its true CCW/CW orientation.
 *
 * Loops keep their ANALYTIC segments (exact lines/arcs/circles) alongside a
 * tessellated polygon: the polygon feeds triangulation and point-in-region
 * tests, the analytic segments feed exact 3D edges (and, later, drawings).
 *
 * Scope (Milestone 1): loops are found as connected components whose every
 * endpoint joins exactly two segments. Branching or open chains are ignored
 * (reported via `openChains`), and loops are assumed not to cross each other.
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { Circle } from "../entities/circle";
import { Ellipse } from "../entities/ellipse";
import { Polyline } from "../entities/polyline";
import earcut from "earcut";
import { fromLocal, toLocal } from "./plane";

export type Segment =
  | { kind: "line"; a: Point; b: Point }
  /** Starts at angle a0 and sweeps by `sweep` radians (signed: + is CCW). */
  | { kind: "arc"; c: Point; r: number; a0: number; sweep: number }
  /** Sampled free curve (partial/full ellipse), endpoints inclusive. */
  | { kind: "curve"; pts: Point[] };

export interface Loop {
  segments: Segment[];
  /** Tessellated outline: every segment's samples, start inclusive, end
   *  exclusive, so the closing point is NOT repeated. */
  polygon: Point[];
  /** polygon index where each segment starts. */
  segmentStart: number[];
  /** Signed area (+ = CCW). */
  area: number;
}

export interface Region {
  outer: Loop; // CCW
  holes: Loop[]; // CW
  area: number;
}

export interface ProfileResult {
  regions: Region[];
  /** Connected pieces of geometry that don't form a clean closed loop. */
  openChains: number;
}

/** Max angle per tessellated arc step (5 degrees). */
const ARC_STEP = Math.PI / 36;

function arcPoint(c: Point, r: number, a: number): Point {
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

export function segStart(s: Segment): Point {
  if (s.kind === "line") return s.a;
  if (s.kind === "arc") return arcPoint(s.c, s.r, s.a0);
  return s.pts[0]!;
}

export function segEnd(s: Segment): Point {
  if (s.kind === "line") return s.b;
  if (s.kind === "arc") return arcPoint(s.c, s.r, s.a0 + s.sweep);
  return s.pts[s.pts.length - 1]!;
}

function reverseSeg(s: Segment): Segment {
  if (s.kind === "line") return { kind: "line", a: s.b, b: s.a };
  if (s.kind === "arc") return { ...s, a0: s.a0 + s.sweep, sweep: -s.sweep };
  return { kind: "curve", pts: s.pts.slice().reverse() };
}

/** Samples of a segment, start inclusive, end exclusive. */
export function sampleSeg(s: Segment): Point[] {
  if (s.kind === "line") return [s.a];
  if (s.kind === "curve") return s.pts.slice(0, -1);
  const n = Math.max(2, Math.ceil(Math.abs(s.sweep) / ARC_STEP));
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) pts.push(arcPoint(s.c, s.r, s.a0 + (s.sweep * i) / n));
  return pts;
}

const TWO_PI = Math.PI * 2;

function ccwSweep(start: number, end: number): number {
  const sweep = (((end - start) % TWO_PI) + TWO_PI) % TWO_PI;
  return sweep === 0 ? TWO_PI : sweep;
}

/** Arc/Line/Ellipse in sketch (Y-down) coords -> plane-local segment. The
 *  Y flip mirrors angles (a -> -a) and reverses sweep direction. */
function arcToSeg(arc: Arc): Segment {
  const c = toLocal(arc.center);
  return { kind: "arc", c, r: arc.radius, a0: -arc.startAngle, sweep: -ccwSweep(arc.startAngle, arc.endAngle) };
}

function sampleEllipse(e: Ellipse, full: boolean): Point[] {
  const sweep = full ? TWO_PI : ccwSweep(e.startAngle, e.endAngle);
  const n = Math.max(8, Math.ceil(sweep / ARC_STEP));
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) pts.push(toLocal(e.pointAt(e.startAngle + (sweep * i) / n)));
  return pts;
}

/** Splits entities into already-closed loops (circles, full ellipses) and
 *  open segments still to be chained. Non-geometry (text, dims) is skipped. */
function collect(entities: readonly Entity[]): { closed: Segment[][]; open: Segment[] } {
  const closed: Segment[][] = [];
  const open: Segment[] = [];
  for (const e of entities) {
    if (e instanceof Line) {
      open.push({ kind: "line", a: toLocal(e.startPoint), b: toLocal(e.endPoint) });
    } else if (e instanceof Arc) {
      open.push(arcToSeg(e));
    } else if (e instanceof Circle) {
      closed.push([{ kind: "arc", c: toLocal(e.center), r: e.radius, a0: 0, sweep: TWO_PI }]);
    } else if (e instanceof Ellipse) {
      if (e.isFull()) {
        const pts = sampleEllipse(e, true);
        closed.push([{ kind: "curve", pts }]);
      } else {
        open.push({ kind: "curve", pts: sampleEllipse(e, false) });
      }
    } else if (e instanceof Polyline) {
      for (const seg of e.segmentEntities()) {
        if (seg instanceof Line) open.push({ kind: "line", a: toLocal(seg.startPoint), b: toLocal(seg.endPoint) });
        else if (seg instanceof Arc) open.push(arcToSeg(seg));
      }
    }
  }
  return { closed, open };
}

/** Chains open segments into closed loops (components where every node has
 *  degree exactly 2); returns the loops plus the count of other components. */
function chain(open: Segment[], tol: number): { loops: Segment[][]; openChains: number } {
  const nodes: Point[] = [];
  const nodeOf = (p: Point): number => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (Math.abs(n.x - p.x) <= tol && Math.abs(n.y - p.y) <= tol) return i;
    }
    nodes.push(p);
    return nodes.length - 1;
  };
  const ends = open.map((s) => [nodeOf(segStart(s)), nodeOf(segEnd(s))] as const);
  const incident: number[][] = nodes.map(() => []);
  ends.forEach(([a, b], i) => {
    incident[a]!.push(i);
    incident[b]!.push(i);
  });

  const visited = new Array<boolean>(open.length).fill(false);
  const loops: Segment[][] = [];
  let openChains = 0;

  for (let start = 0; start < open.length; start++) {
    if (visited[start]) continue;
    // Gather the whole connected component first.
    const component: number[] = [];
    const stack = [start];
    visited[start] = true;
    while (stack.length > 0) {
      const i = stack.pop()!;
      component.push(i);
      for (const node of ends[i]!) {
        for (const j of incident[node]!) {
          if (!visited[j]) {
            visited[j] = true;
            stack.push(j);
          }
        }
      }
    }
    const nodesInComponent = new Set(component.flatMap((i) => [...ends[i]!]));
    const isCycle = [...nodesInComponent].every((n) => incident[n]!.length === 2);
    if (!isCycle) {
      openChains++;
      continue;
    }
    // Walk the cycle, orienting each segment to continue from the last end.
    const loop: Segment[] = [];
    const used = new Set<number>();
    let segIdx = start;
    let atNode = ends[start]![0];
    while (!used.has(segIdx)) {
      used.add(segIdx);
      const [a, b] = ends[segIdx]!;
      const forward = a === atNode;
      loop.push(forward ? open[segIdx]! : reverseSeg(open[segIdx]!));
      atNode = forward ? b : a;
      const next = incident[atNode]!.find((j) => j !== segIdx) ?? segIdx;
      if (next === segIdx && incident[atNode]!.length === 2) break; // two segs between the same 2 nodes
      segIdx = next;
    }
    loops.push(loop);
  }
  return { loops, openChains };
}

function signedArea(poly: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function buildLoop(segments: Segment[]): Loop {
  const polygon: Point[] = [];
  const segmentStart: number[] = [];
  for (const s of segments) {
    segmentStart.push(polygon.length);
    polygon.push(...sampleSeg(s));
  }
  return { segments, polygon, segmentStart, area: signedArea(polygon) };
}

function reverseLoop(loop: Loop): Loop {
  return buildLoop(loop.segments.slice().reverse().map(reverseSeg));
}

function orient(loop: Loop, ccw: boolean): Loop {
  return loop.area > 0 === ccw ? loop : reverseLoop(loop);
}

export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True if `p` (plane-local) lies in the region's material. */
export function regionContains(region: Region, p: Point): boolean {
  return pointInPolygon(p, region.outer.polygon) && !region.holes.some((h) => pointInPolygon(p, h.polygon));
}

/** Endpoint-matching tolerance scales with the sketch's size. */
function toleranceFor(segments: Segment[]): number {
  let extent = 1;
  for (const s of segments) {
    for (const p of [segStart(s), segEnd(s)]) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
  }
  return extent * 1e-7;
}

export function findProfiles(entities: readonly Entity[]): ProfileResult {
  const { closed, open } = collect(entities);
  const { loops: chained, openChains } = chain(open, toleranceFor(open));
  const loops = [...closed, ...chained].map(buildLoop).filter((l) => Math.abs(l.area) > 1e-12);

  // Nesting depth = how many other loops contain this one (tested at a
  // vertex -- valid since loops are assumed not to cross). Even depth is
  // material (an outer boundary), odd depth is a hole in its parent.
  const byArea = loops.slice().sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const depth = byArea.map((loop, i) =>
    byArea.slice(0, i).filter((other) => pointInPolygon(loop.polygon[0]!, other.polygon)).length,
  );

  const regions: Region[] = [];
  byArea.forEach((loop, i) => {
    if (depth[i]! % 2 !== 0) return;
    const outer = orient(loop, true);
    const holes: Loop[] = [];
    byArea.forEach((inner, j) => {
      if (j <= i || depth[j] !== depth[i]! + 1) return;
      if (pointInPolygon(inner.polygon[0]!, loop.polygon)) holes.push(orient(inner, false));
    });
    const area = Math.abs(outer.area) - holes.reduce((sum, h) => sum + Math.abs(h.area), 0);
    regions.push({ outer, holes, area });
  });
  return { regions, openChains };
}

/** Every sketch curve as plane-local polylines -- for showing a sketch's
 *  wireframe in 3D (open construction lines included). */
export function entityPolylines(entities: readonly Entity[]): Point[][] {
  const { closed, open } = collect(entities);
  return [...closed.flat(), ...open].map((seg) => [...sampleSeg(seg), segEnd(seg)]);
}

/** A point guaranteed inside the region's material (centroid of one of its
 *  cap triangles), in sketch (Y-down) coordinates -- stored by Extrude as
 *  the region's stable "seed" (see ExtrudeFeature.profiles). */
export function regionSeed(region: Region): Point & { area: number } {
  const loops = [region.outer, ...region.holes];
  const flat: number[] = [];
  const holeIdx: number[] = [];
  const pts: Point[] = [];
  loops.forEach((loop, i) => {
    if (i > 0) holeIdx.push(pts.length);
    for (const p of loop.polygon) {
      flat.push(p.x, p.y);
      pts.push(p);
    }
  });
  const tris = earcut(flat, holeIdx, 2);
  // Largest triangle: its centroid is the least sensitive to later small edits.
  let best = 0;
  let bestArea = -1;
  for (let i = 0; i < tris.length; i += 3) {
    const a = pts[tris[i]!]!;
    const b = pts[tris[i + 1]!]!;
    const c = pts[tris[i + 2]!]!;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  }
  const [a, b, c] = [pts[tris[best]!]!, pts[tris[best + 1]!]!, pts[tris[best + 2]!]!];
  return { ...fromLocal({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 }), area: region.area };
}
