/**
 * MinimalCAD Web
 * part/kernel/extrude.ts
 *
 * Extrudes sketch regions (part/profile.ts) along their plane normal into a
 * closed, outward-wound triangle mesh plus exact analytic faces/edges.
 */

import { triangulate } from "./triangulate";
import type { Point } from "../../core/types";
import type { Frame } from "../plane";
import { localTo3d } from "../plane";
import type { Loop, Region, Segment } from "../profile";
import { segStart } from "../profile";
import type { Vec3 } from "../vec3";
import { add, normalize, scale } from "../vec3";
import type { Body, Edge, Face, TopoRef } from "./types";

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  faceIds: number[] = [];

  vertex(p: Vec3, n: Vec3): number {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    return this.positions.length / 3 - 1;
  }

  tri(a: number, b: number, c: number, face: number): void {
    this.indices.push(a, b, c);
    this.faceIds.push(face);
  }
}

function tangentOut(s: Segment): Point {
  if (s.kind === "line") return { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
  if (s.kind === "arc") {
    const d = Math.sign(s.sweep);
    return { x: -Math.sin(s.a0) * d, y: Math.cos(s.a0) * d };
  }
  return { x: s.pts[1]!.x - s.pts[0]!.x, y: s.pts[1]!.y - s.pts[0]!.y };
}

function tangentIn(s: Segment): Point {
  if (s.kind === "line") return { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
  if (s.kind === "arc") {
    const a = s.a0 + s.sweep;
    const d = Math.sign(s.sweep);
    return { x: -Math.sin(a) * d, y: Math.cos(a) * d };
  }
  const n = s.pts.length;
  return { x: s.pts[n - 1]!.x - s.pts[n - 2]!.x, y: s.pts[n - 1]!.y - s.pts[n - 2]!.y };
}

function isTangent(a: Point, b: Point): boolean {
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la === 0 || lb === 0) return true;
  const crossZ = (a.x * b.y - a.y * b.x) / (la * lb);
  const dotAB = (a.x * b.x + a.y * b.y) / (la * lb);
  return Math.abs(crossZ) < 1e-6 && dotAB > 0;
}

/** In-plane outward wall direction for travel direction t, as 3D. For a CCW
 *  outer loop / CW hole this points out of the material (t x n). */
function outward(frame: Frame, t: Point): Vec3 {
  return normalize(add(scale(frame.u, t.y), scale(frame.v, -t.x)));
}

function to3dEdge(frame: Frame, s: Segment, h: number): Edge["geom"] {
  if (s.kind === "line") return { kind: "line", a: localTo3d(frame, s.a, h), b: localTo3d(frame, s.b, h) };
  if (s.kind === "arc") {
    return {
      kind: "arc",
      center: localTo3d(frame, s.c, h),
      normal: frame.n,
      radius: s.r,
      start: localTo3d(frame, segStart(s), h),
      sweep: s.sweep,
    };
  }
  return { kind: "polyline", pts: s.pts.map((p) => localTo3d(frame, p, h)) };
}

/**
 * Extrudes `regions` from height h0 to h1 (h0 < h1) along the frame normal.
 * All regions go into one body (one feature = one body in Milestone 1).
 */
export function extrudeRegions(featureId: string, regions: readonly Region[], frame: Frame, h0: number, h1: number): Body {
  const mb = new MeshBuilder();
  const faces: Face[] = [];
  const edges: Edge[] = [];
  const ref = (role: TopoRef["role"], index: string): TopoRef => ({ feature: featureId, role, index });
  const addFace = (r: TopoRef, geom: Face["geom"]): number => {
    faces.push({ id: faces.length, ref: r, geom });
    return faces.length - 1;
  };
  const negN = scale(frame.n, -1);

  regions.forEach((region, ri) => {
    const loops: Loop[] = [region.outer, ...region.holes];

    // --- Caps: triangulate once in 2D, emit at both heights. ---
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
    const startFace = addFace(ref("start", `${ri}`), { kind: "plane", origin: localTo3d(frame, pts2d[0]!, h0), normal: negN });
    const endFace = addFace(ref("end", `${ri}`), { kind: "plane", origin: localTo3d(frame, pts2d[0]!, h1), normal: frame.n });
    const bottom = pts2d.map((p) => mb.vertex(localTo3d(frame, p, h0), negN));
    const top = pts2d.map((p) => mb.vertex(localTo3d(frame, p, h1), frame.n));
    for (let i = 0; i < tris.length; i += 3) {
      let a = tris[i]!;
      let b = tris[i + 1]!;
      const c = tris[i + 2]!;
      const pa = pts2d[a]!;
      const pb = pts2d[b]!;
      const pc = pts2d[c]!;
      if ((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) < 0) [a, b] = [b, a];
      mb.tri(top[a]!, top[b]!, top[c]!, endFace); // CCW seen from +n
      mb.tri(bottom[b]!, bottom[a]!, bottom[c]!, startFace); // CW seen from +n
    }

    // --- Walls, edges ---
    loops.forEach((loop, li) => {
      const n = loop.polygon.length;
      loop.segments.forEach((seg, si) => {
        const idx = `${ri}.${li}.${si}`;
        const first = loop.segmentStart[si]!;
        const last = si + 1 < loop.segments.length ? loop.segmentStart[si + 1]! : n;
        const samples: Point[] = [];
        for (let k = first; k <= last; k++) samples.push(loop.polygon[k % n]!);

        let geom: Face["geom"];
        const normalsAt: Vec3[] = [];
        if (seg.kind === "line") {
          const out = outward(frame, tangentOut(seg));
          geom = { kind: "plane", origin: localTo3d(frame, seg.a, h0), normal: out };
          samples.forEach(() => normalsAt.push(out));
        } else if (seg.kind === "arc") {
          geom = { kind: "cylinder", axisOrigin: localTo3d(frame, seg.c, h0), axis: frame.n, radius: seg.r };
          // Radial normal, flipped when the wall faces the arc's center (a hole, or a concave arc).
          const sign = Math.sign(
            (samples[0]!.x - seg.c.x) * tangentOut(seg).y - (samples[0]!.y - seg.c.y) * tangentOut(seg).x,
          );
          for (const p of samples) {
            normalsAt.push(normalize(scale(add(scale(frame.u, p.x - seg.c.x), scale(frame.v, p.y - seg.c.y)), sign || 1)));
          }
        } else {
          geom = { kind: "freeform" };
          samples.forEach((_, k) => {
            const a = samples[Math.max(0, k - 1)]!;
            const b = samples[Math.min(samples.length - 1, k + 1)]!;
            normalsAt.push(outward(frame, { x: b.x - a.x, y: b.y - a.y }));
          });
        }
        const face = addFace(ref("side", idx), geom);
        const lo = samples.map((p, k) => mb.vertex(localTo3d(frame, p, h0), normalsAt[k]!));
        const hi = samples.map((p, k) => mb.vertex(localTo3d(frame, p, h1), normalsAt[k]!));
        for (let k = 0; k + 1 < samples.length; k++) {
          mb.tri(lo[k]!, lo[k + 1]!, hi[k + 1]!, face);
          mb.tri(lo[k]!, hi[k + 1]!, hi[k]!, face);
        }

        edges.push({ ref: ref("start", idx), geom: to3dEdge(frame, seg, h0) });
        edges.push({ ref: ref("end", idx), geom: to3dEdge(frame, seg, h1) });
        const prev = loop.segments[(si + loop.segments.length - 1) % loop.segments.length]!;
        if (!isTangent(tangentIn(prev), tangentOut(seg))) {
          const p = segStart(seg);
          edges.push({ ref: ref("side", `${idx}.v`), geom: { kind: "line", a: localTo3d(frame, p, h0), b: localTo3d(frame, p, h1) } });
        }
      });
    });
  });

  return {
    id: featureId,
    feature: featureId,
    mesh: {
      positions: new Float32Array(mb.positions),
      normals: new Float32Array(mb.normals),
      indices: new Uint32Array(mb.indices),
      faceIds: new Uint32Array(mb.faceIds),
    },
    faces,
    edges,
  };
}

/** Signed volume of a closed mesh (divergence theorem) -- used by tests and
 *  later by mass properties. */
export function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v = 0;
  const p = (i: number): Vec3 => ({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! });
  for (let i = 0; i < indices.length; i += 3) {
    const a = p(indices[i]!);
    const b = p(indices[i + 1]!);
    const c = p(indices[i + 2]!);
    v += (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
  }
  return v;
}
