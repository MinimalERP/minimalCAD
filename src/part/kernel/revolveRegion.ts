/**
 * MinimalCAD Web
 * part/kernel/revolveRegion.ts
 *
 * Revolves sketch regions (part/profile.ts) about an axis lying in their
 * plane, through a full turn or an angle, into a closed, outward-wound
 * triangle mesh plus exact analytic faces/edges. Every profile segment
 * becomes one exact face:
 *
 *   line parallel to the axis -> cylinder     line square to it -> plane
 *   any other line            -> cone         arc -> torus (a sphere when
 *   curve                     -> freeform            centred on the axis)
 *
 * The profile may touch the axis but must not cross it. A partial turn is
 * closed by two flat caps (the profile itself, at each end angle).
 */

import { triangulate } from "./triangulate";
import type { Point } from "../../core/types";
import type { Frame } from "../plane";
import { localTo3d } from "../plane";
import type { Loop, Region, Segment } from "../profile";
import { segStart } from "../profile";
import type { Vec3 } from "../vec3";
import { add, normalize, scale } from "../vec3";
import { isTangent, tangentIn, tangentOut } from "./extrude";
import type { Body, Edge, Face, TopoRef } from "./types";

/** Tessellation segments per full turn (display/boolean only; faces stay exact). */
const SEGMENTS = 72;

/** The axis as two points on it, plane-local (Y-up). */
export interface AxisLine {
  a: Point;
  b: Point;
}

/**
 * Revolves `regions` from angle t0 to t1 (radians, t0 < t1) about `axis`.
 * Angle 0 is the sketch plane itself; positive turns the profile toward the
 * plane's +normal. A sweep of 2*PI or more is a full turn. Returns the body,
 * or a message saying why the profile can't be revolved about that axis.
 */
export function revolveRegions(featureId: string, regions: readonly Region[], frame: Frame, axis: AxisLine, t0: number, t1: number): Body | string {
  const len = Math.hypot(axis.b.x - axis.a.x, axis.b.y - axis.a.y);
  if (!(len > 0)) return "The axis has no length";
  let d = { x: (axis.b.x - axis.a.x) / len, y: (axis.b.y - axis.a.y) / len };

  // Which side of the axis the profile is on (signed distance, d rotated +90).
  let lo = Infinity;
  let hi = -Infinity;
  let extent = 1;
  for (const region of regions) {
    for (const loop of [region.outer, ...region.holes]) {
      for (const p of loop.polygon) {
        const s = -(p.x - axis.a.x) * d.y + (p.y - axis.a.y) * d.x;
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
        extent = Math.max(extent, Math.abs(p.x - axis.a.x), Math.abs(p.y - axis.a.y));
      }
    }
  }
  const tol = extent * 1e-9;
  if (lo < -tol && hi > tol) return "The profile crosses the axis - it must lie on one side of it";
  if (hi <= tol && lo >= -tol) return "The profile lies on the axis";
  // Profile on the negative side: turn the axis round (a rotation, so loop
  // orientation is unchanged) to make every radius positive.
  if (hi <= tol) d = { x: -d.x, y: -d.y };
  const perp = { x: -d.y, y: d.x };

  // 3D frame of the revolution: D along the axis, E1 toward the profile,
  // and D x E1 = frame.n -- so turning E1 toward n is right-handed about D.
  const D = add(scale(frame.u, d.x), scale(frame.v, d.y));
  const E1 = add(scale(frame.u, perp.x), scale(frame.v, perp.y));
  const N = frame.n;
  const A3 = localTo3d(frame, axis.a);
  /** Plane-local point -> (z along the axis, r from it); `snap` puts points
   *  within tolerance of the axis exactly on it. */
  const zr = (p: Point, snap = true): { z: number; r: number } => {
    const z = (p.x - axis.a.x) * d.x + (p.y - axis.a.y) * d.y;
    const r = (p.x - axis.a.x) * perp.x + (p.y - axis.a.y) * perp.y;
    return { z, r: snap && Math.abs(r) <= tol ? 0 : r };
  };
  const radial = (t: number): Vec3 => add(scale(E1, Math.cos(t)), scale(N, Math.sin(t)));
  const along = (t: number): Vec3 => add(scale(E1, -Math.sin(t)), scale(N, Math.cos(t))); // direction of growing t
  const at = (q: { z: number; r: number }, t: number): Vec3 => add(add(A3, scale(D, q.z)), scale(radial(t), q.r));

  const full = t1 - t0 >= 2 * Math.PI - 1e-9;
  const sweep = full ? 2 * Math.PI : t1 - t0;
  if (!(sweep > 0)) return "The angle must be more than 0";
  const K = Math.max(full ? 3 : 1, Math.ceil((SEGMENTS * sweep) / (2 * Math.PI)));
  const angles: number[] = [];
  for (let k = 0; k <= K; k++) angles.push(full && k === K ? t0 : t0 + (sweep * k) / K);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  const ref = (role: TopoRef["role"], index: string): TopoRef => ({ feature: featureId, role, index });
  const addFace = (r: TopoRef, geom: Face["geom"]): number => {
    faces.push({ id: faces.length, ref: r, geom });
    return faces.length - 1;
  };
  const vertex = (p: Vec3, n: Vec3): number => {
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    return positions.length / 3 - 1;
  };
  const tri = (a: number, b: number, c: number, face: number): void => {
    indices.push(a, b, c);
    faceIds.push(face);
  };

  /** A segment at angle t, as an exact edge (the rim of a cap). */
  const capEdge = (s: Segment, t: number): Edge["geom"] => {
    if (s.kind === "line") return { kind: "line", a: at(zr(s.a), t), b: at(zr(s.b), t) };
    if (s.kind === "arc") {
      return { kind: "arc", center: at(zr(s.c, false), t), normal: along(t), radius: s.r, start: at(zr(segStart(s)), t), sweep: s.sweep };
    }
    return { kind: "polyline", pts: s.pts.map((p) => at(zr(p), t)) };
  };

  regions.forEach((region, ri) => {
    const loops: Loop[] = [region.outer, ...region.holes];

    // --- Caps (partial turn only): the profile itself at each end angle. ---
    if (!full) {
      const flat: number[] = [];
      const holeIdx: number[] = [];
      const pts2d: Point[] = [];
      for (const [li, loop] of loops.entries()) {
        if (li > 0) holeIdx.push(pts2d.length);
        for (const p of loop.polygon) {
          flat.push(p.x, p.y);
          pts2d.push(p);
        }
      }
      const tris = triangulate(flat, holeIdx);
      const nEnd = along(t1);
      const nStart = scale(along(t0), -1);
      const startFace = addFace(ref("start", `${ri}`), { kind: "plane", origin: A3, normal: nStart });
      const endFace = addFace(ref("end", `${ri}`), { kind: "plane", origin: A3, normal: nEnd });
      const q = pts2d.map((p) => zr(p));
      const start = q.map((p) => vertex(at(p, t0), nStart));
      const end = q.map((p) => vertex(at(p, t1), nEnd));
      for (let i = 0; i < tris.length; i += 3) {
        let a = tris[i]!;
        let b = tris[i + 1]!;
        const c = tris[i + 2]!;
        const pa = pts2d[a]!;
        const pb = pts2d[b]!;
        const pc = pts2d[c]!;
        if ((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) < 0) [a, b] = [b, a];
        tri(end[a]!, end[b]!, end[c]!, endFace); // CCW in the profile plane = facing +along
        tri(start[b]!, start[a]!, start[c]!, startFace);
      }
    }

    // --- Swept faces, edges ---
    loops.forEach((loop, li) => {
      const n = loop.polygon.length;
      loop.segments.forEach((seg, si) => {
        const idx = `${ri}.${li}.${si}`;
        const first = loop.segmentStart[si]!;
        const last = si + 1 < loop.segments.length ? loop.segmentStart[si + 1]! : n;
        const samples: { z: number; r: number }[] = [];
        for (let k = first; k <= last; k++) samples.push(zr(loop.polygon[k % n]!));
        const onAxis = samples.every((p) => p.r === 0);

        if (!full) {
          edges.push({ ref: ref("start", idx), geom: capEdge(seg, t0) });
          if (!onAxis) edges.push({ ref: ref("end", idx), geom: capEdge(seg, t1) });
        }
        // A corner off the axis sweeps a circle edge.
        const corner = samples[0]!;
        const prev = loop.segments[(si + loop.segments.length - 1) % loop.segments.length]!;
        if (corner.r > 0 && !isTangent(tangentIn(prev), tangentOut(seg))) {
          edges.push({
            ref: ref("side", `${idx}.v`),
            geom: { kind: "arc", center: add(A3, scale(D, corner.z)), normal: D, radius: corner.r, start: at(corner, t0), sweep },
          });
        }
        if (onAxis) return; // runs along the axis: no surface

        // Outward normal in (z, r), per sample: to the right of travel (the
        // loop is CCW round material; a hole CW).
        const right = (tz: number, tr: number): { z: number; r: number } => {
          const l = Math.hypot(tz, tr) || 1;
          return { z: tr / l, r: -tz / l };
        };
        const a = samples[0]!;
        const b = samples[samples.length - 1]!;
        let geom: Face["geom"];
        let normalsAt: { z: number; r: number }[];
        if (seg.kind === "line") {
          const dz = b.z - a.z;
          const dr = b.r - a.r;
          const nrm = right(dz, dr);
          normalsAt = samples.map(() => nrm);
          const scaleTol = tol * 1e3;
          if (Math.abs(dr) <= scaleTol) geom = { kind: "cylinder", axisOrigin: A3, axis: D, radius: a.r };
          else if (Math.abs(dz) <= scaleTol) geom = { kind: "plane", origin: add(A3, scale(D, a.z)), normal: scale(D, Math.sign(nrm.z) || 1) };
          else {
            // Cone: apex where the segment's line meets the axis; axis toward growing r.
            geom = {
              kind: "cone",
              apex: add(A3, scale(D, a.z - (a.r * dz) / dr)),
              axis: scale(D, Math.sign(dz / dr)),
              halfAngle: Math.atan(Math.abs(dr / dz)),
            };
          }
        } else if (seg.kind === "arc") {
          const c = zr(seg.c, false);
          // A sphere is the torus whose tube centre sits on the axis (major 0).
          geom = { kind: "torus", center: add(A3, scale(D, c.z)), axis: D, major: Math.abs(c.r) <= tol ? 0 : c.r, minor: seg.r };
          const sign = seg.sweep > 0 ? 1 : -1; // CCW arc: material inside, normal away from the centre
          normalsAt = samples.map((p) => {
            const l = Math.hypot(p.z - c.z, p.r - c.r) || 1;
            return { z: (sign * (p.z - c.z)) / l, r: (sign * (p.r - c.r)) / l };
          });
        } else {
          geom = { kind: "freeform" };
          normalsAt = samples.map((_, k) => {
            const p = samples[Math.max(0, k - 1)]!;
            const q = samples[Math.min(samples.length - 1, k + 1)]!;
            return right(q.z - p.z, q.r - p.r);
          });
        }
        const face = addFace(ref("side", idx), geom);

        // One ring of vertices per angle; a full turn closes onto ring 0.
        const rings: number[][] = [];
        for (let k = 0; k <= K; k++) {
          if (full && k === K) {
            rings.push(rings[0]!);
            break;
          }
          const t = angles[k]!;
          const R = radial(t);
          rings.push(samples.map((p, j) => vertex(at(p, t), normalize(add(scale(D, normalsAt[j]!.z), scale(R, normalsAt[j]!.r))))));
        }
        for (let k = 0; k < K; k++) {
          for (let j = 0; j + 1 < samples.length; j++) {
            const a0 = rings[k]![j]!;
            const a1 = rings[k + 1]![j]!;
            const b0 = rings[k]![j + 1]!;
            const b1 = rings[k + 1]![j + 1]!;
            // The half of the quad that collapses on the axis is skipped.
            if (samples[j]!.r > 0) tri(a0, b0, a1, face);
            if (samples[j + 1]!.r > 0) tri(b0, b1, a1, face);
          }
        }
      });
    });
  });

  return {
    id: featureId,
    feature: featureId,
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
