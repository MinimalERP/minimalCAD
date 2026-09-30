/**
 * MinimalCAD Web
 * drawing/hlr.ts
 *
 * Hidden-line removal for drawing views (our own; no library): solid bodies
 * + a view direction -> the 2D lines of an orthographic view, each marked
 * visible or hidden, plus centre lines / centre marks for round features.
 *
 * Curves come from the kernel's ANALYTIC edges (a hole rim stays a true
 * circle) plus the OUTLINES of curved faces -- where a cylinder / cone /
 * torus turns from facing the viewer to facing away. The outline is found
 * per triangle as the zero line of (exact surface normal . view dir), so it
 * follows the face's real extent: it stops where a hole cuts through it.
 *
 * Visibility can only change where, in 2D, one curve crosses (or touches)
 * another -- every occluding face is bounded by edges and outlines. So each
 * curve is split at those crossings and each piece is tested ONCE, at its
 * middle: is any triangle of the mesh in front of it there?
 */

import type { Point } from "../core/types";
import type { Body, Face } from "../part/kernel/types";
import type { Vec3 } from "../part/vec3";
import { add, cross, dot, length, normalize, scale, sub } from "../part/vec3";

/** Orthographic view: `dir` points from the part TOWARDS the viewer;
 *  `right` / `up` are the paper's x / y. All unit, mutually square. */
export interface ViewAxes {
  dir: Vec3;
  right: Vec3;
  up: Vec3;
}

/** A 2D curve on the view (model units, Y up). Arcs run CCW from a0 to a1
 *  (radians); a full circle has a1 - a0 = 2 pi. */
export type ViewCurve =
  | { kind: "line"; a: Point; b: Point }
  | { kind: "arc"; center: Point; r: number; a0: number; a1: number }
  | { kind: "polyline"; pts: Point[] };

export interface ViewLine {
  curve: ViewCurve;
  hidden: boolean;
}

export interface ViewResult {
  lines: ViewLine[];
  /** Axes of round features seen from the side (chain lines). */
  centerLines: { a: Point; b: Point }[];
  /** Round features seen end-on: a cross at `center`, arms just past `r`. */
  centerMarks: { center: Point; r: number }[];
}

/** One 3D curve to classify, as a polyline of samples. For an arc the
 *  samples sit at equal angle steps, so a parameter maps back exactly. */
interface Curve3 {
  pts: Vec3[];
  arc?: { center: Vec3; e1: Vec3; e2: Vec3; r: number; sweep: number; normal: Vec3 };
}

const TWO_PI = Math.PI * 2;

export function viewBodies(bodies: readonly Body[], view: ViewAxes): ViewResult {
  let size = 1;
  for (const b of bodies) for (const v of b.mesh.positions) size = Math.max(size, Math.abs(v));
  const tol2d = size * 1e-7;
  // Arc samples sit off the faceted mesh by up to the chord sag; a real
  // occluder is always much further in front than this.
  const depthTol = size * 1e-3;

  const P = (p: Vec3): Point => ({ x: dot(p, view.right), y: dot(p, view.up) });
  const Z = (p: Vec3): number => dot(p, view.dir);

  // --- curves ---
  const curves: Curve3[] = [];
  for (const body of bodies) {
    for (const e of body.edges) {
      const g = e.geom;
      if (g.kind === "line") curves.push({ pts: [g.a, g.b] });
      else if (g.kind === "polyline") {
        if (g.pts.length >= 2) curves.push({ pts: g.pts });
      } else {
        const normal = normalize(g.normal);
        const e1 = normalize(sub(g.start, g.center));
        const e2 = cross(normal, e1);
        const steps = Math.max(8, Math.ceil((Math.abs(g.sweep) / TWO_PI) * 144));
        const pts: Vec3[] = [];
        for (let i = 0; i <= steps; i++) pts.push(arcAt(g.center, e1, e2, g.radius, (g.sweep * i) / steps));
        curves.push({ pts, arc: { center: g.center, e1, e2, r: g.radius, sweep: g.sweep, normal } });
      }
    }
    for (const pts of outlines(body, view.dir, size)) curves.push({ pts });
  }

  // --- 2D segments + a grid over them ---
  interface Seg {
    c: number;
    k: number;
    a: Point;
    b: Point;
  }
  const segs: Seg[] = [];
  const segsOf: number[][] = curves.map(() => []);
  curves.forEach((cv, c) => {
    for (let k = 0; k + 1 < cv.pts.length; k++) {
      segsOf[c]!.push(segs.length);
      segs.push({ c, k, a: P(cv.pts[k]!), b: P(cv.pts[k + 1]!) });
    }
  });
  const segGrid = new Grid2(segs.map((s) => box(s.a, s.b)), tol2d);

  // --- split every segment where another curve crosses or touches it ---
  const cuts: number[][] = segs.map(() => [0, 1]);
  segs.forEach((s, i) => {
    for (const j of segGrid.query(box(s.a, s.b), tol2d)) {
      const o = segs[j]!;
      if (o.c === s.c) continue;
      for (const t of crossings(s.a, s.b, o.a, o.b, tol2d)) cuts[i]!.push(t);
    }
  });

  // --- occlusion: triangles in 2D, binned ---
  const tris: { a: Point; b: Point; c: Point; za: number; zb: number; zc: number }[] = [];
  for (const body of bodies) {
    const { positions: pos, indices } = body.mesh;
    const at = (i: number): Vec3 => ({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! });
    for (let t = 0; t < indices.length; t += 3) {
      const A = at(indices[t]!);
      const B = at(indices[t + 1]!);
      const C = at(indices[t + 2]!);
      const n = cross(sub(B, A), sub(C, A));
      const ln = length(n);
      // Seen edge-on, a triangle covers no area in the view.
      if (ln === 0 || Math.abs(dot(n, view.dir)) < ln * 1e-9) continue;
      tris.push({ a: P(A), b: P(B), c: P(C), za: Z(A), zb: Z(B), zc: Z(C) });
    }
  }
  const triGrid = new Grid2(
    tris.map((t) => box3(t.a, t.b, t.c)),
    tol2d,
  );
  const hiddenAt = (p: Vec3): boolean => {
    const q = P(p);
    const z = Z(p);
    for (const i of triGrid.query({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y }, 0)) {
      const t = tris[i]!;
      const w = barycentric(t.a, t.b, t.c, q);
      if (w === null) continue;
      const zt = w[0] * t.za + w[1] * t.zb + w[2] * t.zc;
      if (zt > z + depthTol) return true;
    }
    return false;
  };

  // --- classify pieces, then merge runs of equal visibility per curve ---
  interface Run {
    c: number;
    t0: number; // curve parameter: segment index + fraction
    t1: number;
    hidden: boolean;
  }
  const runs: Run[] = [];
  curves.forEach((cv, c) => {
    let open: Run | null = null;
    for (const i of segsOf[c]!) {
      const s = segs[i]!;
      const ts = [...new Set(cuts[i]!)].sort((x, y) => x - y);
      for (let m = 0; m + 1 < ts.length; m++) {
        const u0 = ts[m]!;
        const u1 = ts[m + 1]!;
        if (u1 - u0 < 1e-12) continue;
        const hidden = hiddenAt(pointAt(cv, s.k + (u0 + u1) / 2));
        if (open !== null && open.hidden === hidden && Math.abs(open.t1 - (s.k + u0)) < 1e-12) open.t1 = s.k + u1;
        else {
          if (open !== null) runs.push(open);
          open = { c, t0: s.k + u0, t1: s.k + u1, hidden };
        }
      }
    }
    if (open !== null) runs.push(open);
  });

  // --- hidden pieces lying under a visible line (or another hidden one)
  //     are dropped: a back edge behind a front edge is just the front edge.
  const out: ViewLine[] = [];
  const drawn: [Point, Point][] = [];
  const drawnGrid = new DynamicGrid2(size / 64);
  const covered = (a: Point, b: Point): boolean => {
    // Every sample of the piece must lie on something already drawn.
    const n = 4;
    for (let k = 0; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      let on = false;
      for (const i of drawnGrid.near(p)) {
        const [u, v] = drawn[i]!;
        if (distToSeg(p, u, v) <= tol2d * 10) {
          on = true;
          break;
        }
      }
      if (!on) return false;
    }
    return true;
  };
  const addDrawn = (pts: Point[]): void => {
    for (let k = 0; k + 1 < pts.length; k++) {
      drawnGrid.add(drawn.length, pts[k]!, pts[k + 1]!);
      drawn.push([pts[k]!, pts[k + 1]!]);
    }
  };
  for (const pass of [false, true]) {
    for (const r of runs) {
      if (r.hidden !== pass) continue;
      const pts2 = runPoints(curves[r.c]!, r.t0, r.t1).map(P);
      if (pass) {
        // Keep only the parts of a hidden run not already drawn over.
        let start = -1;
        const keep: Point[][] = [];
        for (let k = 0; k + 1 < pts2.length; k++) {
          const free = !covered(pts2[k]!, pts2[k + 1]!);
          if (free && start < 0) start = k;
          if (!free && start >= 0) {
            keep.push(pts2.slice(start, k + 1));
            start = -1;
          }
        }
        if (start >= 0) keep.push(pts2.slice(start));
        for (const piece of keep) {
          addDrawn(piece);
          out.push({ curve: curveFrom(curves[r.c]!, piece, r, view), hidden: true });
        }
        continue;
      }
      addDrawn(pts2);
      out.push({ curve: curveFrom(curves[r.c]!, pts2, r, view), hidden: false });
    }
  }

  return { lines: out, ...centres(bodies, view, P) };
}

// ---------------------------------------------------------------------------
// Curves

function arcAt(center: Vec3, e1: Vec3, e2: Vec3, r: number, a: number): Vec3 {
  return add(center, add(scale(e1, r * Math.cos(a)), scale(e2, r * Math.sin(a))));
}

/** Exact point at curve parameter t (segment index + fraction). */
function pointAt(cv: Curve3, t: number): Vec3 {
  const n = cv.pts.length - 1;
  if (cv.arc !== undefined) {
    const a = cv.arc;
    return arcAt(a.center, a.e1, a.e2, a.r, (a.sweep * t) / n);
  }
  const k = Math.min(n - 1, Math.max(0, Math.floor(t)));
  const f = t - k;
  const p = cv.pts[k]!;
  const q = cv.pts[k + 1]!;
  return add(p, scale(sub(q, p), f));
}

/** The 3D points of a run [t0, t1]: its ends plus every sample between. */
function runPoints(cv: Curve3, t0: number, t1: number): Vec3[] {
  const out = [pointAt(cv, t0)];
  for (let k = Math.floor(t0) + 1; k < t1 - 1e-12; k++) out.push(cv.pts[k]!);
  out.push(pointAt(cv, t1));
  return out;
}

/** A run as a 2D curve: straight -> line; an arc facing the viewer -> a
 *  true arc / circle; anything else -> polyline. */
function curveFrom(cv: Curve3, pts: Point[], run: { t0: number; t1: number }, view: ViewAxes): ViewCurve {
  const a = cv.arc;
  if (a !== undefined && Math.abs(Math.abs(dot(a.normal, view.dir)) - 1) < 1e-9) {
    const c = { x: dot(a.center, view.right), y: dot(a.center, view.up) };
    const n = cv.pts.length - 1;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const sweep = ((a.sweep * (run.t1 - run.t0)) / n) * Math.sign(dot(a.normal, view.dir));
    // Only a whole untouched run keeps its exact sweep (a trimmed piece's
    // ends were recomputed exactly anyway).
    const s0 = Math.atan2(first.y - c.y, first.x - c.x);
    if (Math.abs(Math.abs(sweep) - TWO_PI) < 1e-9) return { kind: "arc", center: c, r: a.r, a0: s0, a1: s0 + TWO_PI };
    if (sweep > 0) return { kind: "arc", center: c, r: a.r, a0: s0, a1: s0 + sweep };
    const e0 = Math.atan2(last.y - c.y, last.x - c.x);
    return { kind: "arc", center: c, r: a.r, a0: e0, a1: e0 - sweep };
  }
  // All on one line (a straight edge, or a circle seen edge-on running out
  // and back): the line between its two extreme points.
  const first = pts[0]!;
  let far = first;
  for (const p of pts) if (Math.hypot(p.x - first.x, p.y - first.y) > Math.hypot(far.x - first.x, far.y - first.y)) far = p;
  let other = far;
  for (const p of pts) if (Math.hypot(p.x - far.x, p.y - far.y) > Math.hypot(other.x - far.x, other.y - far.y)) other = p;
  const span = Math.hypot(other.x - far.x, other.y - far.y);
  if (span > 0 && pts.every((p) => distToLine(p, far, other) <= 1e-9 * (1 + span))) {
    // Keep the run's direction where it has one.
    const d1 = Math.hypot(far.x - first.x, far.y - first.y);
    const d2 = Math.hypot(other.x - first.x, other.y - first.y);
    return d1 <= d2 ? { kind: "line", a: far, b: other } : { kind: "line", a: other, b: far };
  }
  return { kind: "polyline", pts };
}

/** Outlines of a body's curved faces as seen along `dir`: per triangle, the
 *  zero line of (exact outward normal . dir), chained into polylines. */
function outlines(body: Body, dir: Vec3, size: number): Vec3[][] {
  const { positions: pos, indices, faceIds } = body.mesh;
  const at = (i: number): Vec3 => ({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! });
  const q = size * 1e-7;
  const key = (p: Vec3): string => `${Math.round(p.x / q)},${Math.round(p.y / q)},${Math.round(p.z / q)}`;
  // Per face: a bore's wall and its drill point are separate outlines.
  const byFace = new Map<number, [Vec3, Vec3][]>();
  for (let t = 0; t < indices.length; t += 3) {
    const face = body.faces[faceIds[t / 3]!];
    if (face === undefined || face.geom.kind === "plane" || face.geom.kind === "freeform") continue;
    const v = [at(indices[t]!), at(indices[t + 1]!), at(indices[t + 2]!)] as const;
    const facet = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    if (length(facet) === 0) continue;
    const g = v.map((p) => {
      const n = normalAt(face, p);
      if (n === null) return 0;
      return dot(n, facet) >= 0 ? dot(n, dir) : -dot(n, dir);
    });
    // "Facing" counts zero as facing: an outline exactly through vertices
    // then comes out once, along the mesh edge.
    const s = g.map((x) => x >= 0);
    if (s[0] === s[1] && s[1] === s[2]) continue;
    const ends: Vec3[] = [];
    for (let k = 0; k < 3; k++) {
      const i = k;
      const j = (k + 1) % 3;
      if (s[i] === s[j]) continue;
      const f = g[i]! / (g[i]! - g[j]!);
      ends.push(add(v[i]!, scale(sub(v[j]!, v[i]!), f)));
    }
    if (ends.length !== 2 || key(ends[0]!) === key(ends[1]!)) continue;
    const list = byFace.get(face.id);
    if (list === undefined) byFace.set(face.id, [[ends[0]!, ends[1]!]]);
    else list.push([ends[0]!, ends[1]!]);
  }
  return [...byFace.values()].flatMap((segs) => chain(segs, key));
}

/** Exact unit normal of a curved face at a point (either sign). */
function normalAt(face: Face, p: Vec3): Vec3 | null {
  const g = face.geom;
  if (g.kind === "cylinder") {
    const a = normalize(g.axis);
    const d = sub(p, g.axisOrigin);
    const r = sub(d, scale(a, dot(d, a)));
    return length(r) === 0 ? null : normalize(r);
  }
  if (g.kind === "cone") {
    const a = normalize(g.axis);
    const d = sub(p, g.apex);
    const along = dot(d, a);
    const r = sub(d, scale(a, along));
    if (length(r) === 0) return null;
    // Normal leans back towards the apex by the half angle.
    return normalize(sub(scale(normalize(r), Math.cos(g.halfAngle)), scale(a, Math.sin(g.halfAngle) * Math.sign(along || 1))));
  }
  if (g.kind === "torus") {
    const a = normalize(g.axis);
    const d = sub(p, g.center);
    const r = sub(d, scale(a, dot(d, a)));
    if (length(r) === 0) return null;
    const tube = add(g.center, scale(normalize(r), g.major));
    const n = sub(p, tube);
    return length(n) === 0 ? null : normalize(n);
  }
  return null;
}

/** Joins segments sharing end points into polylines. */
function chain(segs: [Vec3, Vec3][], key: (p: Vec3) => string): Vec3[][] {
  const at = new Map<string, number[]>();
  segs.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      const l = at.get(k);
      if (l === undefined) at.set(k, [i]);
      else l.push(i);
    }
  });
  const used = new Set<number>();
  const out: Vec3[][] = [];
  const extend = (line: Vec3[], from: Vec3): void => {
    let tip = from;
    for (;;) {
      const next = (at.get(key(tip)) ?? []).find((i) => !used.has(i));
      if (next === undefined) return;
      used.add(next);
      const [a, b] = segs[next]!;
      tip = key(a) === key(tip) ? b : a;
      line.push(tip);
    }
  };
  segs.forEach(([a, b], i) => {
    if (used.has(i)) return;
    used.add(i);
    const fwd = [a, b];
    extend(fwd, b);
    const back = [a];
    extend(back, a);
    out.push([...back.reverse().slice(0, -1), ...fwd]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Centre lines / marks

function centres(bodies: readonly Body[], view: ViewAxes, P: (p: Vec3) => Point): Omit<ViewResult, "lines"> {
  const centerLines: ViewResult["centerLines"] = [];
  const centerMarks: ViewResult["centerMarks"] = [];
  const seenLine = new Set<string>();
  const seenMark = new Set<string>();
  const r4 = (v: number): number => Math.round(v * 1e3);
  for (const body of bodies) {
    const { positions: pos, indices, faceIds } = body.mesh;
    for (const face of body.faces) {
      const g = face.geom;
      if (g.kind !== "cylinder" && g.kind !== "cone") continue;
      const axis = normalize(g.axis);
      const origin = g.kind === "cylinder" ? g.axisOrigin : g.apex;
      // Extent along the axis and angular coverage, from the mesh.
      let lo = Infinity;
      let hi = -Infinity;
      let rMax = 0;
      const e1 = normalize(Math.abs(axis.x) < 0.9 ? cross(axis, { x: 1, y: 0, z: 0 }) : cross(axis, { x: 0, y: 1, z: 0 }));
      const e2 = cross(axis, e1);
      const bins = new Set<number>();
      for (let t = 0; t < faceIds.length; t++) {
        if (faceIds[t] !== face.id) continue;
        for (let k = 0; k < 3; k++) {
          const i = indices[t * 3 + k]!;
          const p = { x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! };
          const d = sub(p, origin);
          const along = dot(d, axis);
          lo = Math.min(lo, along);
          hi = Math.max(hi, along);
          const rad = sub(d, scale(axis, along));
          rMax = Math.max(rMax, length(rad));
          bins.add(Math.floor(((Math.atan2(dot(rad, e2), dot(rad, e1)) + Math.PI) / TWO_PI) * 36) % 36);
        }
      }
      // Fillets are part-cylinders: only (nearly) whole round features count.
      if (!Number.isFinite(lo) || bins.size < 24) continue;
      const endOn = Math.abs(dot(axis, view.dir)) > 1 - 1e-9;
      if (endOn) {
        const c = P(origin);
        const k = `${r4(c.x)},${r4(c.y)}`;
        if (seenMark.has(k)) {
          // Keep the biggest circle's size for a shared centre.
          const m = centerMarks.find((x) => `${r4(x.center.x)},${r4(x.center.y)}` === k)!;
          m.r = Math.max(m.r, rMax);
          continue;
        }
        seenMark.add(k);
        centerMarks.push({ center: c, r: rMax });
        continue;
      }
      if (Math.abs(dot(axis, view.dir)) > 1e-9) continue; // slanted: no centre line in v1
      const a = P(add(origin, scale(axis, lo)));
      const b = P(add(origin, scale(axis, hi)));
      const k = [a, b]
        .map((p) => `${r4(p.x)},${r4(p.y)}`)
        .sort()
        .join("|");
      if (seenLine.has(k)) continue;
      seenLine.add(k);
      centerLines.push({ a, b });
    }
  }
  return { centerLines, centerMarks };
}

// ---------------------------------------------------------------------------
// 2D helpers

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const box = (a: Point, b: Point): Box => ({
  minX: Math.min(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxX: Math.max(a.x, b.x),
  maxY: Math.max(a.y, b.y),
});
const box3 = (a: Point, b: Point, c: Point): Box => ({
  minX: Math.min(a.x, b.x, c.x),
  minY: Math.min(a.y, b.y, c.y),
  maxX: Math.max(a.x, b.x, c.x),
  maxY: Math.max(a.y, b.y, c.y),
});

/** Static uniform grid over boxes. */
class Grid2 {
  private cells = new Map<number, number[]>();
  private minX = Infinity;
  private minY = Infinity;
  private cell = 1;
  private n = 1;
  constructor(boxes: readonly Box[], pad: number) {
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boxes) {
      this.minX = Math.min(this.minX, b.minX);
      this.minY = Math.min(this.minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (boxes.length === 0) return;
    this.n = Math.max(4, Math.min(512, Math.ceil(Math.sqrt(boxes.length))));
    this.cell = Math.max(maxX - this.minX, maxY - this.minY, 1e-9) / this.n + 1e-12;
    boxes.forEach((b, i) => {
      for (const k of this.keys(b, pad)) {
        const l = this.cells.get(k);
        if (l === undefined) this.cells.set(k, [i]);
        else l.push(i);
      }
    });
  }
  private *keys(b: Box, pad: number): Generator<number> {
    const x0 = Math.floor((b.minX - pad - this.minX) / this.cell);
    const x1 = Math.floor((b.maxX + pad - this.minX) / this.cell);
    const y0 = Math.floor((b.minY - pad - this.minY) / this.cell);
    const y1 = Math.floor((b.maxY + pad - this.minY) / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield x * 100003 + y;
  }
  query(b: Box, pad: number): number[] {
    const out = new Set<number>();
    for (const k of this.keys(b, pad)) for (const i of this.cells.get(k) ?? []) out.add(i);
    return [...out];
  }
}

/** Grid that segments are added to as they're drawn. */
class DynamicGrid2 {
  private cells = new Map<string, number[]>();
  constructor(private cell: number) {}
  add(i: number, a: Point, b: Point): void {
    const c = this.cell;
    for (let x = Math.floor(Math.min(a.x, b.x) / c) - 1; x <= Math.floor(Math.max(a.x, b.x) / c) + 1; x++) {
      for (let y = Math.floor(Math.min(a.y, b.y) / c) - 1; y <= Math.floor(Math.max(a.y, b.y) / c) + 1; y++) {
        const k = `${x},${y}`;
        const l = this.cells.get(k);
        if (l === undefined) this.cells.set(k, [i]);
        else l.push(i);
      }
    }
  }
  near(p: Point): number[] {
    return this.cells.get(`${Math.floor(p.x / this.cell)},${Math.floor(p.y / this.cell)}`) ?? [];
  }
}

/** Fractions along a->b where segment c->d crosses or touches it (for a
 *  collinear overlap: where c and d fall on it). */
function crossings(a: Point, b: Point, c: Point, d: Point, tol: number): number[] {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const rr = r.x * r.x + r.y * r.y;
  if (rr === 0) return [];
  const denom = r.x * s.y - r.y * s.x;
  const ac = { x: c.x - a.x, y: c.y - a.y };
  const lr = Math.sqrt(rr);
  const ls = Math.hypot(s.x, s.y);
  if (Math.abs(denom) <= 1e-12 * lr * (ls || 1)) {
    // Parallel: only collinear ones matter.
    if (Math.abs(ac.x * r.y - ac.y * r.x) / lr > tol) return [];
    const out: number[] = [];
    for (const p of [c, d]) {
      const t = ((p.x - a.x) * r.x + (p.y - a.y) * r.y) / rr;
      if (t > 0 && t < 1) out.push(t);
    }
    return out;
  }
  const t = (ac.x * s.y - ac.y * s.x) / denom;
  const u = (ac.x * r.y - ac.y * r.x) / denom;
  const et = tol / lr;
  const eu = ls === 0 ? 0 : tol / ls;
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return [];
  return [Math.min(1, Math.max(0, t))];
}

function barycentric(a: Point, b: Point, c: Point, p: Point): [number, number, number] | null {
  const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (d === 0) return null;
  const w0 = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / d;
  const w1 = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / d;
  const w2 = 1 - w0 - w1;
  const e = -1e-9;
  return w0 < e || w1 < e || w2 < e ? null : [w0, w1, w2];
}

function distToLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
