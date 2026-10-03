/**
 * MinimalCAD Web
 * part/measure.ts
 *
 * 3D Measure (read-only): the angle between two flat faces or two straight
 * edges, the distance between two points, an edge's length / radius, a
 * face's area. Analytic geometry wherever the kernel has it (planes,
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
