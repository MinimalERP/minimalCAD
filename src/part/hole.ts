/**
 * MinimalCAD Web
 * part/hole.ts
 *
 * Hole feature geometry: one revolved cutter per centre (kernel/revolve.ts),
 * drilled along the face's inward normal -- or, on a round face (radial
 * holes), straight at its axis. The cutter starts slightly above the face
 * so the cut is clean (a round face never rises above the tangent plane at
 * the hole centre, so the same start works there).
 *
 *   plain        |  |          counterbore   |    |        countersink  \    /
 *                |  |                        |_  _|                      \  /
 *                |  |                          ||                         ||
 *   blind holes end in a 118 degree drill point.
 */

import type { Point } from "../core/types";
import type { Body } from "./kernel/types";
import type { RZ } from "./kernel/revolve";
import { revolveProfile } from "./kernel/revolve";
import type { Surface } from "./cylFrame";
import { alongSurface, cylTo3d, isCyl, radialDir, radiusAt, surfaceNormal } from "./cylFrame";
import type { Frame } from "./plane";
import { localTo3d } from "./plane";
import { evalExpression } from "./params";
import type { HoleDim, HoleFeature, HoleRef } from "./types";
import type { Vec3 } from "./vec3";
import { add, cross, dot, length, scale, sub } from "./vec3";

const DRILL_POINT_DEG = 118;

/** Hole profile in (r, z), z = depth below the face; null if values are invalid. */
export function holeProfile(
  h: Pick<HoleFeature, "style" | "extent">,
  values: { d: number; depth: number; cbD?: number; cbDepth?: number; csD?: number; csAngle?: number },
  throughLen: number,
  /** Extra start height: a leaning drill's flat end must clear the face all round. */
  extraLead = 0,
): RZ[] | string {
  const r = values.d / 2;
  if (!(r > 0)) return "Diameter must be positive";
  const through = h.extent === "through";
  const depth = through ? throughLen : values.depth;
  if (!(depth > 0)) return "Depth must be positive";
  const lead = Math.max(0.5, r * 0.2) + extraLead; // start above the face

  const top: RZ[] = [];
  if (h.style === "counterbore") {
    const cr = (values.cbD ?? 0) / 2;
    const cd = values.cbDepth ?? 0;
    if (!(cr > r)) return "Counterbore diameter must be larger than the hole";
    if (!(cd > 0) || (!through && cd >= depth)) return "Counterbore depth must be between 0 and the hole depth";
    top.push({ r: 0, z: -lead }, { r: cr, z: -lead }, { r: cr, z: cd }, { r, z: cd });
  } else if (h.style === "countersink") {
    const sr = (values.csD ?? 0) / 2;
    const half = (((values.csAngle ?? 90) / 2) * Math.PI) / 180;
    if (!(sr > r)) return "Countersink diameter must be larger than the hole";
    if (!(half > 0 && half < Math.PI / 2)) return "Countersink angle must be between 0 and 180";
    const sinkDepth = (sr - r) / Math.tan(half);
    if (!through && sinkDepth >= depth) return "Countersink is deeper than the hole";
    // Extend the cone above the face along the same slope, for a clean cut.
    top.push({ r: 0, z: -lead }, { r: sr + lead * Math.tan(half), z: -lead }, { r, z: sinkDepth });
  } else {
    top.push({ r: 0, z: -lead }, { r, z: -lead });
  }
  const tip = through ? 0 : r / Math.tan(((DRILL_POINT_DEG / 2) * Math.PI) / 180);
  return [...top, { r, z: depth }, { r: 0, z: depth + tip }];
}

/** Left normal of segment a->b (unit), or null if degenerate. */
function leftNormal(a: Point, b: Point): Point | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len === 0 ? null : { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
}

/** A reference as a line: through `p`, with unit normal `n`. A dimension
 *  "d from ref on side s" is then the line  q . n = p . n + s * d. */
export interface RefLine {
  p: Point;
  n: Point;
}

/** The line a reference measures from; `solved` = centres solved so far. */
export function refLine(ref: HoleRef, solved: readonly Point[]): RefLine | string {
  if (ref.kind === "edge") {
    const n = leftNormal(ref.seg[0], ref.seg[1]);
    return n === null ? "Degenerate edge" : { p: ref.seg[0], n };
  }
  const p = ref.kind === "point" ? ref.p : solved[ref.index];
  if (p === undefined) return "Referenced hole is not placed yet";
  // From a point: a horizontal ("u") distance is measured to a vertical line
  // through it, and vice versa.
  return { p, n: ref.axis === "u" ? { x: 1, y: 0 } : { x: 0, y: 1 } };
}

/** Signed distance of `q` from a reference line (along its normal). */
export function signedDistance(line: RefLine, q: Point): number {
  return (q.x - line.p.x) * line.n.x + (q.y - line.p.y) * line.n.y;
}

/** Solves one centre from its dimensions (0, 1 or 2); `fallback` is its
 *  stored position (moved onto the single line when only one dim is set). */
export function solveCenter(
  dims: readonly HoleDim[],
  fallback: Point,
  solved: readonly Point[],
  params: ReadonlyMap<string, number>,
): Point | string {
  const lines: { n: Point; c: number }[] = [];
  for (const dim of dims.slice(0, 2)) {
    const line = refLine(dim.ref, solved);
    if (typeof line === "string") return line;
    const d = evalExpression(dim.d, params);
    if (d === null) return `Invalid distance "${dim.d}"`;
    lines.push({ n: line.n, c: line.p.x * line.n.x + line.p.y * line.n.y + dim.side * d });
  }
  if (lines.length === 0) return fallback;
  if (lines.length === 1) {
    const { n, c } = lines[0]!;
    const off = fallback.x * n.x + fallback.y * n.y - c;
    return { x: fallback.x - off * n.x, y: fallback.y - off * n.y };
  }
  const [a, b] = [lines[0]!, lines[1]!];
  const det = a.n.x * b.n.y - a.n.y * b.n.x;
  if (Math.abs(det) < 1e-9) return "The two dimensions are parallel - pick one horizontal and one vertical reference";
  return { x: (a.c * b.n.y - b.c * a.n.y) / det, y: (a.n.x * b.c - b.n.x * a.c) / det };
}

/** Every centre solved in order (so a hole can be dimensioned from earlier ones). */
export function resolveCenters(h: Pick<HoleFeature, "centers">, params: ReadonlyMap<string, number>): Point[] | string {
  // Holes may be constrained from ANY other hole, so solve in dependency
  // order: repeatedly solve every hole whose referenced holes are solved.
  const n = h.centers.length;
  const out: (Point | undefined)[] = new Array(n).fill(undefined);
  const deps = h.centers.map((c) => (c.dims ?? []).flatMap((d) => (d.ref.kind === "hole" ? [d.ref.index] : [])));
  let remaining = n;
  while (remaining > 0) {
    let progress = false;
    for (let i = 0; i < n; i++) {
      if (out[i] !== undefined) continue;
      if (deps[i]!.some((j) => j < 0 || j >= n || j === i || out[j] === undefined)) continue;
      const c = h.centers[i]!;
      const p = c.dims === undefined ? { x: c.x, y: c.y } : solveCenter(c.dims, c, out as Point[], params);
      if (typeof p === "string") return `Hole ${i + 1}: ${p}`;
      out[i] = p;
      remaining--;
      progress = true;
    }
    if (!progress) return "Holes are constrained from each other in a loop - remove one of those constraints";
  }
  return out as Point[];
}

/** True if hole `from` depends (directly or through others) on hole `on`. */
export function dependsOn(h: Pick<HoleFeature, "centers">, from: number, on: number): boolean {
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (i === on) return true;
    if (seen.has(i)) continue;
    seen.add(i);
    for (const d of h.centers[i]?.dims ?? []) if (d.ref.kind === "hole") stack.push(d.ref.index);
  }
  return false;
}

/** How a hole leans: off straight-in by `angle`, toward `toward` (radians,
 *  in face coordinates), or null when it goes straight in. */
export function holeLean(h: Pick<HoleFeature, "lean" | "leanToward">, params: ReadonlyMap<string, number>): { angle: number; toward: number } | null | string {
  const value = (e: string | undefined): number | null => (e === undefined || e.trim() === "" ? 0 : evalExpression(e, params));
  const lean = value(h.lean);
  const toward = value(h.leanToward);
  if (lean === null || lean < 0 || lean > 80) return "Lean must be an angle from 0 to 80";
  if (toward === null) return "Lean direction must be an angle";
  return lean === 0 ? null : { angle: (lean * Math.PI) / 180, toward: (toward * Math.PI) / 180 };
}

/** True if a leaning hole on a round face leans along the axis only (its
 *  centreline still crosses the axis). */
export function leansAlongAxis(lean: { toward: number }): boolean {
  return Math.abs(Math.sin(lean.toward)) < 1e-9;
}

/**
 * Where the drill enters and which way it goes, for the centre `c` on
 * `frame`. Straight-in unless `lean`; with `atAxis` (round face, leaning
 * along the axis) `c.x` locates the point where the centreline crosses the
 * shaft's axis, and the entry point is worked back from there.
 */
export function drillAxis(frame: Surface, c: Point, lean: { angle: number; toward: number } | null, atAxis: boolean): { origin: Vec3; dir: Vec3 } {
  const cyl = isCyl(frame) ? frame : null;
  const out = cyl === null ? (frame as Frame).n : surfaceNormal(cyl, c.y);
  const entry = cyl === null ? localTo3d(frame as Frame, c) : cylTo3d(cyl, c);
  if (lean === null) return { origin: entry, dir: scale(out, -1) };
  // In-face directions the lean is measured in: flat = (u, v); round = (along the face, round the shaft).
  const t1 = cyl === null ? (frame as Frame).u : alongSurface(cyl, c.y);
  const t2 = cyl === null ? (frame as Frame).v : cross(cyl.axis, radialDir(cyl, c.y));
  const toward = add(scale(t1, Math.cos(lean.toward)), scale(t2, Math.sin(lean.toward)));
  const dir = add(scale(out, -Math.cos(lean.angle)), scale(toward, Math.sin(lean.angle)));
  if (cyl !== null && atAxis) {
    // Back from the crossing point on the axis to the surface (on a cone the
    // surface is met where its radius has changed along the way).
    const crossing = add(cyl.origin, scale(cyl.axis, c.x));
    const back = radiusAt(cyl, c.x) / (-dot(dir, radialDir(cyl, c.y)) + cyl.slope * dot(dir, cyl.axis));
    return { origin: sub(crossing, scale(dir, back)), dir };
  }
  return { origin: entry, dir };
}

/** One cutter body per centre, or an error message. */
export function holeTools(
  h: HoleFeature,
  frame: Surface,
  params: ReadonlyMap<string, number>,
  throughLen: number,
): Body[] | string {
  const ev = (e: string | undefined): number | undefined => (e === undefined ? undefined : (evalExpression(e, params) ?? NaN));
  const d = ev(h.diameter);
  const depth = ev(h.depth);
  if (d === undefined || Number.isNaN(d)) return `Invalid diameter "${h.diameter}"`;
  const cyl = isCyl(frame) ? frame : null;
  const lean = holeLean(h, params);
  if (typeof lean === "string") return lean;
  const alongAxis = lean === null || leansAlongAxis(lean);
  if (h.extent === "toAxis" && cyl === null) return "To axis is only for holes on a round face";
  if (h.extent === "toAxis" && !alongAxis) return "A hole leaning round the shaft misses the axis - use Distance or Through all";
  const atAxis = h.locate === "axis" && cyl !== null && lean !== null;
  if (atAxis && !alongAxis) return "The distance can locate the axis crossing only when the hole leans along the axis";
  // Along its own (leaning) line everything is longer by 1 / cos(lean).
  const stretch = lean === null ? 1 : 1 / Math.cos(lean.angle);
  const widestR = Math.max(d, h.style === "counterbore" ? (ev(h.cbDiameter) ?? 0) : 0, h.style === "countersink" ? (ev(h.csDiameter) ?? 0) : 0) / 2;
  if (h.extent === undefined && (depth === undefined || Number.isNaN(depth))) return `Invalid depth "${h.depth}"`;
  const widest = 2 * widestR;
  /** The drill's shape; `toAxis` = how deep "to the axis" is from where it enters. */
  const profileFor = (toAxis: number): ReturnType<typeof holeProfile> =>
    holeProfile(
      { style: h.style, extent: h.extent === "through" ? "through" : undefined },
      {
        d,
        depth: h.extent === "toAxis" ? toAxis : (depth ?? 0),
        cbD: ev(h.cbDiameter),
        cbDepth: ev(h.cbDepth),
        csD: ev(h.csDiameter),
        csAngle: ev(h.csAngle),
      },
      // A leaning drill's flat end is tilted to the far face: go further by
      // its radius x tan(lean) so the whole end is out the other side.
      throughLen * stretch + (lean === null ? 0 : widestR * Math.tan(lean.angle)),
      lean === null ? 0 : widestR * Math.tan(lean.angle),
    );
  const cone = cyl !== null && cyl.slope !== 0 ? cyl : null;
  // (A cone's own "to the axis" depth is worked out per hole below: any positive depth checks the rest here.)
  const profile = profileFor(cyl === null ? 0 : cone !== null ? 1 : cyl.radius * stretch);
  if (typeof profile === "string") return profile;
  if (cyl !== null && cone === null && widest >= 2 * cyl.radius) return `The hole is too wide for this round face (Ø${+(2 * cyl.radius).toFixed(3)})`;
  const centers = resolveCenters(h, params);
  if (typeof centers === "string") return centers;
  const tools: Body[] = [];
  for (const [i, c] of centers.entries()) {
    const axis = drillAxis(frame, c, lean, atAxis);
    let shape = profile;
    if (cone !== null) {
      // A cone's radius is its own at every hole: the width check and "to the axis" go hole by hole.
      const off = sub(axis.origin, cone.origin);
      const r = length(sub(off, scale(cone.axis, dot(off, cone.axis))));
      if (widest >= 2 * r) return `The hole is too wide for the cone there (Ø${+(2 * r).toFixed(3)})`;
      if (h.extent === "toAxis") {
        const toAxis = profileFor(r / -dot(axis.dir, radialDir(cone, c.y)));
        if (typeof toAxis === "string") return toAxis;
        shape = toAxis;
      }
    }
    tools.push(revolveProfile(h.id, `${i}`, shape, axis));
  }
  return tools;
}
