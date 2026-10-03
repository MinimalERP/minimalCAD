/**
 * MinimalCAD Web
 * part/line3d.ts
 *
 * 3D Line (AutoCAD-style): points picked anywhere in space, snapped to the
 * solid. A closed, flat loop becomes an ordinary sketch on a work plane
 * through its points (WorkPlane `on.points`), so it can be extruded off its
 * own plane -- and edited later with every 2D tool.
 */

import type { Point } from "../core/types";
import { Line } from "../entities/line";
import type { Body } from "./kernel/types";
import type { Frame } from "./plane";
import type { Vec3 } from "./vec3";
import { add, cross, dot, length, normalize, scale, sub } from "./vec3";

export type Snap3dKind = "end" | "mid" | "cen";

export interface Snap3d {
  p: Vec3;
  kind: Snap3dKind;
}

/** Osnap points of the solids: edge ends, straight-edge middles, arc / circle centres. */
export function snapPoints3d(bodies: readonly Body[]): Snap3d[] {
  const out: Snap3d[] = [];
  const seen = new Set<string>();
  const push = (p: Vec3, kind: Snap3dKind): void => {
    const key = `${kind}:${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ p, kind });
  };
  for (const body of bodies) {
    for (const e of body.edges) {
      const g = e.geom;
      if (g.kind === "line") {
        push(g.a, "end");
        push(g.b, "end");
        push(scale(add(g.a, g.b), 0.5), "mid");
      } else if (g.kind === "arc") {
        push(g.center, "cen");
        if (Math.abs(Math.abs(g.sweep) - 2 * Math.PI) > 1e-6) {
          push(g.start, "end");
          // the arc's other end: start turned by sweep about the normal
          const k = normalize(g.normal);
          const r = sub(g.start, g.center);
          const c = Math.cos(g.sweep);
          const s = Math.sin(g.sweep);
          push(add(g.center, add(add(scale(r, c), scale(cross(k, r), s)), scale(k, dot(k, r) * (1 - c)))), "end");
        }
      } else if (g.pts.length > 0) {
        push(g.pts[0]!, "end");
        push(g.pts[g.pts.length - 1]!, "end");
      }
    }
  }
  return out;
}

/** Size-relative tolerance for "on the plane" checks. */
export function planeTol(points: readonly Vec3[]): number {
  let size = 1;
  for (const p of points) size = Math.max(size, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  return size * 1e-5;
}

/** The first three points that aren't in one line, or null. */
export function planeTriple(points: readonly Vec3[]): [Vec3, Vec3, Vec3] | null {
  const tol = planeTol(points);
  const a = points[0];
  if (a === undefined) return null;
  const b = points.find((p) => length(sub(p, a)) > tol);
  if (b === undefined) return null;
  const ab = normalize(sub(b, a));
  const c = points.find((p) => length(cross(ab, sub(p, a))) > tol);
  return c === undefined ? null : [a, b, c];
}

/** The loop's plane (through `planeTriple`), or null if the points are all in one line. */
export function loopPlane(points: readonly Vec3[]): { origin: Vec3; n: Vec3 } | null {
  const t = planeTriple(points);
  if (t === null) return null;
  return { origin: t[0], n: normalize(cross(sub(t[1], t[0]), sub(t[2], t[0]))) };
}

/** True if every point lies on the plane of the first non-collinear three. */
export function isPlanar(points: readonly Vec3[]): boolean {
  const plane = loopPlane(points);
  if (plane === null) return false;
  const tol = planeTol(points) * 10;
  return points.every((p) => Math.abs(dot(sub(p, plane.origin), plane.n)) <= tol);
}

/** A world point in sketch coordinates (Y-down, as stored) on `frame`. */
export function toSketch(frame: Frame, p: Vec3): Point {
  const d = sub(p, frame.origin);
  return { x: dot(d, frame.u), y: -dot(d, frame.v) };
}

/** The chain as serialized sketch Lines on `frame` (closed: back to the start). */
export function chainToSketch(points: readonly Vec3[], frame: Frame, closed: boolean): Record<string, unknown>[] {
  const pts = points.map((p) => toSketch(frame, p));
  const out: Record<string, unknown>[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) out.push(new Line(pts[i]!, pts[(i + 1) % pts.length]!).serialize());
  return out;
}
