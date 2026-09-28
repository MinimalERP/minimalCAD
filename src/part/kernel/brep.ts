/**
 * MinimalCAD Web
 * part/kernel/brep.ts
 *
 * Bridges Body <-> boolean polygons (csg.ts), and turns boolean output back
 * into a proper Body:
 *
 *  1. weld vertices and repair T-junctions (a BSP boolean leaves vertices
 *     lying mid-edge on neighbouring polygons), so the mesh is watertight;
 *  2. unify faces lying on the same surface (same plane / same cylinder),
 *     so e.g. two joined blocks don't show a seam across a shared top;
 *  3. rebuild EXACT edges from face adjacency: plane|plane boundaries become
 *     straight lines, plane|cylinder rims become true circle arcs (exact
 *     center/radius from the cylinder), anything else a polyline;
 *  4. render normals from the analytic faces (smooth cylinders).
 */

import type { Body, Edge, Face, TopoRef } from "./types";
import type { Polygon } from "./csg";
import { makePolygon } from "./csg";
import type { Vec3 } from "../vec3";
import { add, cross, dot, length, normalize, scale, sub } from "../vec3";

/** Body mesh -> polygons (one per triangle), face ids shifted by `faceOffset`. */
export function bodyToPolygons(body: Body, faceOffset: number): Polygon[] {
  const { positions, indices, faceIds } = body.mesh;
  const v = (i: number): Vec3 => ({ x: positions[i * 3]!, y: positions[i * 3 + 1]!, z: positions[i * 3 + 2]! });
  const out: Polygon[] = [];
  for (let t = 0; t < faceIds.length; t++) {
    const p = makePolygon([v(indices[t * 3]!), v(indices[t * 3 + 1]!), v(indices[t * 3 + 2]!)], faceIds[t]! + faceOffset);
    if (p !== null) out.push(p);
  }
  return out;
}

/** Axis-aligned bounds of a body. */
export function bodyBounds(body: Body): { min: Vec3; max: Vec3 } {
  const p = body.mesh.positions;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    min.x = Math.min(min.x, p[i]!);
    min.y = Math.min(min.y, p[i + 1]!);
    min.z = Math.min(min.z, p[i + 2]!);
    max.x = Math.max(max.x, p[i]!);
    max.y = Math.max(max.y, p[i + 1]!);
    max.z = Math.max(max.z, p[i + 2]!);
  }
  return { min, max };
}

export function boundsOverlap(a: Body, b: Body, tol = 1e-9): boolean {
  const A = bodyBounds(a);
  const B = bodyBounds(b);
  return (
    A.min.x <= B.max.x + tol &&
    B.min.x <= A.max.x + tol &&
    A.min.y <= B.max.y + tol &&
    B.min.y <= A.max.y + tol &&
    A.min.z <= B.max.z + tol &&
    B.min.z <= A.max.z + tol
  );
}

// ---------------------------------------------------------------------------

/** Spatial-hash vertex welder. */
class Welder {
  readonly points: Vec3[] = [];
  private cells = new Map<string, number[]>();
  constructor(private tol: number) {}

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  index(p: Vec3): number {
    const s = this.tol * 4;
    const cx = Math.floor(p.x / s);
    const cy = Math.floor(p.y / s);
    const cz = Math.floor(p.z / s);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const i of this.cells.get(this.key(cx + dx, cy + dy, cz + dz)) ?? []) {
            const q = this.points[i]!;
            if (Math.abs(q.x - p.x) <= this.tol && Math.abs(q.y - p.y) <= this.tol && Math.abs(q.z - p.z) <= this.tol) return i;
          }
        }
      }
    }
    this.points.push(p);
    const k = this.key(cx, cy, cz);
    const cell = this.cells.get(k);
    if (cell === undefined) this.cells.set(k, [this.points.length - 1]);
    else cell.push(this.points.length - 1);
    return this.points.length - 1;
  }
}

/** Uniform grid over vertex indices, for "which vertices lie on this segment". */
class VertexGrid {
  private cells = new Map<string, number[]>();
  constructor(
    private points: readonly Vec3[],
    private cell: number,
  ) {
    points.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor(p.z / cell));
      const list = this.cells.get(k);
      if (list === undefined) this.cells.set(k, [i]);
      else list.push(i);
    });
  }
  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }
  near(a: Vec3, b: Vec3): number[] {
    const c = this.cell;
    const out: number[] = [];
    const x0 = Math.floor(Math.min(a.x, b.x) / c);
    const x1 = Math.floor(Math.max(a.x, b.x) / c);
    const y0 = Math.floor(Math.min(a.y, b.y) / c);
    const y1 = Math.floor(Math.max(a.y, b.y) / c);
    const z0 = Math.floor(Math.min(a.z, b.z) / c);
    const z1 = Math.floor(Math.max(a.z, b.z) / c);
    // Long edges could span many cells; fall back to a full scan then.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > this.points.length) return this.points.map((_, i) => i);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) out.push(...(this.cells.get(this.key(x, y, z)) ?? []));
      }
    }
    return out;
  }
}

/** Canonical surface key: faces with equal keys are one surface. */
function surfaceKey(face: Face, tol: number): string | null {
  const r = (v: number): number => Math.round(v / tol);
  const g = face.geom;
  if (g.kind === "plane") {
    const n = normalize(g.normal);
    return `p:${r(n.x * 1e3)},${r(n.y * 1e3)},${r(n.z * 1e3)},${r(dot(n, g.origin))}`;
  }
  if (g.kind === "cylinder") {
    let a = normalize(g.axis);
    if (a.x < -1e-9 || (Math.abs(a.x) <= 1e-9 && (a.y < -1e-9 || (Math.abs(a.y) <= 1e-9 && a.z < 0)))) a = scale(a, -1);
    // Point on the axis closest to the origin.
    const o = sub(g.axisOrigin, scale(a, dot(g.axisOrigin, a)));
    return `c:${r(a.x * 1e3)},${r(a.y * 1e3)},${r(a.z * 1e3)},${r(o.x)},${r(o.y)},${r(o.z)},${r(g.radius)}`;
  }
  if (g.kind === "cone") {
    const a = normalize(g.axis);
    return `k:${r(a.x * 1e3)},${r(a.y * 1e3)},${r(a.z * 1e3)},${r(g.apex.x)},${r(g.apex.y)},${r(g.apex.z)},${r(g.halfAngle * 1e6)}`;
  }
  return null;
}

/**
 * Boolean output -> Body. `faces` is the face table the polygons' faceIds
 * index into (both operands' faces, concatenated).
 */
export function polygonsToBody(id: string, feature: string, polygons: readonly Polygon[], faces: readonly Face[]): Body {
  // Model-size-relative tolerance.
  let size = 1;
  for (const p of polygons) for (const v of p.vertices) size = Math.max(size, Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
  const tol = size * 1e-9 + 1e-9;

  // 1a. Weld.
  const welder = new Welder(tol);
  let polys = polygons
    .map((p) => {
      const idx: number[] = [];
      for (const v of p.vertices) {
        const i = welder.index(v);
        if (idx[idx.length - 1] !== i) idx.push(i);
      }
      while (idx.length > 1 && idx[0] === idx[idx.length - 1]) idx.pop();
      return { idx, normal: p.normal, faceId: p.faceId };
    })
    .filter((p) => p.idx.length >= 3);
  const pts = welder.points;

  // 1b. T-junctions: insert any vertex lying on a polygon edge's interior.
  const grid = new VertexGrid(pts, Math.max(size / 32, tol * 10));
  polys = polys.map((p) => {
    const out: number[] = [];
    for (let k = 0; k < p.idx.length; k++) {
      const ia = p.idx[k]!;
      const ib = p.idx[(k + 1) % p.idx.length]!;
      out.push(ia);
      const a = pts[ia]!;
      const b = pts[ib]!;
      const ab = sub(b, a);
      const len2 = dot(ab, ab);
      if (len2 === 0) continue;
      const onEdge: [number, number][] = [];
      for (const i of grid.near(a, b)) {
        if (i === ia || i === ib) continue;
        const ap = sub(pts[i]!, a);
        const t = dot(ap, ab) / len2;
        if (t <= 1e-12 || t >= 1 - 1e-12) continue;
        const d = sub(ap, scale(ab, t));
        if (dot(d, d) <= tol * tol * 16) onEdge.push([t, i]);
      }
      onEdge.sort((x, y) => x[0] - y[0]);
      for (const [, i] of onEdge) out.push(i);
    }
    return { ...p, idx: out };
  });

  // 1c. Belt and braces: any edge still without a reverse twin gets every
  //     vertex lying on it inserted (full scan, slightly looser tolerance),
  //     until the mesh closes up or nothing changes.
  for (let pass = 0; pass < 3; pass++) {
    const directed = new Set<string>();
    for (const p of polys) for (let k = 0; k < p.idx.length; k++) directed.add(`${p.idx[k]}|${p.idx[(k + 1) % p.idx.length]}`);
    let changed = false;
    const loose2 = (tol * 1e3) ** 2;
    polys = polys.map((p) => {
      const out: number[] = [];
      let touched = false;
      for (let k = 0; k < p.idx.length; k++) {
        const ia = p.idx[k]!;
        const ib = p.idx[(k + 1) % p.idx.length]!;
        out.push(ia);
        if (directed.has(`${ib}|${ia}`)) continue;
        const a = pts[ia]!;
        const ab = sub(pts[ib]!, a);
        const len2 = dot(ab, ab);
        if (len2 === 0) continue;
        const onEdge: [number, number][] = [];
        pts.forEach((q, i) => {
          if (i === ia || i === ib) return;
          const ap = sub(q, a);
          const t = dot(ap, ab) / len2;
          if (t <= 1e-9 || t >= 1 - 1e-9) return;
          const d = sub(ap, scale(ab, t));
          if (dot(d, d) <= loose2) onEdge.push([t, i]);
        });
        if (onEdge.length === 0) continue;
        onEdge.sort((x, y) => x[0] - y[0]);
        for (const [, i] of onEdge) out.push(i);
        touched = true;
      }
      if (touched) changed = true;
      return touched ? { ...p, idx: out } : p;
    });
    if (!changed) break;
  }

  // 2. Unify faces on the same surface; compact to the faces actually used.
  const canonical = new Map<number, number>();
  const byKey = new Map<string, number>();
  for (const p of polys) {
    if (canonical.has(p.faceId)) continue;
    const face = faces[p.faceId]!;
    const key = surfaceKey(face, tol * 1e3);
    // Planes also need matching orientation (normal is in the key already).
    const existing = key === null ? undefined : byKey.get(key);
    if (existing !== undefined) canonical.set(p.faceId, existing);
    else {
      canonical.set(p.faceId, p.faceId);
      if (key !== null) byKey.set(key, p.faceId);
    }
  }
  const newIndex = new Map<number, number>();
  const outFaces: Face[] = [];
  for (const p of polys) {
    const src = canonical.get(p.faceId)!;
    if (newIndex.has(src)) continue;
    newIndex.set(src, outFaces.length);
    const f = faces[src]!;
    // A plane face's stored normal may be a cut tool's (pointing into the
    // result): re-derive it from the actual output polygon.
    const geom: Face["geom"] =
      f.geom.kind === "plane" ? { kind: "plane", origin: pts[p.idx[0]!]!, normal: p.normal } : f.geom;
    outFaces.push({ id: outFaces.length, ref: f.ref, geom });
  }
  const faceOf = (p: { faceId: number }): number => newIndex.get(canonical.get(p.faceId)!)!;

  // 3. Render mesh (fan triangulation; per-face analytic normals).
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  for (const p of polys) {
    const fid = faceOf(p);
    const g = outFaces[fid]!.geom;
    const base = positions.length / 3;
    for (const i of p.idx) {
      const v = pts[i]!;
      positions.push(v.x, v.y, v.z);
      let n = p.normal;
      if (g.kind === "cylinder") {
        const a = normalize(g.axis);
        const d = sub(v, g.axisOrigin);
        const radial = normalize(sub(d, scale(a, dot(d, a))));
        n = dot(radial, p.normal) >= 0 ? radial : scale(radial, -1);
      }
      normals.push(n.x, n.y, n.z);
    }
    for (let k = 1; k + 1 < p.idx.length; k++) {
      indices.push(base, base + k, base + k + 1);
      faceIds.push(fid);
    }
  }

  // 4. Exact edges from face adjacency.
  const edgeFace = new Map<string, number>(); // directed "a|b" -> face
  for (const p of polys) {
    const fid = faceOf(p);
    for (let k = 0; k < p.idx.length; k++) edgeFace.set(`${p.idx[k]}|${p.idx[(k + 1) % p.idx.length]}`, fid);
  }
  const segments = new Map<string, [number, number][]>(); // face pair -> undirected segments
  for (const [key, fid] of edgeFace) {
    const [a, b] = key.split("|").map(Number) as [number, number];
    const twin = edgeFace.get(`${b}|${a}`);
    if (twin === fid) continue; // interior to one face
    if (twin !== undefined && twin < fid) continue; // counted from the other side
    const pair = `${fid}|${twin ?? -1}`;
    const list = segments.get(pair);
    if (list === undefined) segments.set(pair, [[a, b]]);
    else list.push([a, b]);
  }

  const edges: Edge[] = [];
  let edgeCount = 0;
  const ref = (): TopoRef => ({ feature, role: "side", index: `e${edgeCount++}` });
  for (const [pair, segs] of segments) {
    const [fa, fb] = pair.split("|").map(Number) as [number, number];
    for (const chain of chainSegments(segs)) {
      const chainPts = chain.map((i) => pts[i]!);
      edges.push(...classifyChain(chainPts, outFaces[fa]!, fb >= 0 ? outFaces[fb]! : undefined, tol, ref));
    }
  }

  return {
    id,
    feature,
    mesh: {
      positions: new Float64Array(positions),
      normals: new Float64Array(normals),
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
    },
    faces: outFaces,
    edges: mergeCircleArcs(edges, tol),
  };
}

/** Undirected segments -> vertex chains (closed chains repeat the first index at the end). */
function chainSegments(segs: readonly [number, number][]): number[][] {
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const l = adj.get(a);
    if (l === undefined) adj.set(a, [b]);
    else l.push(b);
  };
  for (const [a, b] of segs) {
    link(a, b);
    link(b, a);
  }
  const used = new Set<string>();
  const k = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const chains: number[][] = [];
  // Start from chain ends (degree != 2) first, then remaining loops.
  const starts = [...adj.keys()].sort((x, y) => Number(adj.get(x)!.length === 2) - Number(adj.get(y)!.length === 2));
  for (const s of starts) {
    for (const first of adj.get(s)!) {
      if (used.has(k(s, first))) continue;
      const chain = [s];
      let prev = s;
      let cur = first;
      used.add(k(s, first));
      for (;;) {
        chain.push(cur);
        const nexts = adj.get(cur)!;
        if (nexts.length !== 2) break; // junction or end
        const next = nexts[0] === prev ? nexts[1]! : nexts[0]!;
        if (used.has(k(cur, next))) break;
        used.add(k(cur, next));
        prev = cur;
        cur = next;
      }
      chains.push(chain);
    }
  }
  return chains;
}

/** Exact radius of a circle on a cylinder/cone at `center` (on its axis). */
function exactRimRadius(face: Face, center: Vec3): number | null {
  if (face.geom.kind === "cylinder") return face.geom.radius;
  if (face.geom.kind === "cone") {
    const t = dot(sub(center, face.geom.apex), normalize(face.geom.axis));
    return Math.abs(t) * Math.tan(face.geom.halfAngle);
  }
  return null;
}

/** Joins arc pieces of one circle (same centre, axis and radius) that
 *  together make a full turn into a single exact circle edge. */
function mergeCircleArcs(edges: Edge[], tol: number): Edge[] {
  const r = (v: number): number => Math.round(v / (tol * 1e3));
  const groups = new Map<string, Edge[]>();
  const rest: Edge[] = [];
  for (const e of edges) {
    if (e.geom.kind !== "arc") {
      rest.push(e);
      continue;
    }
    const g = e.geom;
    let n = normalize(g.normal);
    if (n.x < -1e-9 || (Math.abs(n.x) <= 1e-9 && (n.y < -1e-9 || (Math.abs(n.y) <= 1e-9 && n.z < 0)))) n = scale(n, -1);
    const key = [g.center.x, g.center.y, g.center.z, n.x * 1e3, n.y * 1e3, n.z * 1e3, g.radius].map(r).join(",");
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }
  for (const list of groups.values()) {
    const total = list.reduce((s, e) => s + (e.geom.kind === "arc" ? Math.abs(e.geom.sweep) : 0), 0);
    if (list.length > 1 && total >= 2 * Math.PI - 1e-3) {
      const first = list[0]!;
      if (first.geom.kind === "arc") rest.push({ ref: first.ref, geom: { ...first.geom, sweep: 2 * Math.PI } });
    } else rest.push(...list);
  }
  return rest;
}

/** Axis line of a cylinder or cone face, or null. */
function revolutionAxis(face: Face): { point: Vec3; dir: Vec3 } | null {
  if (face.geom.kind === "cylinder") return { point: face.geom.axisOrigin, dir: normalize(face.geom.axis) };
  if (face.geom.kind === "cone") return { point: face.geom.apex, dir: normalize(face.geom.axis) };
  return null;
}

function classifyChain(pts: Vec3[], fa: Face, fb: Face | undefined, tol: number, ref: () => TopoRef): Edge[] {
  const closed = pts.length > 2 && length(sub(pts[0]!, pts[pts.length - 1]!)) <= tol * 4;
  const axisA = revolutionAxis(fa);
  const axisB = fb === undefined ? null : revolutionAxis(fb);
  const rev = axisA ?? axisB;
  const other = axisA !== null ? fb : fa;
  const otherAxis = axisA !== null ? axisB : axisA;
  const coaxial = (p: { point: Vec3; dir: Vec3 }, q: { point: Vec3; dir: Vec3 }): boolean =>
    Math.abs(Math.abs(dot(p.dir, q.dir)) - 1) < 1e-6 && length(cross(sub(q.point, p.point), p.dir)) < tol * 1e3;

  // A revolution surface (cylinder/cone) meeting a plane square to its axis,
  // or another coaxial revolution surface: a true circle arc.
  const squarePlane =
    rev !== null && other?.geom.kind === "plane" && Math.abs(Math.abs(dot(normalize(other.geom.normal), rev.dir)) - 1) < 1e-6;
  if (rev !== null && (squarePlane || (otherAxis !== null && coaxial(rev, otherAxis)))) {
    const a = rev.dir;
    const center = add(rev.point, scale(a, dot(sub(pts[0]!, rev.point), a)));
    const radius = length(sub(pts[0]!, center));
    const e1 = normalize(sub(pts[0]!, center));
    const e2 = cross(a, e1);
    let sweep = 0;
    let prevAngle = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = sub(pts[i]!, center);
      const angle = Math.atan2(dot(d, e2), dot(d, e1));
      let delta = angle - prevAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      sweep += delta;
      prevAngle = angle;
    }
    if (closed) sweep = Math.sign(sweep || 1) * 2 * Math.PI;
    const exactR = exactRimRadius(fa, center) ?? (fb === undefined ? null : exactRimRadius(fb, center)) ?? radius;
    return [{ ref: ref(), geom: { kind: "arc", center, normal: a, radius: exactR, start: add(center, scale(e1, exactR)), sweep } }];
  }

  // Straight runs (plane | plane, or any chain that happens to be straight).
  const runs: Vec3[][] = [];
  let run: Vec3[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    if (run.length >= 2) {
      const d0 = normalize(sub(run[run.length - 1]!, run[0]!));
      const d1 = normalize(sub(p, run[run.length - 1]!));
      if (length(cross(d0, d1)) > 1e-7 || dot(d0, d1) < 0) {
        runs.push(run);
        run = [run[run.length - 1]!];
      }
    }
    run.push(p);
  }
  runs.push(run);

  const bothPlanes = fa.geom.kind === "plane" && (fb === undefined || fb.geom.kind === "plane");
  if (bothPlanes || runs.length === 1) {
    return runs.map((r) => ({ ref: ref(), geom: { kind: "line" as const, a: r[0]!, b: r[r.length - 1]! } }));
  }
  return [{ ref: ref(), geom: { kind: "polyline", pts } }];
}
