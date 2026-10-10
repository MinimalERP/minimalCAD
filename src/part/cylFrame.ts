/**
 * MinimalCAD Web
 * part/cylFrame.ts
 *
 * Coordinates ON a round face (a cylinder or a cone), for radial holes: a
 * point is (x = distance along the axis in mm, y = angle around it in
 * degrees). On a cone x is measured from its apex, and the face's radius
 * grows with it (`slope`).
 * Angle 0 is world +Z seen square to the axis (world +X when the axis is
 * vertical); angles run counter-clockwise looking down the axis.
 *
 * `Surface` is either a flat face's Frame or a CylFrame; surfaceTo3d()
 * and surfaceSegment() let the view draw on either.
 */

import type { Point } from "../core/types";
import type { FaceGeom } from "./kernel/types";
import type { Frame } from "./plane";
import { localTo3d } from "./plane";
import type { Vec3 } from "./vec3";
import { add, cross, dot, length, normalize, scale, sub, vec3 } from "./vec3";

export interface CylFrame {
  kind: "cyl";
  /** A point on the axis (x = 0 there). */
  origin: Vec3;
  /** Unit axis direction. */
  axis: Vec3;
  /** Unit direction of angle 0, square to the axis. */
  ref: Vec3;
  /** Unit direction of angle 90 (axis x ref). */
  side: Vec3;
  /** Radius at x = 0: the cylinder's own; 0 for a cone (x = 0 is its apex). */
  radius: number;
  /** Radius gained per mm along the axis: 0 = a cylinder, else a cone. */
  slope: number;
}

export type Surface = Frame | CylFrame;

export const isCyl = (s: Surface): s is CylFrame => "kind" in s && s.kind === "cyl";

const DEG = Math.PI / 180;

function roundFrameOn(origin: Vec3, axisDir: Vec3, radius: number, slope: number): CylFrame {
  const axis = normalize(axisDir);
  let ref = sub(vec3(0, 0, 1), scale(axis, axis.z));
  if (length(ref) < 1e-6) ref = sub(vec3(1, 0, 0), scale(axis, axis.x));
  ref = normalize(ref);
  return { kind: "cyl", origin, axis, ref, side: cross(axis, ref), radius, slope };
}

export function cylFrame(g: Extract<FaceGeom, { kind: "cylinder" }>): CylFrame {
  return roundFrameOn(g.axisOrigin, g.axis, g.radius, 0);
}

/** A cone's frame: x runs from the apex along the axis, toward the wide end. */
export function coneFrame(g: Extract<FaceGeom, { kind: "cone" }>): CylFrame {
  return roundFrameOn(g.apex, g.axis, 0, Math.tan(g.halfAngle));
}

/** The frame of a round face (cylinder or cone); null for any other face. */
export function roundFrame(g: FaceGeom): CylFrame | null {
  return g.kind === "cylinder" ? cylFrame(g) : g.kind === "cone" ? coneFrame(g) : null;
}

/** The face's radius at `x` along its axis. */
export const radiusAt = (f: CylFrame, x: number): number => f.radius + f.slope * x;

/** Unit direction (square to the axis) at angle `deg`. */
export function radialDir(f: CylFrame, deg: number): Vec3 {
  return add(scale(f.ref, Math.cos(deg * DEG)), scale(f.side, Math.sin(deg * DEG)));
}

/** Angle (degrees, -180..180) of a direction square to the axis. */
export function angleOf(f: CylFrame, d: Vec3): number {
  return Math.atan2(dot(d, f.side), dot(d, f.ref)) / DEG;
}

/** Unit direction straight out of the surface at angle `deg` (on a cone it tips back toward the apex). */
export function surfaceNormal(f: CylFrame, deg: number): Vec3 {
  const r = radialDir(f, deg);
  return f.slope === 0 ? r : normalize(sub(r, scale(f.axis, f.slope)));
}

/** Unit direction along the surface at angle `deg`, toward growing x (a cone's slant line). */
export function alongSurface(f: CylFrame, deg: number): Vec3 {
  return f.slope === 0 ? f.axis : normalize(add(f.axis, scale(radialDir(f, deg), f.slope)));
}

/** Face point -> world, `h` out from the surface. */
export function cylTo3d(f: CylFrame, p: Point, h = 0): Vec3 {
  const on = add(add(f.origin, scale(f.axis, p.x)), scale(radialDir(f, p.y), radiusAt(f, p.x)));
  return h === 0 ? on : add(on, scale(surfaceNormal(f, p.y), h));
}

/** World point -> face point (projected onto the round face). */
export function cylFromWorld(f: CylFrame, w: Vec3): Point {
  const d = sub(w, f.origin);
  return { x: dot(d, f.axis), y: angleOf(f, d) };
}

/** Angle difference folded into (-180, 180]. */
export function wrapDeg(a: number): number {
  let r = ((a % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
}

/** mm per degree around the face (at `x` along it: a cone's radius changes). */
export const mmPerDeg = (f: CylFrame, x = 0): number => radiusAt(f, x) * DEG;

export function surfaceTo3d(s: Surface, p: Point, h = 0): Vec3 {
  return isCyl(s) ? cylTo3d(s, p, h) : localTo3d(s, p, h);
}

/** A straight segment in face coordinates as world points: on a round
 *  face it follows the surface (an arc / helix), so it is subdivided. */
export function surfaceSegment(s: Surface, a: Point, b: Point, h = 0): Vec3[] {
  if (!isCyl(s)) return [localTo3d(s, a, h), localTo3d(s, b, h)];
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
  // 4 degrees a piece; never more than a full turn's worth.
  const n = Math.min(90, Math.max(1, Math.ceil(Math.abs(b.y - a.y) / 4)));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(cylTo3d(s, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, h));
  }
  return out;
}
