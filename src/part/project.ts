/**
 * MinimalCAD Web
 * part/project.ts
 *
 * Projects solid bodies onto a sketch plane as ordinary 2D entities (in the
 * sketch's Y-down coordinates), for use as snappable reference geometry
 * while sketching -- Inventor's "projected geometry".
 *
 * Works from the kernel's ANALYTIC edges, so projections are exact: a line
 * stays a line; a circle parallel to the plane stays a circle/arc, seen
 * edge-on it becomes a line, otherwise a full circle becomes an exact
 * ellipse. Cylinder silhouettes (the outline of a round face seen from the
 * side, which isn't an edge) are added too. The same projection will
 * later drive drawing views.
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { Circle } from "../entities/circle";
import { Ellipse } from "../entities/ellipse";
import { Polyline } from "../entities/polyline";
import type { Body, Edge } from "./kernel/types";
import type { Frame } from "./plane";
import { fromLocal } from "./plane";
import type { Vec3 } from "./vec3";
import { add, cross, dot, length, normalize, scale, sub } from "./vec3";

const EPS = 1e-9;

/** World point -> plane-local 2D (Y-up). */
function toPlane(frame: Frame, p: Vec3): Point {
  const d = sub(p, frame.origin);
  return { x: dot(d, frame.u), y: dot(d, frame.v) };
}

/** World point -> sketch (Y-down) coordinates. */
function toSketch(frame: Frame, p: Vec3): Point {
  return fromLocal(toPlane(frame, p));
}

function line(a: Point, b: Point): Line | null {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-7 ? null : new Line(a, b);
}

function arcPoint(center: Vec3, e1: Vec3, e2: Vec3, r: number, t: number): Vec3 {
  return add(center, add(scale(e1, r * Math.cos(t)), scale(e2, r * Math.sin(t))));
}

function projectArc(frame: Frame, g: Extract<Edge["geom"], { kind: "arc" }>): Entity | null {
  const n = normalize(g.normal);
  const e1 = normalize(sub(g.start, g.center));
  const e2 = cross(n, e1);
  const full = Math.abs(Math.abs(g.sweep) - 2 * Math.PI) < 1e-9;
  const alignment = dot(n, frame.n);

  if (Math.abs(Math.abs(alignment) - 1) < 1e-9) {
    // Parallel to the sketch plane: a true circle/arc.
    const c = toSketch(frame, g.center);
    if (full) return new Circle(c, g.radius);
    // Plane-local (Y-up) angles, with the sweep's sense as seen from +n.
    const s0 = toPlane(frame, g.start);
    const cl = toPlane(frame, g.center);
    const a0 = Math.atan2(s0.y - cl.y, s0.x - cl.x);
    const sweep = g.sweep * Math.sign(alignment);
    // Sketch coords flip Y: local angle a -> -a, so a CCW local sweep runs backwards.
    return sweep > 0 ? new Arc(c, g.radius, -(a0 + sweep), -a0) : new Arc(c, g.radius, -a0, -a0 - sweep);
  }

  // Sample the arc; seen edge-on it collapses to its extreme segment.
  const steps = Math.max(16, Math.ceil((Math.abs(g.sweep) / (2 * Math.PI)) * 96));
  const pts3: Vec3[] = [];
  for (let i = 0; i <= steps; i++) pts3.push(arcPoint(g.center, e1, e2, g.radius, (g.sweep * i) / steps));
  const pts = pts3.map((p) => toSketch(frame, p));

  if (Math.abs(alignment) < 1e-9) {
    // Edge-on: all points on one line through the projected center.
    const dir = normalize(cross(n, frame.n));
    const along = pts3.map((p) => dot(sub(p, g.center), dir));
    const iMin = along.indexOf(Math.min(...along));
    const iMax = along.indexOf(Math.max(...along));
    return line(pts[iMin]!, pts[iMax]!);
  }

  if (full) {
    // Exact ellipse: major axis along the in-plane direction perpendicular
    // to the projected circle normal, minor = r * |cos(tilt)|.
    const major3 = normalize(cross(n, frame.n));
    const c = toSketch(frame, g.center);
    const m = toSketch(frame, add(g.center, scale(major3, g.radius)));
    const rotation = Math.atan2(m.y - c.y, m.x - c.x);
    return new Ellipse(c, g.radius, g.radius * Math.abs(alignment), rotation);
  }
  return new Polyline(
    pts.map((point) => ({ point, bulge: 0 })),
    false,
  );
}

function projectEdge(frame: Frame, edge: Edge): Entity | null {
  const g = edge.geom;
  if (g.kind === "line") return line(toSketch(frame, g.a), toSketch(frame, g.b));
  if (g.kind === "arc") return projectArc(frame, g);
  const pts = g.pts.map((p) => toSketch(frame, p));
  return pts.length < 2 ? null : new Polyline(pts.map((point) => ({ point, bulge: 0 })), false);
}

/** Outline lines of cylindrical faces seen from the side. */
function silhouettes(frame: Frame, body: Body): Entity[] {
  const out: Entity[] = [];
  const { positions, indices, faceIds } = body.mesh;
  for (const face of body.faces) {
    if (face.geom.kind !== "cylinder") continue;
    const a = normalize(face.geom.axis);
    const side = cross(a, frame.n);
    if (length(side) < 1e-6) continue; // looking down the axis: the rim circles say it all
    const rho = normalize(side);
    // The face's extent along its axis, and which radial directions it covers.
    let tMin = Infinity;
    let tMax = -Infinity;
    const radials: Vec3[] = [];
    for (let t = 0; t < faceIds.length; t++) {
      if (faceIds[t] !== face.id) continue;
      for (let k = 0; k < 3; k++) {
        const i = indices[t * 3 + k]!;
        const p = { x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! };
        const d = sub(p, face.geom.axisOrigin);
        const along = dot(d, a);
        tMin = Math.min(tMin, along);
        tMax = Math.max(tMax, along);
        radials.push(normalize(sub(d, scale(a, along))));
      }
    }
    if (!Number.isFinite(tMin) || tMax - tMin < EPS) continue;
    for (const sign of [1, -1]) {
      const dir = scale(rho, sign);
      // Only if the (possibly partial) cylinder actually reaches that side.
      if (!radials.some((r) => dot(r, dir) > Math.cos(Math.PI / 30))) continue;
      const base = add(face.geom.axisOrigin, scale(dir, face.geom.radius));
      const l = line(toSketch(frame, add(base, scale(a, tMin))), toSketch(frame, add(base, scale(a, tMax))));
      if (l !== null) out.push(l);
    }
  }
  return out;
}

function lineKey(l: Line): string {
  const r = (v: number): number => Math.round(v * 1e4);
  const a = `${r(l.startPoint.x)},${r(l.startPoint.y)}`;
  const b = `${r(l.endPoint.x)},${r(l.endPoint.y)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Every body's edges (plus silhouettes) projected onto `frame`, with
 *  exact-duplicate lines removed (e.g. a prism's top and bottom edges seen
 *  from the side land on the same line). */
export function projectBodies(bodies: readonly Body[], frame: Frame): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    const projected = [...body.edges.map((e) => projectEdge(frame, e)), ...silhouettes(frame, body)];
    for (const e of projected) {
      if (e === null) continue;
      if (e instanceof Line) {
        const key = lineKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(e);
    }
  }
  return out;
}
