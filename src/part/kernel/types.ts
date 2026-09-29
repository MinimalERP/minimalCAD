/**
 * MinimalCAD Web
 * part/kernel/types.ts
 *
 * Output of MinimalCAD's own geometry engine. Two views of one solid:
 *
 *  - a render MESH (flat triangle soup, per-vertex normals, a faceId per
 *    triangle) -- for the GPU only;
 *  - ANALYTIC faces and edges (exact planes/cylinders, lines/circles) --
 *    the source of truth for picking, measurement and projected drawings,
 *    so dimensional accuracy never depends on tessellation density.
 *
 * Faces/edges carry a stable `ref` ({feature, role, index}) so later
 * features and drawing dimensions can refer to them across rebuilds.
 */

import type { Vec3 } from "../vec3";

export interface TopoRef {
  feature: string;
  /** "start" / "end" cap, or "side" wall. */
  role: "start" | "end" | "side";
  /** Region index + loop index + segment index, e.g. "0.1.3". */
  index: string;
}

export type FaceGeom =
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  | { kind: "cylinder"; axisOrigin: Vec3; axis: Vec3; radius: number }
  /** Right circular cone: radius grows by tan(halfAngle) per unit along `axis` from `apex`. */
  | { kind: "cone"; apex: Vec3; axis: Vec3; halfAngle: number }
  | { kind: "freeform" };

export interface Face {
  id: number;
  ref: TopoRef;
  geom: FaceGeom;
  /** Refs of other faces merged into this one (same surface after a
   *  boolean) -- a feature that stored any of them still finds this face. */
  aliases?: TopoRef[];
}

export function sameRef(a: TopoRef, b: TopoRef): boolean {
  return a.feature === b.feature && a.role === b.role && a.index === b.index;
}

/** True if `face` is the face `ref` names (its own ref or a merged one). */
export function faceHasRef(face: Face, ref: TopoRef): boolean {
  return sameRef(face.ref, ref) || (face.aliases?.some((a) => sameRef(a, ref)) ?? false);
}

export type EdgeGeom =
  | { kind: "line"; a: Vec3; b: Vec3 }
  /** Circular arc: center, unit normal (right-hand sweep axis), radius, start point, signed sweep. */
  | { kind: "arc"; center: Vec3; normal: Vec3; radius: number; start: Vec3; sweep: number }
  | { kind: "polyline"; pts: Vec3[] };

export interface Edge {
  ref: TopoRef;
  geom: EdgeGeom;
}

export interface Mesh {
  /** Double precision: this is kernel geometry (booleans, drawings); the
   *  renderer converts to float32 itself. */
  positions: Float64Array; // xyz per vertex
  normals: Float64Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle
  faceIds: Uint32Array; // 1 per triangle
}

export interface Body {
  id: string;
  /** Feature that created this body. */
  feature: string;
  mesh: Mesh;
  faces: Face[];
  edges: Edge[];
}
