/**
 * MinimalCAD Web
 * part/kernel/revolve.ts
 *
 * Solids of revolution (our own): a profile polyline in (r, z) -- distance
 * from the axis, and position along it -- spun a full turn about an axis.
 * Every profile segment becomes one exact face:
 *
 *   r constant  -> cylinder      z constant -> plane (disc / annulus)
 *   otherwise   -> cone
 *
 * and every profile vertex off the axis becomes an exact circle edge. Used
 * by the Hole feature (drill, counterbore, countersink) and, later, Revolve.
 */

import type { Body, Edge, Face, FaceGeom, TopoRef } from "./types";
import { meshVolume } from "./extrude";
import type { Vec3 } from "../vec3";
import { add, cross, normalize, scale } from "../vec3";

export interface RZ {
  r: number;
  z: number;
}

export interface Axis {
  origin: Vec3;
  /** Unit direction of +z. */
  dir: Vec3;
}

/** Tessellation segments per full turn (display/boolean only; faces stay exact). */
const SEGMENTS = 72;

/** Two unit vectors completing `dir` to a right-handed frame. */
function basis(dir: Vec3): [Vec3, Vec3] {
  const helper = Math.abs(dir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = normalize(cross(helper, dir));
  return [e1, cross(dir, e1)];
}

/**
 * `profile` runs from the axis (r = 0) out and back to the axis (r = 0),
 * e.g. a drill: (0,0) (R,0) (R,D) (0,D+tip). Orientation is fixed up
 * automatically, so either traversal direction works.
 */
export function revolveProfile(feature: string, tag: string, profile: readonly RZ[], axis: Axis): Body {
  const [e1, e2] = basis(axis.dir);
  const at = (p: RZ, t: number): Vec3 =>
    add(add(axis.origin, scale(axis.dir, p.z)), add(scale(e1, p.r * Math.cos(t)), scale(e2, p.r * Math.sin(t))));
  const radial = (t: number): Vec3 => add(scale(e1, Math.cos(t)), scale(e2, Math.sin(t)));

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  const ref = (index: string): TopoRef => ({ feature, role: "side", index: `${tag}.${index}` });
  const vert = (p: Vec3, n: Vec3): number => {
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    return positions.length / 3 - 1;
  };

  for (let s = 0; s + 1 < profile.length; s++) {
    const a = profile[s]!;
    const b = profile[s + 1]!;
    if (a.r === 0 && b.r === 0) continue; // runs along the axis: no surface
    const dr = b.r - a.r;
    const dz = b.z - a.z;
    let geom: FaceGeom;
    if (Math.abs(dr) < 1e-12) {
      geom = { kind: "cylinder", axisOrigin: axis.origin, axis: axis.dir, radius: a.r };
    } else if (Math.abs(dz) < 1e-12) {
      geom = { kind: "plane", origin: add(axis.origin, scale(axis.dir, a.z)), normal: axis.dir }; // normal fixed below
    } else {
      // Cone: apex where the segment's line meets the axis; axis points toward growing r.
      const zApex = a.z - (a.r * dz) / dr;
      const sign = Math.sign(dz / dr);
      geom = {
        kind: "cone",
        apex: add(axis.origin, scale(axis.dir, zApex)),
        axis: scale(axis.dir, sign),
        halfAngle: Math.atan(Math.abs(dr / dz)),
      };
    }
    const faceId = faces.length;
    faces.push({ id: faceId, ref: ref(`${s}`), geom });

    // Profile-plane normal of this segment (either side; orientation fixed later).
    const len = Math.hypot(dr, dz);
    const nr = dz / len;
    const nz = -dr / len;
    for (let k = 0; k < SEGMENTS; k++) {
      const t0 = (2 * Math.PI * k) / SEGMENTS;
      const t1 = (2 * Math.PI * (k + 1)) / SEGMENTS;
      const n0 = normalize(add(scale(radial(t0), nr), scale(axis.dir, nz)));
      const n1 = normalize(add(scale(radial(t1), nr), scale(axis.dir, nz)));
      const a0 = vert(at(a, t0), n0);
      const a1 = vert(at(a, t1), n1);
      const b0 = vert(at(b, t0), n0);
      const b1 = vert(at(b, t1), n1);
      // Skip the collapsed half of the quad at the axis.
      if (a.r > 0) {
        indices.push(a0, a1, b1);
        faceIds.push(faceId);
      }
      if (b.r > 0) {
        indices.push(a0, b1, b0);
        faceIds.push(faceId);
      }
    }
  }

  // Exact rim circles at every off-axis profile vertex.
  profile.forEach((p, i) => {
    if (p.r <= 0) return;
    const center = add(axis.origin, scale(axis.dir, p.z));
    edges.push({ ref: ref(`v${i}`), geom: { kind: "arc", center, normal: axis.dir, radius: p.r, start: add(center, scale(e1, p.r)), sweep: 2 * Math.PI } });
  });

  // Fix orientation: outward normals <=> positive volume.
  if (meshVolume(positions, indices) < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const tmp = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = tmp;
    }
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i]!;
  }
  // Plane faces take their real outward normal from their first triangle.
  for (const face of faces) {
    if (face.geom.kind !== "plane") continue;
    const t = faceIds.indexOf(face.id);
    const n = { x: normals[indices[t * 3]! * 3]!, y: normals[indices[t * 3]! * 3 + 1]!, z: normals[indices[t * 3]! * 3 + 2]! };
    face.geom = { ...face.geom, normal: normalize(n) };
  }

  return {
    id: feature,
    feature,
    mesh: {
      positions: new Float64Array(positions),
      normals: new Float64Array(normals),
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
    },
    faces,
    edges,
  };
}
