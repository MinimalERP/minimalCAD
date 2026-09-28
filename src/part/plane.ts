/**
 * MinimalCAD Web
 * part/plane.ts
 *
 * Sketch-plane frames. The 3D world is Z-up, like AutoCAD: the 2D drafting
 * drawing IS the XY ground plane (Top view), XZ is the Front plane (seen
 * from -Y) and YZ the Right plane (seen from +X). Each frame's (u, v) is
 * what you see looking at the plane from its +normal side: u to the right,
 * v up, n = u x v toward you.
 *
 * The ONE place the 2D engine's Y-down world meets 3D: a sketch's stored
 * point (x, y) maps to plane-local (x, -y), so what the user drew "up" on
 * screen is +v. Everything downstream (profile.ts, the kernel) works in
 * plane-local coordinates via toLocal().
 */

import type { Point } from "../core/types";
import type { BasePlane, WorkPlane } from "./types";
import type { Vec3 } from "./vec3";
import { add, cross, dot, normalize, scale, sub, vec3 } from "./vec3";

export interface Frame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

const BASE_FRAMES: Record<BasePlane, Omit<Frame, "origin">> = {
  XY: { u: vec3(1, 0, 0), v: vec3(0, 1, 0), n: vec3(0, 0, 1) },
  XZ: { u: vec3(1, 0, 0), v: vec3(0, 0, 1), n: vec3(0, -1, 0) },
  YZ: { u: vec3(0, 1, 0), v: vec3(0, 0, 1), n: vec3(1, 0, 0) },
};

export function planeFrame(plane: { base: BasePlane; offset: number }): Frame {
  const base = BASE_FRAMES[plane.base];
  return { ...base, origin: scale(base.n, plane.offset) };
}

/** Rodrigues rotation of `p` about unit axis `k` by `angle` radians. */
function rotate(p: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(p, c), scale(cross(k, p), s)), scale(k, dot(k, p) * (1 - c)));
}

/** A work plane's frame from its already-evaluated offset (mm) / angle (deg). */
export function workPlaneFrame(wp: Pick<WorkPlane, "base" | "axis">, offset: number, angleDeg: number): Frame {
  const base = BASE_FRAMES[wp.base];
  const axis = wp.axis === "u" ? base.u : base.v;
  const a = (angleDeg * Math.PI) / 180;
  const u = rotate(base.u, axis, a);
  const v = rotate(base.v, axis, a);
  const n = rotate(base.n, axis, a);
  return { u, v, n, origin: scale(n, offset) };
}

/**
 * Sketch frame on a flat face with outward normal `n` through point `p`.
 * Orientation follows the origin plane the face is most parallel to, keeping
 * that plane's "up" (so a side face reads like Front/Right view, the top
 * like Top view); origin = the world origin projected onto the face, so
 * sketch coordinates line up with the model's.
 */
export function faceFrame(p: Vec3, n: Vec3): Frame {
  const nn = normalize(n);
  let best = BASE_FRAMES.XY;
  for (const f of Object.values(BASE_FRAMES)) {
    if (Math.abs(dot(f.n, nn)) > Math.abs(dot(best.n, nn))) best = f;
  }
  const v = normalize(sub(best.v, scale(nn, dot(best.v, nn))));
  const u = cross(v, nn);
  return { u, v, n: nn, origin: scale(nn, dot(p, nn)) };
}

/** "X", "-Z", ... for a world-axis-aligned direction; "" otherwise. */
export function axisName(d: Vec3): string {
  const comps: [number, string][] = [
    [d.x, "X"],
    [d.y, "Y"],
    [d.z, "Z"],
  ];
  for (const [value, name] of comps) {
    if (Math.abs(Math.abs(value) - 1) < 1e-6) return value > 0 ? name : `-${name}`;
  }
  return "";
}

/** Frame shifted along its own normal. */
export function offsetFrame(frame: Frame, distance: number): Frame {
  return { ...frame, origin: add(frame.origin, scale(frame.n, distance)) };
}

/** Sketch (Y-down 2D engine) point -> plane-local (Y-up) point. */
export function toLocal(p: Point): Point {
  return { x: p.x, y: -p.y };
}

/** Plane-local point -> sketch (Y-down) point. Inverse of toLocal(). */
export function fromLocal(p: Point): Point {
  return { x: p.x, y: -p.y };
}

/** Plane-local 2D point at height `h` along the normal -> world 3D. */
export function localTo3d(frame: Frame, p: Point, h = 0): Vec3 {
  return add(add(add(frame.origin, scale(frame.u, p.x)), scale(frame.v, p.y)), scale(frame.n, h));
}
