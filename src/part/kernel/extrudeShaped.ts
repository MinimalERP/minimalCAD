/**
 * MinimalCAD Web
 * part/kernel/extrudeShaped.ts
 *
 * Extrude with a TAPER (sides slope in or out as they leave the sketch
 * plane) and / or a LEAN (the whole body goes off at an angle instead of
 * square to the plane). The plain, square extrude stays in extrude.ts.
 *
 * The body is built in layers parallel to the sketch plane: the profile at
 * each level is the drawn one, moved in or out by the taper, then slid
 * sideways by the lean. Every level has the same vertices, so the walls are
 * simple bands between levels.
 *
 * Exact faces where they exist: flat sides stay planes; a round side under
 * a taper is a cone; a round side of a leaning body whose SECTION is the
 * drawn shape is a true (slanted) cylinder. Anything else is free-form.
 */

import { triangulate } from "./triangulate";
import type { Point } from "../../core/types";
import type { Frame } from "../plane";
import { localTo3d } from "../plane";
import type { Loop, Region, Segment } from "../profile";
import type { Vec3 } from "../vec3";
import { add, cross, dot, normalize, scale, sub } from "../vec3";
import { isTangent, tangentIn, tangentOut } from "./extrude";
import type { Body, Edge, Face, TopoRef } from "./types";

export interface ExtrudeShape {
  /** tan(taper angle): how far the sides move IN per unit of height away
   *  from the sketch plane (negative = they flare out). */
  tanTaper: number;
  /** Sideways travel per unit of height, plane-local: tan(lean) x the unit
   *  direction it leans toward. */
  shear: Point;
  /** Leaning only. false: the drawn shape is the footprint on the sketch
   *  plane. true: the drawn shape is the body's cross-section square to its
   *  own direction (a drawn circle gives a truly round boss); the footprint
   *  is that shape stretched along the lean, about each region's centre. */
  square: boolean;
  /** Stop at this plane instead of at h1: the body runs from the sketch
   *  plane to it (whichever side it is on), its end lying in the plane even
   *  when that is sloped. Straight sides only (no taper / lean). */
  upTo?: { origin: Vec3; normal: Vec3 };
}

const TOO_STEEP = "The taper is too steep for this shape - its sides meet before the end";

/** Unit normal to the right of travel `t`: out of the material for a CCW
 *  outer loop / CW hole. */
function rightOf(t: Point): Point {
  const l = Math.hypot(t.x, t.y) || 1;
  return { x: t.y / l, y: -t.x / l };
}

/** What a segment becomes when moved `o` out of the material: a line
 *  (through `p` along `d`) or a circle. */
type Offset = { kind: "line"; p: Point; d: Point } | { kind: "circle"; c: Point; r: number };

function offsetEntity(seg: Segment, at: Point, tangent: Point, o: number): Offset | null {
  if (seg.kind === "arc") {
    const r = seg.r + Math.sign(seg.sweep) * o;
    return r > 0 ? { kind: "circle", c: seg.c, r } : null;
  }
  const n = rightOf(tangent);
  return { kind: "line", p: { x: at.x + n.x * o, y: at.y + n.y * o }, d: tangent };
}

/** Where two offset segments meet, nearest to `near` (their old corner). */
function meet(a: Offset, b: Offset, near: Point): Point | null {
  const pick = (pts: Point[]): Point | null =>
    pts.length === 0 ? null : pts.reduce((best, p) => (Math.hypot(p.x - near.x, p.y - near.y) < Math.hypot(best.x - near.x, best.y - near.y) ? p : best));
  if (a.kind === "line" && b.kind === "line") {
    const den = a.d.x * b.d.y - a.d.y * b.d.x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
    return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
  }
  if (a.kind === "circle" && b.kind === "circle") {
    const dx = b.c.x - a.c.x;
    const dy = b.c.y - a.c.y;
    const d = Math.hypot(dx, dy);
    if (d === 0) return null;
    const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h2 = a.r * a.r - x * x;
    if (h2 < 0) return null;
    const h = Math.sqrt(h2);
    const m = { x: a.c.x + (dx * x) / d, y: a.c.y + (dy * x) / d };
    return pick([
      { x: m.x - (dy * h) / d, y: m.y + (dx * h) / d },
      { x: m.x + (dy * h) / d, y: m.y - (dx * h) / d },
    ]);
  }
  const line = a.kind === "line" ? a : (b as Extract<Offset, { kind: "line" }>);
  const circ = a.kind === "circle" ? a : (b as Extract<Offset, { kind: "circle" }>);
  const l = Math.hypot(line.d.x, line.d.y) || 1;
  const d = { x: line.d.x / l, y: line.d.y / l };
  const f = { x: line.p.x - circ.c.x, y: line.p.y - circ.c.y };
  const bq = f.x * d.x + f.y * d.y;
  const disc = bq * bq - (f.x * f.x + f.y * f.y - circ.r * circ.r);
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return pick([-bq - s, -bq + s].map((t) => ({ x: line.p.x + d.x * t, y: line.p.y + d.y * t })));
}

/** Travel direction at polygon vertex `j` of segment `si` (drawn shape). */
function tangentAt(loop: Loop, si: number, j: number): Point {
  const seg = loop.segments[si]!;
  const p = loop.polygon[j]!;
  if (seg.kind === "line") return { x: seg.b.x - seg.a.x, y: seg.b.y - seg.a.y };
  if (seg.kind === "arc") {
    const s = Math.sign(seg.sweep);
    return { x: -(p.y - seg.c.y) * s, y: (p.x - seg.c.x) * s };
  }
  const k = j - loop.segmentStart[si]!;
  const a = seg.pts[Math.max(0, k - 1)]!;
  const b = seg.pts[Math.min(seg.pts.length - 1, k + 1)]!;
  return { x: b.x - a.x, y: b.y - a.y };
}

/** The loop's outline moved `o` out of the material (negative = into it),
 *  vertex for vertex; null if the shape can't shrink / grow that far. */
function offsetLoop(loop: Loop, o: number): Point[] | null {
  const n = loop.polygon.length;
  if (o === 0) return loop.polygon.slice();
  const out: Point[] = new Array<Point>(n);
  const count = loop.segments.length;
  for (let si = 0; si < count; si++) {
    const seg = loop.segments[si]!;
    const first = loop.segmentStart[si]!;
    const last = si + 1 < count ? loop.segmentStart[si + 1]! : n;
    if (seg.kind === "arc" && !(seg.r + Math.sign(seg.sweep) * o > 0)) return null;
    for (let j = first; j < last; j++) {
      const p = loop.polygon[j]!;
      if (j > first) {
        // Inside a segment: straight out along its own normal.
        const nrm = rightOf(tangentAt(loop, si, j));
        out[j] = { x: p.x + nrm.x * o, y: p.y + nrm.y * o };
        continue;
      }
      // A segment's start: the corner it shares with the one before.
      const prev = loop.segments[(si + count - 1) % count]!;
      const tIn = tangentIn(prev);
      const tOut = tangentOut(seg);
      if (isTangent(tIn, tOut)) {
        const nrm = rightOf(tOut);
        out[j] = { x: p.x + nrm.x * o, y: p.y + nrm.y * o };
        continue;
      }
      const a = offsetEntity(prev, p, tIn, o);
      const b = offsetEntity(seg, p, tOut, o);
      const q = a === null || b === null ? null : meet(a, b, p);
      if (q === null) return null;
      out[j] = q;
    }
  }
  // Every side must still run the way it did: none squeezed to nothing and
  // turned round.
  for (let j = 0; j < n; j++) {
    const a = loop.polygon[j]!;
    const b = loop.polygon[(j + 1) % n]!;
    const c = out[j]!;
    const d = out[(j + 1) % n]!;
    if ((b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y) <= 0 && Math.hypot(b.x - a.x, b.y - a.y) > 0) return null;
  }
  return out;
}

function centroid(poly: readonly Point[]): Point {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const w = p.x * q.y - q.x * p.y;
    a += w;
    cx += (p.x + q.x) * w;
    cy += (p.y + q.y) * w;
  }
  return a === 0 ? poly[0]! : { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * Extrudes `regions` from height h0 to h1 (h0 < h1) with `shape`'s taper
 * and lean. Returns the body, or why it can't be made.
 */
export function extrudeShaped(featureId: string, regions: readonly Region[], frame: Frame, h0: number, h1: number, shape: ExtrudeShape): Body | string {
  const { tanTaper, shear } = shape;
  const leaning = shear.x !== 0 || shear.y !== 0;
  const square = shape.square && leaning;
  // A taper narrows away from the sketch plane both ways: a level there too.
  const levels = tanTaper !== 0 && h0 < 0 && h1 > 0 ? [h0, 0, h1] : [h0, h1];
  const offsetAt = (h: number): number => -Math.abs(h) * tanTaper;

  // Section mode: the drawn shape is stretched along the lean by 1 / cos(lean).
  const tanLean = Math.hypot(shear.x, shear.y);
  const dir = leaning ? { x: shear.x / tanLean, y: shear.y / tanLean } : { x: 1, y: 0 };
  const stretch = square ? Math.sqrt(1 + tanLean * tanLean) - 1 : 0;
  const stretched = (p: Point, about: Point): Point => {
    const along = (p.x - about.x) * dir.x + (p.y - about.y) * dir.y;
    return { x: p.x + dir.x * along * stretch, y: p.y + dir.y * along * stretch };
  };
  const stretchedDir = (t: Point): Point => {
    const along = t.x * dir.x + t.y * dir.y;
    return { x: t.x + dir.x * along * stretch, y: t.y + dir.y * along * stretch };
  };
  const sweep3 = normalize(add(add(scale(frame.u, shear.x), scale(frame.v, shear.y)), frame.n));

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
  const negN = scale(frame.n, -1);
  const top = levels.length - 1;

  // Up to a plane: one end of the body is the sketch plane, the other lies
  // in that plane -- a different height under every point if it slopes.
  let heightAt = (L: number, _p: Point): number => levels[L]!;
  let capNormals: [Vec3, Vec3] = [negN, frame.n];
  let slopedLevel = -1;
  if (shape.upTo !== undefined) {
    const upTo = shape.upTo;
    const nP = normalize(upTo.normal);
    const den = dot(frame.n, nP);
    if (Math.abs(den) < 1e-6) return "That face is square to the sketch - the extrusion would never reach it";
    const planeHeight = (p: Point): number => dot(sub(upTo.origin, localTo3d(frame, p, 0)), nP) / den;
    let lo = Infinity;
    let hi = -Infinity;
    let size = 1;
    for (const region of regions) {
      for (const loop of [region.outer, ...region.holes]) {
        for (const p of loop.polygon) {
          const h = planeHeight(p);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
          size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
        }
      }
    }
    const tol = size * 1e-9;
    if (hi <= tol && lo >= -tol) return "The shape already lies on that face - there is nothing between them";
    if (lo < tol && hi > -tol) return "That face cuts across the sketch plane under the shape - pick a face wholly on one side";
    const up = lo > 0;
    const planeLevel = up ? 1 : 0;
    heightAt = (L, p) => (L === planeLevel ? planeHeight(p) : 0);
    const away = scale(nP, Math.sign(den) * (up ? 1 : -1)); // out of the body, on the plane
    capNormals = up ? [negN, away] : [away, frame.n];
    if (Math.abs(Math.abs(den) - 1) > 1e-9) slopedLevel = planeLevel;
  }

  for (const [ri, region] of regions.entries()) {
    const loops: Loop[] = [region.outer, ...region.holes];
    const about = centroid(region.outer.polygon);
    /** A drawn-shape point at `h`, in 3D. */
    const place = (p: Point, h: number): Vec3 => {
      const q = stretched(p, about);
      return localTo3d(frame, { x: q.x + shear.x * h, y: q.y + shear.y * h }, h);
    };
    // pts[level][loop][vertex]
    const pts: Vec3[][][] = [];
    for (const [L, h] of levels.entries()) {
      const perLoop: Vec3[][] = [];
      for (const loop of loops) {
        const moved = offsetLoop(loop, offsetAt(h));
        if (moved === null) return TOO_STEEP;
        perLoop.push(moved.map((p) => place(p, heightAt(L, p))));
      }
      pts.push(perLoop);
    }

    // --- Caps: the drawn shape's triangles, on the first and last levels. ---
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
    const startFace = addFace(ref("start", `${ri}`), { kind: "plane", origin: pts[0]![0]![0]!, normal: capNormals[0] });
    const endFace = addFace(ref("end", `${ri}`), { kind: "plane", origin: pts[top]![0]![0]!, normal: capNormals[1] });
    const bottom = loops.flatMap((_, li) => pts[0]![li]!.map((p) => vertex(p, capNormals[0])));
    const upper = loops.flatMap((_, li) => pts[top]![li]!.map((p) => vertex(p, capNormals[1])));
    for (let i = 0; i < tris.length; i += 3) {
      let a = tris[i]!;
      let b = tris[i + 1]!;
      const c = tris[i + 2]!;
      const pa = pts2d[a]!;
      const pb = pts2d[b]!;
      const pc = pts2d[c]!;
      if ((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) < 0) [a, b] = [b, a];
      tri(upper[a]!, upper[b]!, upper[c]!, endFace);
      tri(bottom[b]!, bottom[a]!, bottom[c]!, startFace);
    }

    // --- Walls and edges ---
    for (const [li, loop] of loops.entries()) {
      const n = loop.polygon.length;
      const count = loop.segments.length;
      for (const [si, seg] of loop.segments.entries()) {
        const idx = `${ri}.${li}.${si}`;
        const first = loop.segmentStart[si]!;
        const last = si + 1 < count ? loop.segmentStart[si + 1]! : n;
        const js: number[] = [];
        for (let k = first; k <= last; k++) js.push(k % n);
        const tangents = js.map((j, k) => {
          // The closing sample belongs to the next segment's start: this one's end tangent.
          const t = k === js.length - 1 && js.length > 1 ? tangentIn(seg) : tangentAt(loop, si, j);
          const s = stretchedDir(t);
          return add(scale(frame.u, s.x), scale(frame.v, s.y));
        });
        const prev = loop.segments[(si + count - 1) % count]!;
        const corner = !isTangent(tangentIn(prev), tangentOut(seg));

        // Edges across the body at each level (the caps' rims; a taper both ways creases in the middle).
        levels.forEach((h, L) => {
          const role: TopoRef["role"] = L === 0 ? "start" : L === top ? "end" : "side";
          const at = pts[L]![li]!;
          let geom: Edge["geom"];
          if (seg.kind === "line") geom = { kind: "line", a: at[js[0]!]!, b: at[js[js.length - 1]!]! };
          else if (seg.kind === "arc" && !square && L !== slopedLevel) {
            geom = { kind: "arc", center: place(seg.c, heightAt(L, seg.c)), normal: frame.n, radius: seg.r + Math.sign(seg.sweep) * offsetAt(h), start: at[js[0]!]!, sweep: seg.sweep };
          } else geom = { kind: "polyline", pts: js.map((j) => at[j]!) };
          edges.push({ ref: ref(role, role === "side" ? `${idx}.m` : idx), geom });
        });

        for (let L = 0; L < top; L++) {
          const tag = L === 0 ? idx : `${idx}.b`;
          const lo = pts[L]![li]!;
          const hi = pts[L + 1]![li]!;
          const hLo = levels[L]!;
          const hHi = levels[L + 1]!;
          const normalAt = (k: number): Vec3 => normalize(cross(tangents[k]!, sub(hi[js[k]!]!, lo[js[k]!]!)));

          let geom: Face["geom"];
          if (seg.kind === "line") geom = { kind: "plane", origin: lo[js[0]!]!, normal: normalAt(0) };
          else if (seg.kind === "arc" && !leaning) {
            const s = Math.sign(seg.sweep);
            const rLo = seg.r + s * offsetAt(hLo);
            const rHi = seg.r + s * offsetAt(hHi);
            if (Math.abs(rHi - rLo) < 1e-12) geom = { kind: "cylinder", axisOrigin: localTo3d(frame, seg.c, hLo), axis: frame.n, radius: rLo };
            else {
              // Cone: apex where the radius runs out; axis toward the wider end.
              const slope = (rHi - rLo) / (hHi - hLo);
              geom = { kind: "cone", apex: localTo3d(frame, seg.c, hLo - rLo / slope), axis: scale(frame.n, Math.sign(slope)), halfAngle: Math.atan(Math.abs(slope)) };
            }
          } else if (seg.kind === "arc" && square && tanTaper === 0) {
            // The drawn circle is the section square to the lean: a true slanted cylinder.
            geom = { kind: "cylinder", axisOrigin: place(seg.c, 0), axis: sweep3, radius: seg.r };
          } else geom = { kind: "freeform" };

          const face = addFace(ref("side", tag), geom);
          const vLo = js.map((j, k) => vertex(lo[j]!, normalAt(k)));
          const vHi = js.map((j, k) => vertex(hi[j]!, normalAt(k)));
          for (let k = 0; k + 1 < js.length; k++) {
            tri(vLo[k]!, vLo[k + 1]!, vHi[k + 1]!, face);
            tri(vLo[k]!, vHi[k + 1]!, vHi[k]!, face);
          }
          if (corner) edges.push({ ref: ref("side", `${tag}.v`), geom: { kind: "line", a: lo[first]!, b: hi[first]! } });
        }
      }
    }
  }

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
