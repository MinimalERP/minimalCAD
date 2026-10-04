/**
 * MinimalCAD Web
 * part/measure.ts
 *
 * 3D Measure (read-only): the angle between two flat faces or two straight
 * edges, the distance between two points or between two faces / edges, an
 * edge's length / radius, a face's area, a solid's volume. Analytic geometry wherever the kernel has it (planes,
 * cylinders, lines, arcs); a face's area is summed from its triangles,
 * which is exact for flat faces.
 */

import type { Body, Edge, Face } from "./kernel/types";
import type { Vec3 } from "./vec3";
import { cross, dot, length, normalize, sub } from "./vec3";

const DEG = 180 / Math.PI;

export interface FaceAngle {
  /** Angle between the two planes, 0..90°. */
  planes: number;
  /** Angle between the faces as they meet (between their outward normals' supplement), 0..180°. */
  between: number;
  /** Parallel faces: the gap between their planes. */
  gap?: number;
}

/** Angle between two flat faces, or why it can't be measured. */
export function faceAngle(a: Face, b: Face): FaceAngle | string {
  if (a.geom.kind !== "plane" || b.geom.kind !== "plane") return "Pick flat faces to measure an angle";
  const na = normalize(a.geom.normal);
  const nb = normalize(b.geom.normal);
  const c = Math.max(-1, Math.min(1, dot(na, nb)));
  const out: FaceAngle = { planes: Math.acos(Math.abs(c)) * DEG, between: 180 - Math.acos(c) * DEG };
  if (length(cross(na, nb)) < 1e-9) out.gap = Math.abs(dot(sub(b.geom.origin, a.geom.origin), na));
  return out;
}

/** Angle between two straight edges' directions (0..90°), or why not. */
export function edgeAngle(a: Edge, b: Edge): number | string {
  if (a.geom.kind !== "line" || b.geom.kind !== "line") return "Pick straight edges to measure an angle";
  const da = normalize(sub(a.geom.b, a.geom.a));
  const db = normalize(sub(b.geom.b, b.geom.a));
  return Math.acos(Math.min(1, Math.abs(dot(da, db)))) * DEG;
}

export interface PointDistance {
  distance: number;
  dx: number;
  dy: number;
  dz: number;
}

export function pointDistance(a: Vec3, b: Vec3): PointDistance {
  const d = sub(b, a);
  return { distance: length(d), dx: d.x, dy: d.y, dz: d.z };
}

export type EdgeMeasure =
  | { kind: "line"; length: number }
  | { kind: "arc"; radius: number; diameter: number; length: number; full: boolean }
  | { kind: "polyline"; length: number };

export function edgeMeasure(edge: Edge): EdgeMeasure {
  const g = edge.geom;
  if (g.kind === "line") return { kind: "line", length: length(sub(g.b, g.a)) };
  if (g.kind === "arc") {
    const full = Math.abs(Math.abs(g.sweep) - 2 * Math.PI) < 1e-6;
    return { kind: "arc", radius: g.radius, diameter: 2 * g.radius, length: Math.abs(g.sweep) * g.radius, full };
  }
  let len = 0;
  for (let i = 1; i < g.pts.length; i++) len += length(sub(g.pts[i]!, g.pts[i - 1]!));
  return { kind: "polyline", length: len };
}

/** Area of face `faceId` of `body`, summed from its triangles. */
export function faceArea(body: Body, faceId: number): number {
  const { positions: p, indices, faceIds } = body.mesh;
  const v = (i: number): Vec3 => ({ x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! });
  let area = 0;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== faceId) continue;
    const a = v(indices[t * 3]!);
    area += length(cross(sub(v(indices[t * 3 + 1]!), a), sub(v(indices[t * 3 + 2]!), a))) / 2;
  }
  return area;
}

/** What a picked face / edge is, for a distance: a plane, a line (a
 *  straight edge, or a round face's axis) or a point (a round edge's centre). */
type DistanceRef =
  | { kind: "plane"; o: Vec3; n: Vec3 }
  | { kind: "line"; o: Vec3; d: Vec3; radius?: number }
  | { kind: "point"; p: Vec3; radius?: number };

function distanceRef(item: Face | Edge): DistanceRef | string {
  const g = item.geom;
  switch (g.kind) {
    case "plane":
      return { kind: "plane", o: g.origin, n: normalize(g.normal) };
    case "cylinder":
      return { kind: "line", o: g.axisOrigin, d: normalize(g.axis), radius: g.radius };
    case "cone":
      return { kind: "line", o: g.apex, d: normalize(g.axis) };
    case "torus":
      return { kind: "line", o: g.center, d: normalize(g.axis) };
    case "line":
      return length(sub(g.b, g.a)) > 0 ? { kind: "line", o: g.a, d: normalize(sub(g.b, g.a)) } : "That edge has no length";
    case "arc":
      return { kind: "point", p: g.center, radius: g.radius };
    default:
      return "Pick flat or round faces, straight edges or round edges - a free-form one has no single distance";
  }
}

export interface BetweenMeasure {
  /** Plane to plane, axis / centre to whatever the other is. */
  distance: number;
  /** True when a round face's axis or a round edge's centre was measured from. */
  toCentre: boolean;
  /** Round faces on parallel axes (or one against a flat face): the clear gap between the surfaces. */
  gap?: number;
  /** Two lines that neither meet nor run parallel: `distance` is their closest approach. */
  skew?: boolean;
}

/**
 * Distance between two faces / edges: the gap between parallel flat faces,
 * the centre distance of two holes or pins (and the wall left between
 * them), a hole's centre to a face or an edge, two parallel edges... Or why
 * there isn't one (they cross).
 */
export function betweenMeasure(a: Face | Edge, b: Face | Edge): BetweenMeasure | string {
  const ra = distanceRef(a);
  if (typeof ra === "string") return ra;
  const rb = distanceRef(b);
  if (typeof rb === "string") return rb;
  // Fewest cases: plane first, then line, then point.
  const rank = { plane: 0, line: 1, point: 2 };
  const [p, q] = rank[ra.kind] <= rank[rb.kind] ? [ra, rb] : [rb, ra];
  const toCentre = [p, q].some((r) => r.kind === "point" || (r.kind === "line" && r.radius !== undefined));
  const radii = (p.kind !== "plane" ? (p.radius ?? 0) : 0) + (q.kind !== "plane" ? (q.radius ?? 0) : 0);
  const withGap = (distance: number): BetweenMeasure => {
    const out: BetweenMeasure = { distance, toCentre };
    if (radii > 0 && p.kind !== "point" && q.kind === "line" && distance - radii > 1e-9) out.gap = distance - radii;
    return out;
  };
  if (p.kind === "plane") {
    if (q.kind === "plane") {
      if (length(cross(p.n, q.n)) > 1e-9) return "Those faces aren't parallel - they meet, so there is no one distance (use Angle)";
      return { distance: Math.abs(dot(sub(q.o, p.o), p.n)), toCentre: false };
    }
    if (q.kind === "line") {
      if (Math.abs(dot(q.d, p.n)) > 1e-9) return "That one runs through the face's plane - there is no one distance between them";
      return withGap(Math.abs(dot(sub(q.o, p.o), p.n)));
    }
    return { distance: Math.abs(dot(sub(q.p, p.o), p.n)), toCentre };
  }
  if (p.kind === "line") {
    if (q.kind === "point") return { distance: length(cross(sub(q.p, p.o), p.d)), toCentre };
    if (q.kind !== "line") return "Can't measure between those";
    const w = sub(q.o, p.o);
    const n = cross(p.d, q.d);
    if (length(n) < 1e-9) return withGap(length(cross(w, p.d))); // parallel
    return { distance: Math.abs(dot(w, normalize(n))), toCentre, skew: true };
  }
  return q.kind === "point" ? { distance: length(sub(q.p, p.p)), toCentre } : "Can't measure between those";
}

export interface SolidMeasure {
  volume: number;
  /** Whole surface. */
  area: number;
  /** Overall size along X, Y, Z. */
  size: Vec3;
  /** Centre of mass (uniform material). */
  centre: Vec3;
}

/** Volume, surface, overall size and centre of mass of a solid, from its
 *  triangles (exact for flat-sided solids, very close for round ones). */
export function solidMeasure(body: Body): SolidMeasure {
  const { positions: p, indices } = body.mesh;
  const v = (i: number): Vec3 => ({ x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! });
  let six = 0; // 6 x signed volume
  let area = 0;
  const c = { x: 0, y: 0, z: 0 };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let t = 0; t < indices.length / 3; t++) {
    const a = v(indices[t * 3]!);
    const b = v(indices[t * 3 + 1]!);
    const d = v(indices[t * 3 + 2]!);
    const n = cross(sub(b, a), sub(d, a));
    area += length(n) / 2;
    const tet = dot(a, cross(b, d)); // the tetrahedron down to the origin
    six += tet;
    c.x += tet * (a.x + b.x + d.x);
    c.y += tet * (a.y + b.y + d.y);
    c.z += tet * (a.z + b.z + d.z);
    for (const q of [a, b, d]) {
      min.x = Math.min(min.x, q.x);
      min.y = Math.min(min.y, q.y);
      min.z = Math.min(min.z, q.z);
      max.x = Math.max(max.x, q.x);
      max.y = Math.max(max.y, q.y);
      max.z = Math.max(max.z, q.z);
    }
  }
  const k = six === 0 ? 0 : 1 / (4 * six);
  return { volume: Math.abs(six) / 6, area, size: sub(max, min), centre: { x: c.x * k, y: c.y * k, z: c.z * k } };
}

export interface FaceMeasure {
  kind: Face["geom"]["kind"];
  area: number;
  radius?: number;
}

export function faceMeasure(body: Body, face: Face): FaceMeasure {
  const out: FaceMeasure = { kind: face.geom.kind, area: faceArea(body, face.id) };
  if (face.geom.kind === "cylinder") out.radius = face.geom.radius;
  return out;
}
