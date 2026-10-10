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
import { sameRef } from "./types";
import type { Polygon } from "./csg";
import { makePolygon } from "./csg";
import { triangulate } from "./triangulate";
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
  private cells = new Map<number, number[]>();
  constructor(private tol: number) {}

  /** Hashed cell key (numbers, not strings: this runs per vertex); a clash
   *  only puts two cells in one list -- the distance test still decides. */
  private key(x: number, y: number, z: number): number {
    return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
  }

  index(p: Vec3): number {
    const s = this.tol * 4;
    const cx = Math.floor(p.x / s);
    const cy = Math.floor(p.y / s);
    const cz = Math.floor(p.z / s);
    // Only the cells within `tol` of p can hold a match: nearly always just its own.
    const x0 = Math.floor((p.x - this.tol) / s);
    const x1 = Math.floor((p.x + this.tol) / s);
    const y0 = Math.floor((p.y - this.tol) / s);
    const y1 = Math.floor((p.y + this.tol) / s);
    const z0 = Math.floor((p.z - this.tol) / s);
    const z1 = Math.floor((p.z + this.tol) / s);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const cell = this.cells.get(this.key(x, y, z));
          if (cell === undefined) continue;
          for (const i of cell) {
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
  private cells = new Map<number, number[]>();
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
  /** Hashed, as in Welder: a clash only adds candidates, the caller's distance test decides. */
  private key(x: number, y: number, z: number): number {
    return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
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
        for (let z = z0; z <= z1; z++) {
          const list = this.cells.get(this.key(x, y, z));
          if (list !== undefined) for (const i of list) out.push(i);
        }
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
  if (g.kind === "torus") {
    let a = normalize(g.axis);
    if (a.x < -1e-9 || (Math.abs(a.x) <= 1e-9 && (a.y < -1e-9 || (Math.abs(a.y) <= 1e-9 && a.z < 0)))) a = scale(a, -1);
    return `t:${r(a.x * 1e3)},${r(a.y * 1e3)},${r(a.z * 1e3)},${r(g.center.x)},${r(g.center.y)},${r(g.center.z)},${r(g.major)},${r(g.minor)}`;
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
  //     Only an edge without its reverse twin can have one (the far side of
  //     a T-junction is two shorter edges), so only those are searched.
  const grid = new VertexGrid(pts, Math.max(size / 32, tol * 10));
  const np = pts.length;
  /** Directed edges as "ends of the edges leaving each vertex": is there an edge a -> b? */
  const edgesFrom = (): ((a: number, b: number) => boolean) => {
    const from: number[][] = Array.from({ length: np }, () => []);
    for (const p of polys) for (let k = 0; k < p.idx.length; k++) from[p.idx[k]!]!.push(p.idx[(k + 1) % p.idx.length]!);
    return (a, b) => from[a]!.includes(b);
  };
  const twinned = edgesFrom();
  polys = polys.map((p) => {
    const out: number[] = [];
    for (let k = 0; k < p.idx.length; k++) {
      const ia = p.idx[k]!;
      const ib = p.idx[(k + 1) % p.idx.length]!;
      out.push(ia);
      if (twinned(ib, ia)) continue;
      const a = pts[ia]!;
      const b = pts[ib]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abz = b.z - a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      if (len2 === 0) continue;
      const onEdge: [number, number][] = [];
      for (const i of grid.near(a, b)) {
        if (i === ia || i === ib) continue;
        const q = pts[i]!;
        const apx = q.x - a.x;
        const apy = q.y - a.y;
        const apz = q.z - a.z;
        const t = (apx * abx + apy * aby + apz * abz) / len2;
        if (t <= 1e-12 || t >= 1 - 1e-12) continue;
        const dx = apx - abx * t;
        const dy = apy - aby * t;
        const dz = apz - abz * t;
        if (dx * dx + dy * dy + dz * dz <= tol * tol * 16) onEdge.push([t, i]);
      }
      if (onEdge.length === 0) continue;
      onEdge.sort((x, y) => x[0] - y[0]);
      for (const [, i] of onEdge) out.push(i);
    }
    return { ...p, idx: out };
  });

  // 1c. Belt and braces: any edge still without a reverse twin gets every
  //     vertex lying on it inserted (full scan, slightly looser tolerance),
  //     until the mesh closes up or nothing changes.
  for (let pass = 0; pass < 3; pass++) {
    const directed = edgesFrom();
    let changed = false;
    const loose2 = (tol * 1e3) ** 2;
    polys = polys.map((p) => {
      const out: number[] = [];
      let touched = false;
      for (let k = 0; k < p.idx.length; k++) {
        const ia = p.idx[k]!;
        const ib = p.idx[(k + 1) % p.idx.length]!;
        out.push(ia);
        if (directed(ib, ia)) continue;
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
  // Every ref merged into a surviving face stays findable (as an alias).
  const merged = new Map<number, TopoRef[]>();
  for (const [from, to] of canonical) {
    const list = merged.get(to) ?? [];
    for (const r of [faces[from]!.ref, ...(faces[from]!.aliases ?? [])]) {
      if (!sameRef(r, faces[to]!.ref) && !list.some((x) => sameRef(x, r))) list.push(r);
    }
    merged.set(to, list);
  }
  // A plane face's stored normal may be a cut tool's (pointing into the
  // result): re-derive it from the output polygons -- the face's LARGEST one,
  // since a boolean can leave hair-thin slivers along a seam whose own
  // normal is unreliable.
  const largest = new Map<number, { p: (typeof polys)[number]; area: number }>();
  for (const p of polys) {
    const src = canonical.get(p.faceId)!;
    let n = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < p.idx.length; k++) {
      const a = pts[p.idx[k]!]!;
      const b = pts[p.idx[(k + 1) % p.idx.length]!]!;
      n = { x: n.x + (a.y - b.y) * (a.z + b.z), y: n.y + (a.z - b.z) * (a.x + b.x), z: n.z + (a.x - b.x) * (a.y + b.y) };
    }
    const area = Math.hypot(n.x, n.y, n.z);
    const best = largest.get(src);
    if (best === undefined || area > best.area) largest.set(src, { p, area });
  }
  const newIndex = new Map<number, number>();
  const outFaces: Face[] = [];
  for (const p0 of polys) {
    const src = canonical.get(p0.faceId)!;
    if (newIndex.has(src)) continue;
    newIndex.set(src, outFaces.length);
    const f = faces[src]!;
    const p = largest.get(src)!.p;
    const geom: Face["geom"] =
      f.geom.kind === "plane" ? { kind: "plane", origin: pts[p.idx[0]!]!, normal: p.normal } : f.geom;
    const face: Face = { id: outFaces.length, ref: f.ref, geom };
    const aliases = merged.get(src) ?? [];
    if (aliases.length > 0) face.aliases = aliases;
    outFaces.push(face);
  }
  const faceOf = (p: { faceId: number }): number => newIndex.get(canonical.get(p.faceId)!)!;

  // 2b. Booleans leave a face shattered into slivers; re-triangulate each
  //     flat patch (same face, same plane) cleanly from its outline, so the
  //     next boolean isn't fed ever more fragments.
  polys = compactPlanarPatches(polys, pts, faceOf, tol);

  // 3. Render mesh (fan triangulation; per-face analytic normals).
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  for (const p of polys) {
    const fid = faceOf(p);
    const g = outFaces[fid]!.geom;
    const base = positions.length / 3;
    const cylAxis = g.kind === "cylinder" ? normalize(g.axis) : null;
    for (const i of p.idx) {
      const v = pts[i]!;
      positions.push(v.x, v.y, v.z);
      let n = p.normal;
      if (cylAxis !== null && g.kind === "cylinder") {
        // Straight out from the axis (plain arithmetic: this runs per vertex).
        const dx = v.x - g.axisOrigin.x;
        const dy = v.y - g.axisOrigin.y;
        const dz = v.z - g.axisOrigin.z;
        const along = dx * cylAxis.x + dy * cylAxis.y + dz * cylAxis.z;
        const rx = dx - cylAxis.x * along;
        const ry = dy - cylAxis.y * along;
        const rz = dz - cylAxis.z * along;
        const len = Math.hypot(rx, ry, rz);
        const sign = len > 0 ? (rx * p.normal.x + ry * p.normal.y + rz * p.normal.z >= 0 ? 1 / len : -1 / len) : 0;
        n = { x: rx * sign, y: ry * sign, z: rz * sign };
      } else if (g.kind === "torus") {
        // From the tube circle's centre nearest this point.
        const a = normalize(g.axis);
        const d = sub(v, g.center);
        const radial = normalize(sub(d, scale(a, dot(d, a))));
        const out = normalize(sub(v, add(g.center, scale(radial, g.major))));
        n = dot(out, p.normal) >= 0 ? out : scale(out, -1);
      }
      normals.push(n.x, n.y, n.z);
    }
    for (let k = 1; k + 1 < p.idx.length; k++) {
      indices.push(base, base + k, base + k + 1);
      faceIds.push(fid);
    }
  }

  // 4. Exact edges from face adjacency.
  //    Directed edges a -> b with the face on their left, in the order first
  //    met; `from[a]` lists the edges leaving a (numbers only: this runs per edge).
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeFid: number[] = [];
  const from: number[][] = Array.from({ length: pts.length }, () => []);
  const edgeAt = (a: number, b: number): number => {
    for (const e of from[a]!) if (edgeB[e] === b) return e;
    return -1;
  };
  for (const p of polys) {
    const fid = faceOf(p);
    for (let k = 0; k < p.idx.length; k++) {
      const a = p.idx[k]!;
      const b = p.idx[(k + 1) % p.idx.length]!;
      const e = edgeAt(a, b);
      if (e >= 0) edgeFid[e] = fid;
      else {
        from[a]!.push(edgeA.length);
        edgeA.push(a);
        edgeB.push(b);
        edgeFid.push(fid);
      }
    }
  }
  const segments = new Map<string, [number, number][]>(); // face pair -> undirected segments
  for (let e = 0; e < edgeA.length; e++) {
    const a = edgeA[e]!;
    const b = edgeB[e]!;
    const fid = edgeFid[e]!;
    const t = edgeAt(b, a);
    const twin = t < 0 ? undefined : edgeFid[t]!;
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
      // Faces meeting TANGENTIALLY (a fillet running into a face) make no
      // edge: the surface is smooth there -- and the boundary between two
      // near-coincident tessellations would only draw as a broken zig-zag.
      if (fb >= 0 && tangentAlong(chainPts, outFaces[fa]!, outFaces[fb]!)) continue;
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

/**
 * Re-triangulates every patch of polygons lying in one plane of one face
 * from its boundary loops (outer CCW + holes CW about the normal); only
 * interior vertices go. A patch whose outline can't be rebuilt exactly
 * (area / outline checks) is left as it was.
 *
 * Outline points are shared with the neighbours, so they normally stay (the
 * mesh must stay watertight) -- except a point in the middle of a straight
 * run that EVERY polygon / outline through it passes the same way (same two
 * neighbours): each split plane a boolean used leaves such points on the
 * long sides of cylinder facets, and they would pile up hole after hole.
 * Those go from both sides at once.
 */
function compactPlanarPatches<P extends { idx: number[]; normal: Vec3; faceId: number }>(
  polys: P[],
  pts: readonly Vec3[],
  faceOf: (p: P) => number,
  tol: number,
): P[] {
  const groups = new Map<string, P[]>();
  const rn = (v: number): number => Math.round(v * 1e6);
  for (const p of polys) {
    const n = p.normal;
    const w = dot(n, pts[p.idx[0]!]!);
    const key = `${faceOf(p)}|${rn(n.x)},${rn(n.y)},${rn(n.z)},${Math.round(w / (tol * 1e3))}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [p]);
    else g.push(p);
  }
  let patches: { group: P[]; loops: number[][] }[] = [];
  const raw: P[] = [];
  for (const group of groups.values()) {
    const loops = group.length < 3 ? null : patchLoops(group);
    if (loops === null) raw.push(...group);
    else patches.push({ group, loops });
  }
  // A patch that fails keeps its old polygons, whose points must then all
  // stay (neighbours can't drop them either): pin them and go again.
  const pinned = new Set<number>();
  for (;;) {
    const drop = straightRunPoints([...raw.map((p) => p.idx), ...patches.flatMap((q) => q.loops)], pts, pinned);
    const keep = (ring: number[]): number[] => (drop.size === 0 ? ring : ring.filter((i) => !drop.has(i)));
    const out: P[] = [];
    for (const p of raw) {
      const idx = keep(p.idx);
      if (idx.length >= 3) out.push(idx === p.idx ? p : { ...p, idx });
    }
    const failed: typeof patches = [];
    for (const q of patches) {
      const loops = q.loops.map(keep);
      const redone = loops.every((l) => l.length >= 3) ? retriangulate(q.group, loops, pts) : null;
      if (redone === null) failed.push(q);
      else out.push(...redone);
    }
    if (failed.length === 0) return out;
    for (const q of failed) {
      raw.push(...q.group);
      for (const p of q.group) for (const i of p.idx) pinned.add(i);
    }
    patches = patches.filter((q) => !failed.includes(q));
  }
}

/** Points in the middle of a straight run that every ring through them
 *  passes between the same two neighbours (see compactPlanarPatches). */
function straightRunPoints(rings: readonly number[][], pts: readonly Vec3[], pinned: ReadonlySet<number>): Set<number> {
  const pair = new Map<number, [number, number, number] | null>(); // v -> [u, w, times seen]
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const v = ring[k]!;
      const a = ring[(k + ring.length - 1) % ring.length]!;
      const b = ring[(k + 1) % ring.length]!;
      const [u, w] = a < b ? [a, b] : [b, a];
      const cur = pair.get(v);
      if (cur === undefined) pair.set(v, [u, w, 1]);
      else if (cur !== null) {
        if (cur[0] === u && cur[1] === w) cur[2]++;
        else pair.set(v, null);
      }
    }
  }
  const drop = new Set<number>();
  for (const [v, uw] of pair) {
    if (uw === null || uw[2] < 2 || uw[0] === uw[1] || pinned.has(v)) continue;
    const u = pts[uw[0]]!;
    const uv = sub(pts[v]!, u);
    const uw3 = sub(pts[uw[1]]!, u);
    const len2 = dot(uw3, uw3);
    const t = dot(uv, uw3) / len2;
    if (!(t > 1e-9 && t < 1 - 1e-9)) continue;
    const c = cross(uv, uw3);
    if (dot(c, c) <= len2 * len2 * 1e-18) drop.add(v);
  }
  return drop;
}

function polygonArea3(idx: readonly number[], pts: readonly Vec3[], n: Vec3): number {
  let a = 0;
  const o = pts[idx[0]!]!;
  for (let k = 1; k + 1 < idx.length; k++) {
    a += dot(cross(sub(pts[idx[k]!]!, o), sub(pts[idx[k + 1]!]!, o)), n) / 2;
  }
  return a;
}

/** A patch's boundary loops, or null when its outline is pinched / open. */
function patchLoops(group: readonly { idx: number[] }[]): number[][] | null {
  // Boundary = directed edges whose reverse isn't in the patch.
  const directed = new Set<string>();
  for (const p of group) for (let k = 0; k < p.idx.length; k++) directed.add(`${p.idx[k]}|${p.idx[(k + 1) % p.idx.length]}`);
  const next = new Map<number, number[]>();
  let boundaryCount = 0;
  for (const p of group) {
    for (let k = 0; k < p.idx.length; k++) {
      const a = p.idx[k]!;
      const b = p.idx[(k + 1) % p.idx.length]!;
      if (a === b || directed.has(`${b}|${a}`)) continue;
      const list = next.get(a);
      if (list === undefined) next.set(a, [b]);
      else list.push(b);
      boundaryCount++;
    }
  }
  // Pinched outlines (a vertex with two ways on) -- leave the patch alone.
  for (const list of next.values()) if (list.length !== 1) return null;
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!used.has(v)) {
      used.add(v);
      loop.push(v);
      const nv = next.get(v)?.[0];
      if (nv === undefined) return null;
      v = nv;
    }
    if (v !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  if (loops.reduce((s, l) => s + l.length, 0) !== boundaryCount) return null;
  return loops;
}

/** Fills a patch's (possibly thinned) outline loops with fresh triangles,
 *  or null when that can't be done exactly. */
function retriangulate<P extends { idx: number[]; normal: Vec3; faceId: number }>(
  group: P[],
  loops: readonly number[][],
  pts: readonly Vec3[],
): P[] | null {
  const n = normalize(group[0]!.normal);
  const next = new Map<number, number>();
  for (const l of loops) l.forEach((v, k) => next.set(v, l[(k + 1) % l.length]!));
  const boundaryCount = loops.reduce((s, l) => s + l.length, 0);
  if (next.size !== boundaryCount) return null; // thinning made a loop touch itself

  // 2D in the patch plane.
  const u = normalize(Math.abs(n.x) < 0.9 ? cross(n, { x: 1, y: 0, z: 0 }) : cross(n, { x: 0, y: 1, z: 0 }));
  const v2 = cross(n, u);
  const to2 = (i: number): [number, number] => [dot(pts[i]!, u), dot(pts[i]!, v2)];
  const area2 = (loop: number[]): number => {
    let a = 0;
    for (let k = 0; k < loop.length; k++) {
      const [x0, y0] = to2(loop[k]!);
      const [x1, y1] = to2(loop[(k + 1) % loop.length]!);
      a += x0 * y1 - x1 * y0;
    }
    return a / 2;
  };
  const outers = loops.filter((l) => area2(l) > 0);
  const holes = loops.filter((l) => area2(l) < 0);
  const inside = (p: [number, number], loop: number[]): boolean => {
    let c = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = to2(loop[i]!);
      const [xj, yj] = to2(loop[j]!);
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const expected = group.reduce((s, p) => s + polygonArea3(p.idx, pts, n), 0);
  const tri: P[] = [];
  let got = 0;
  const holesOf = new Map<number[], number[][]>(outers.map((o) => [o, []]));
  for (const h of holes) {
    // The smallest outer containing the hole.
    const probe = to2(h[0]!);
    const host = outers.filter((o) => inside(probe, o)).sort((a, b) => area2(a) - area2(b))[0];
    if (host === undefined) return null;
    holesOf.get(host)!.push(h);
  }
  // Points lying on a straight run of the outline (inserted so neighbours
  // match up) would make zero-area ears: triangulate without them, then put
  // each back by fanning the triangle whose side it lies on.
  const onSide = new Map<string, number[]>(); // simplified side "a|b" -> points between, in order
  const simplify = (ring: number[]): number[] | null => {
    const keep = ring.filter((i, k) => {
      const [px, py] = to2(ring[(k + ring.length - 1) % ring.length]!);
      const [x, y] = to2(i);
      const [nx, ny] = to2(ring[(k + 1) % ring.length]!);
      const cr = (x - px) * (ny - py) - (y - py) * (nx - px);
      const len2 = (nx - px) ** 2 + (ny - py) ** 2;
      return Math.abs(cr) > len2 * 1e-9;
    });
    if (keep.length < 3) return null;
    // Record what was dropped between consecutive kept points.
    const at = new Map(ring.map((i, k) => [i, k]));
    for (let k = 0; k < keep.length; k++) {
      const a = keep[k]!;
      const b = keep[(k + 1) % keep.length]!;
      const between: number[] = [];
      for (let j = (at.get(a)! + 1) % ring.length; ring[j] !== b; j = (j + 1) % ring.length) between.push(ring[j]!);
      if (between.length > 0) onSide.set(`${a}|${b}`, between);
    }
    return keep;
  };
  const fan = (a: number, b: number, c: number, out: number[][]): void => {
    // Triangle (a, b, c): put back any dropped points on its sides.
    for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      const pts2 = onSide.get(`${p}|${q}`);
      if (pts2 === undefined) continue;
      const chain = [p, ...pts2, q];
      for (let k = 0; k + 1 < chain.length; k++) fan(chain[k]!, chain[k + 1]!, r, out);
      onSide.delete(`${p}|${q}`); // (restored on the one side that has it)
      return;
    }
    out.push([a, b, c]);
  };
  for (const outer of outers) {
    const rings: number[][] = [];
    for (const ring of [outer, ...holesOf.get(outer)!]) {
      const simple = simplify(ring);
      if (simple === null) return null;
      rings.push(simple);
    }
    const flat: number[] = [];
    const ids: number[] = [];
    const holeIdx: number[] = [];
    rings.forEach((ring, r) => {
      if (r > 0) holeIdx.push(ids.length);
      for (const i of ring) {
        const [x, y] = to2(i);
        flat.push(x, y);
        ids.push(i);
      }
    });
    const t = triangulate(flat, holeIdx);
    const fanned: number[][] = [];
    for (let k = 0; k + 2 < t.length; k += 3) {
      // triangulate() doesn't keep the input winding: turn each triangle to
      // the outline's sense (CCW about n) before the checks below.
      const [a, b, c] = [t[k]!, t[k + 1]!, t[k + 2]!];
      const turn = (flat[b * 2]! - flat[a * 2]!) * (flat[c * 2 + 1]! - flat[a * 2 + 1]!) - (flat[b * 2 + 1]! - flat[a * 2 + 1]!) * (flat[c * 2]! - flat[a * 2]!);
      if (turn < 0) fan(ids[b]!, ids[a]!, ids[c]!, fanned);
      else fan(ids[a]!, ids[b]!, ids[c]!, fanned);
    }
    for (const idx of fanned) {
      const a = polygonArea3(idx, pts, n);
      if (!(a > 0)) return null; // a flipped or degenerate triangle: not a clean fill
      got += a;
      tri.push({ ...group[0]!, idx });
    }
  }
  // Same area as before...
  if (!(Math.abs(got - expected) <= Math.abs(expected) * 1e-6 + 1e-9)) return null;
  // ...and exactly the same outline, every inner edge shared once each way
  // (overlapping triangles can't pass this).
  const count = new Map<string, number>();
  for (const q of tri) {
    for (let k = 0; k < 3; k++) {
      const key = `${q.idx[k]}|${q.idx[(k + 1) % 3]}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let outline = 0;
  for (const [key, c] of count) {
    if (c !== 1) return null;
    const [a, b] = key.split("|");
    if (count.has(`${b}|${a}`)) continue;
    if (next.get(Number(a)) !== Number(b)) return null;
    outline++;
  }
  if (outline !== boundaryCount) return null;
  return tri;
}

/** Exact unit normal of a face's surface at a point on it (either sign), or
 *  null for free-form faces. */
function surfaceNormalAt(face: Face, p: Vec3): Vec3 | null {
  const g = face.geom;
  if (g.kind === "plane") return normalize(g.normal);
  if (g.kind === "cylinder") {
    const a = normalize(g.axis);
    const d = sub(p, g.axisOrigin);
    return normalize(sub(d, scale(a, dot(d, a))));
  }
  if (g.kind === "cone") {
    const a = normalize(g.axis);
    const d = sub(p, g.apex);
    const radial = normalize(sub(d, scale(a, dot(d, a))));
    // Square to the cone's slant line through p.
    return normalize(sub(scale(radial, Math.cos(g.halfAngle)), scale(a, Math.sin(g.halfAngle))));
  }
  if (g.kind === "torus") {
    const a = normalize(g.axis);
    const d = sub(p, g.center);
    const radial = normalize(sub(d, scale(a, dot(d, a))));
    return normalize(sub(p, add(g.center, scale(radial, g.major))));
  }
  return null;
}

/** True if faces `fa` and `fb` are tangent (same surface direction) all
 *  along the chain -- checked at its ends and middle. */
function tangentAlong(pts: readonly Vec3[], fa: Face, fb: Face): boolean {
  const COS = Math.cos((1.5 * Math.PI) / 180);
  for (const p of [pts[0]!, pts[Math.floor(pts.length / 2)]!, pts[pts.length - 1]!]) {
    const na = surfaceNormalAt(fa, p);
    const nb = surfaceNormalAt(fb, p);
    if (na === null || nb === null || Math.abs(dot(na, nb)) < COS) return false;
  }
  return true;
}

/** Exact radius of a circle on a cylinder/cone/torus at `center` (on its
 *  axis); `measured` picks between a torus's two circles at that height. */
function exactRimRadius(face: Face, center: Vec3, measured: number): number | null {
  if (face.geom.kind === "torus") {
    const g = face.geom;
    const h = dot(sub(center, g.center), normalize(g.axis));
    const w = g.minor * g.minor - h * h;
    if (w < 0) return null;
    const roots = [g.major - Math.sqrt(w), g.major + Math.sqrt(w)];
    return Math.abs(roots[0]! - measured) < Math.abs(roots[1]! - measured) ? roots[0]! : roots[1]!;
  }
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
  if (face.geom.kind === "torus") return { point: face.geom.center, dir: normalize(face.geom.axis) };
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
    const exactR = exactRimRadius(fa, center, radius) ?? (fb === undefined ? null : exactRimRadius(fb, center, radius)) ?? radius;
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
