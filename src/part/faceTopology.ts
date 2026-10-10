/**
 * MinimalCAD Web
 * part/faceTopology.ts
 *
 * The edges that lie ON a flat face (its own boundary and holes), in the
 * face's plane coordinates -- for osnaps and edge picking on that face only,
 * so hidden edges of other parts never pull the cursor. And, for a round
 * face, what a radial hole can be dimensioned from (refsOnRoundFace).
 */

import type { Point } from "../core/types";
import type { Body, Edge, TopoRef } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import type { CylFrame } from "./cylFrame";
import { angleOf, radiusAt, wrapDeg } from "./cylFrame";
import type { Frame } from "./plane";
import type { Vec3 } from "./vec3";
import { cross, dot, length, normalize, scale, sub } from "./vec3";

export interface FaceSnap {
  point: Point;
  kind: "endpoint" | "midpoint" | "center";
}

export interface FaceEdges {
  lines: [Point, Point][];
  circles: { center: Point; radius: number }[];
  snaps: FaceSnap[];
}

function onPlane(frame: Frame, p: Vec3, tol: number): boolean {
  return Math.abs(dot(sub(p, frame.origin), frame.n)) <= tol;
}

function toFace(frame: Frame, p: Vec3): Point {
  const d = sub(p, frame.origin);
  return { x: dot(d, frame.u), y: dot(d, frame.v) };
}

function arcEnd(g: Extract<Edge["geom"], { kind: "arc" }>): Vec3 {
  const e1 = normalize(sub(g.start, g.center));
  const e2 = cross(normalize(g.normal), e1);
  const c = Math.cos(g.sweep);
  const s = Math.sin(g.sweep);
  return {
    x: g.center.x + g.radius * (e1.x * c + e2.x * s),
    y: g.center.y + g.radius * (e1.y * c + e2.y * s),
    z: g.center.z + g.radius * (e1.z * c + e2.z * s),
  };
}

/** Edges of `body` lying in `frame`'s plane, as face coordinates. */
export function edgesOnFace(body: Body, frame: Frame): FaceEdges {
  let size = 1;
  const p = body.mesh.positions;
  for (let i = 0; i < p.length; i++) size = Math.max(size, Math.abs(p[i]!));
  const tol = size * 1e-7;

  const out: FaceEdges = { lines: [], circles: [], snaps: [] };
  for (const e of body.edges) {
    const g = e.geom;
    if (g.kind === "line") {
      if (!onPlane(frame, g.a, tol) || !onPlane(frame, g.b, tol)) continue;
      const a = toFace(frame, g.a);
      const b = toFace(frame, g.b);
      out.lines.push([a, b]);
      out.snaps.push({ point: a, kind: "endpoint" }, { point: b, kind: "endpoint" });
      out.snaps.push({ point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: "midpoint" });
    } else if (g.kind === "arc") {
      // Only circles lying flat in the face (normal along the face normal).
      if (!onPlane(frame, g.center, tol) || length(cross(normalize(g.normal), frame.n)) > 1e-6) continue;
      const c = toFace(frame, g.center);
      out.circles.push({ center: c, radius: g.radius });
      out.snaps.push({ point: c, kind: "center" });
      if (Math.abs(Math.abs(g.sweep) - 2 * Math.PI) > 1e-9) {
        out.snaps.push({ point: toFace(frame, g.start), kind: "endpoint" }, { point: toFace(frame, arcEnd(g)), kind: "endpoint" });
      }
    } else if (g.pts.every((q) => onPlane(frame, q, tol))) {
      const pts = g.pts.map((q) => toFace(frame, q));
      out.snaps.push({ point: pts[0]!, kind: "endpoint" }, { point: pts[pts.length - 1]!, kind: "endpoint" });
    }
  }
  return out;
}

/** Something a radial hole can be dimensioned from, as a line in the round
 *  face's (along axis, angle) coords: x = const (an end face's rim: a
 *  distance along the axis) or y = const (an angle reference). */
export interface RoundFaceRef {
  seg: [Point, Point];
  label: string;
  /** Set for a flat running along the shaft (clicking that face picks it). */
  flat?: TopoRef;
}

const MAIN_PLANES: [string, Vec3][] = [
  ["XY", { x: 0, y: 0, z: 1 }],
  ["XZ", { x: 0, y: 1, z: 0 }],
  ["YZ", { x: 1, y: 0, z: 0 }],
];

/** References for holes on the round face `ref` of `body`: end-face rims,
 *  straight seams along it, flats along the shaft (at their normal's
 *  angle) and the main planes through the axis (both sides). */
export function refsOnRoundFace(body: Body, ref: TopoRef, cyl: CylFrame): RoundFaceRef[] {
  let tol = cyl.radius * 1e-6 + 1e-9;
  const along = (p: Vec3): number => dot(sub(p, cyl.origin), cyl.axis);
  const offAxis = (p: Vec3): number => {
    const d = sub(p, cyl.origin);
    return length(sub(d, scale(cyl.axis, dot(d, cyl.axis))));
  };
  // Axial extent of the face, from its own triangles.
  const face = body.faces.find((f) => faceHasRef(f, ref));
  let x0 = Infinity;
  let x1 = -Infinity;
  const { positions, indices, faceIds } = body.mesh;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face?.id) continue;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k]!;
      const x = along({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! });
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
    }
  }
  if (!(x1 > x0)) return [];
  // The face's widest radius (a cone's changes along it).
  const widest = Math.max(radiusAt(cyl, x0), radiusAt(cyl, x1));
  tol = widest * 1e-6 + 1e-9;

  const out: RoundFaceRef[] = [];
  const rims: number[] = [];
  for (const e of body.edges) {
    const g = e.geom;
    if (g.kind === "arc") {
      // A circle square to the axis, centred on it: an end face's rim.
      if (Math.abs(Math.abs(dot(normalize(g.normal), cyl.axis)) - 1) > 1e-6 || offAxis(g.center) > tol * 10) continue;
      const x = along(g.center);
      if (x < x0 - tol || x > x1 + tol || rims.some((r) => Math.abs(r - x) <= tol)) continue;
      rims.push(x);
      out.push({ seg: [{ x, y: -180 }, { x, y: 180 }], label: "end face" });
    } else if (g.kind === "line") {
      // A straight seam along the face (from the tessellated surface, so
      // up to a chord's sag inside the true radius).
      const d = sub(g.b, g.a);
      if (length(cross(d, cyl.axis)) > length(d) * 1e-6) continue;
      if (cyl.slope !== 0 || Math.abs(offAxis(g.a) - cyl.radius) > cyl.radius * 2e-3) continue;
      const y = angleOf(cyl, sub(g.a, cyl.origin));
      const [xa, xb] = [along(g.a), along(g.b)].sort((p, q) => p - q) as [number, number];
      out.push({ seg: [{ x: xa, y }, { x: xb, y }], label: "edge" });
    }
  }
  for (const f of body.faces) {
    if (f.geom.kind !== "plane") continue;
    const n = normalize(f.geom.normal);
    if (Math.abs(dot(n, cyl.axis)) > 1e-6) continue;
    // A flat along the shaft, cutting into it (a key flat): angle of its normal.
    if (Math.abs(dot(sub(f.geom.origin, cyl.origin), n)) >= widest - tol) continue;
    const y = angleOf(cyl, n);
    out.push({ seg: [{ x: x0, y }, { x: x1, y }], label: "flat", flat: f.ref });
  }
  for (const [name, n] of MAIN_PLANES) {
    if (Math.abs(dot(n, cyl.axis)) > 1e-6) continue;
    const y = angleOf(cyl, cross(cyl.axis, n));
    for (const a of [y, wrapDeg(y + 180)]) out.push({ seg: [{ x: x0, y: a }, { x: x1, y: a }], label: `${name} plane` });
  }
  return out;
}
