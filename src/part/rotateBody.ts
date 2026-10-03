/**
 * MinimalCAD Web
 * part/rotateBody.ts
 *
 * Rotate Body: turns finished solids about an axis -- an origin axis
 * (X / Y / Z through the origin), a straight edge of the model, or a round
 * face's own axis. The bodies keep their face refs, so later features
 * (sketches on faces, holes, fillets...) still find their faces after the
 * turn. Parametric like every other feature: the angle is an expression,
 * and a picked edge / face is found again on every rebuild.
 */

import type { Body, Edge, Face } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import { edgeFaceIds, modelTol } from "./edgeBlend";
import { evalExpression } from "./params";
import type { MadeTool, Transform } from "./pattern";
import { rotation } from "./pattern";
import type { EdgeRef, PatternAxis, RotateFeature, XYZ } from "./types";
import type { Vec3 } from "./vec3";
import { add, dot, length, normalize, scale, sub } from "./vec3";

const AXES: Record<PatternAxis, Vec3> = { X: { x: 1, y: 0, z: 0 }, Y: { x: 0, y: 1, z: 0 }, Z: { x: 0, y: 0, z: 1 } };

/** A straight edge of the model that can be turned about. */
export interface AxisEdge {
  body: Body;
  a: Vec3;
  b: Vec3;
  faceA: Face;
  faceB: Face;
}

/** Every straight edge of `body` between two faces. */
export function axisEdges(body: Body): AxisEdge[] {
  const tol = modelTol(body);
  const out: AxisEdge[] = [];
  for (const edge of body.edges) {
    const g = edge.geom;
    if (g.kind !== "line" || !(length(sub(g.b, g.a)) > tol)) continue;
    const ids = edgeFaceIds(body, scale(add(g.a, g.b), 0.5), tol);
    if (ids.length !== 2) continue;
    out.push({ body, a: g.a, b: g.b, faceA: body.faces[ids[0]!]!, faceB: body.faces[ids[1]!]! });
  }
  return out;
}

export function axisEdgeRef(e: AxisEdge): EdgeRef & { a: XYZ; b: XYZ } {
  return { faces: [e.faceA.ref, e.faceB.ref], at: scale(add(e.a, e.b), 0.5), a: e.a, b: e.b };
}

function distToLine(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return length(sub(p, add(a, scale(ab, t))));
}

/** The edge `ref` names among `bodies` (as they stand), or null. */
function findEdge(bodies: readonly Body[], ref: EdgeRef): { a: Vec3; b: Vec3 } | null {
  let best: { a: Vec3; b: Vec3; d: number } | null = null;
  for (const body of bodies) {
    for (const e of axisEdges(body)) {
      const match =
        (faceHasRef(e.faceA, ref.faces[0]) && faceHasRef(e.faceB, ref.faces[1])) ||
        (faceHasRef(e.faceA, ref.faces[1]) && faceHasRef(e.faceB, ref.faces[0]));
      if (!match) continue;
      const d = distToLine(ref.at, e.a, e.b);
      if (best === null || d < best.d) best = { a: e.a, b: e.b, d };
    }
  }
  return best;
}

/** The axis of a round face (by ref) among `bodies`. */
function roundFaceAxis(bodies: readonly Body[], ref: RotateFeature["axisFace"] & object): { o: Vec3; k: Vec3 } | string {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, ref));
    if (face === undefined) continue;
    if (face.geom.kind === "cylinder") return { o: face.geom.axisOrigin, k: normalize(face.geom.axis) };
    if (face.geom.kind === "cone") return { o: face.geom.apex, k: normalize(face.geom.axis) };
    return "The face to turn about is not round";
  }
  return "The round face this rotation turns about no longer exists";
}

/** The turn a Rotate feature makes, against `bodies` as they stand -- or why it can't. */
export function rotateTransform(f: RotateFeature, bodies: readonly Body[], params: ReadonlyMap<string, number>): Transform | string {
  const deg = evalExpression(f.angle, params);
  if (deg === null) return `Invalid angle "${f.angle}"`;
  let axis: { o: Vec3; k: Vec3 };
  if (f.axisFace !== undefined) {
    const r = roundFaceAxis(bodies, f.axisFace);
    if (typeof r === "string") return r;
    axis = r;
  } else if (f.axisEdge !== undefined) {
    // Follows the edge if the model changed; the ends as picked otherwise.
    const e = findEdge(bodies, f.axisEdge) ?? f.axisEdge;
    const d = sub(e.b, e.a);
    if (!(length(d) > 0)) return "The edge to turn about has no length";
    axis = { o: e.a, k: normalize(d) };
  } else axis = { o: { x: 0, y: 0, z: 0 }, k: AXES[f.axis ?? "Z"] };
  return rotation(axis.o, axis.k, (deg * Math.PI) / 180);
}

function moveEdge(g: Edge["geom"], t: Transform): Edge["geom"] {
  if (g.kind === "line") return { kind: "line", a: t.point(g.a), b: t.point(g.b) };
  if (g.kind === "polyline") return { kind: "polyline", pts: g.pts.map(t.point) };
  return { ...g, center: t.point(g.center), normal: t.dir(g.normal), start: t.point(g.start) };
}

function moveFace(f: Face, t: Transform): Face {
  const g = f.geom;
  const geom: Face["geom"] =
    g.kind === "plane"
      ? { kind: "plane", origin: t.point(g.origin), normal: t.dir(g.normal) }
      : g.kind === "cylinder"
        ? { ...g, axisOrigin: t.point(g.axisOrigin), axis: t.dir(g.axis) }
        : g.kind === "cone"
          ? { ...g, apex: t.point(g.apex), axis: t.dir(g.axis) }
          : g.kind === "torus"
            ? { ...g, center: t.point(g.center), axis: t.dir(g.axis) }
            : g;
  return { ...f, geom };
}

/** `body` turned by `t` (a rigid move), keeping its id and every ref. */
export function moveBody(body: Body, t: Transform): Body {
  const { positions: p, normals: n } = body.mesh;
  const positions = new Float64Array(p.length);
  const normals = new Float64Array(n.length);
  for (let i = 0; i < p.length; i += 3) {
    const q = t.point({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! });
    const m = t.dir({ x: n[i]!, y: n[i + 1]!, z: n[i + 2]! });
    positions.set([q.x, q.y, q.z], i);
    normals.set([m.x, m.y, m.z], i);
  }
  return {
    ...body,
    mesh: { positions, normals, indices: body.mesh.indices, faceIds: body.mesh.faceIds },
    faces: body.faces.map((f) => moveFace(f, t)),
    edges: body.edges.map((e) => ({ ref: e.ref, geom: moveEdge(e.geom, t) })),
  };
}

/** Closest distance from `p` to triangle abc. */
function distToTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  // Ericson, Real-Time Collision Detection 5.1.5.
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return length(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return length(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return length(sub(p, add(a, scale(ab, d1 / (d1 - d3)))));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return length(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return length(sub(p, add(a, scale(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return length(sub(p, add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))))));
  const denom = 1 / (va + vb + vc);
  return length(sub(p, add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)))));
}

/** How far `p` is from the surface of `body`. */
export function distToBody(body: Body, p: Vec3): number {
  const { positions: q, indices } = body.mesh;
  const v = (i: number): Vec3 => ({ x: q[i * 3]!, y: q[i * 3 + 1]!, z: q[i * 3 + 2]! });
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) best = Math.min(best, distToTriangle(p, v(indices[t]!), v(indices[t + 1]!), v(indices[t + 2]!)));
  return best;
}

const splitCache = new WeakMap<Body, Body[]>();

/**
 * `body` split into its separate solid pieces (triangles connected through
 * shared corners) -- one Extrude of several shapes is one body of several
 * pieces. Each piece keeps only its own faces (renumbered) and edges, with
 * every ref unchanged. A body in one piece comes back as itself.
 */
export function splitBody(body: Body): Body[] {
  const cached = splitCache.get(body);
  if (cached !== undefined) return cached;
  const { positions: p, normals: n, indices, faceIds } = body.mesh;
  const tol = modelTol(body) * 10;
  const key = (i: number): string => `${Math.round(p[i * 3]! / tol)},${Math.round(p[i * 3 + 1]! / tol)},${Math.round(p[i * 3 + 2]! / tol)}`;
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = k;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const ks = [key(indices[t]!), key(indices[t + 1]!), key(indices[t + 2]!)];
    for (const k of ks) if (!parent.has(k)) parent.set(k, k);
    const r0 = find(ks[0]!);
    for (const k of ks.slice(1)) {
      const r = find(k);
      if (r !== r0) parent.set(r, r0);
    }
  }
  const groups = new Map<string, number[]>();
  for (let t = 0; t < indices.length; t += 3) {
    const r = find(key(indices[t]!));
    const list = groups.get(r);
    if (list === undefined) groups.set(r, [t]);
    else list.push(t);
  }
  if (groups.size <= 1) {
    splitCache.set(body, [body]);
    return [body];
  }
  const pieces: Body[] = [];
  let k = 0;
  for (const tris of groups.values()) {
    const remap = new Map<number, number>();
    const faceMap = new Map<number, number>();
    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    const fid: number[] = [];
    for (const t of tris) {
      for (let j = 0; j < 3; j++) {
        const vi = indices[t + j]!;
        let ni = remap.get(vi);
        if (ni === undefined) {
          ni = pos.length / 3;
          remap.set(vi, ni);
          pos.push(p[vi * 3]!, p[vi * 3 + 1]!, p[vi * 3 + 2]!);
          nor.push(n[vi * 3]!, n[vi * 3 + 1]!, n[vi * 3 + 2]!);
        }
        idx.push(ni);
      }
      const f = faceIds[t / 3]!;
      if (!faceMap.has(f)) faceMap.set(f, faceMap.size);
      fid.push(faceMap.get(f)!);
    }
    const faces: Face[] = [...faceMap.entries()].map(([old, id]) => ({ ...body.faces[old]!, id }));
    const piece: Body = {
      id: k === 0 ? body.id : `${body.id}.${k}`,
      feature: body.feature,
      mesh: { positions: new Float64Array(pos), normals: new Float64Array(nor), indices: new Uint32Array(idx), faceIds: new Uint32Array(fid) },
      faces,
      edges: [],
    };
    pieces.push(piece);
    k++;
  }
  // Each edge goes with the piece it lies on.
  for (const e of body.edges) {
    const g = e.geom;
    const at = g.kind === "line" ? scale(add(g.a, g.b), 0.5) : g.kind === "arc" ? g.start : g.pts[0]!;
    let best = pieces[0]!;
    let d = Infinity;
    for (const piece of pieces) {
      const dd = distToBody(piece, at);
      if (dd < d) [best, d] = [piece, dd];
    }
    best.edges.push(e);
  }
  splitCache.set(body, pieces);
  return pieces;
}

/** The piece of `pieces` a picked point `at` lies on (nearest). */
function nearestPiece(pieces: readonly Body[], at: Vec3): { piece: Body; d: number } | null {
  let best: { piece: Body; d: number } | null = null;
  for (const piece of pieces) {
    const d = distToBody(piece, at);
    if (best === null || d < best.d) best = { piece, d };
  }
  return best;
}

/** True if `a` and `b` (both picked points) land on the same solid piece of `body`. */
export function samePiece(body: Body, a: Vec3, b: Vec3): boolean {
  const pieces = splitBody(body);
  return nearestPiece(pieces, a)?.piece === nearestPiece(pieces, b)?.piece;
}

export interface RotateSelection {
  /** The model's bodies, with any body that is only partly turned split into its pieces. */
  bodies: Body[];
  /** Which of `bodies` turn. */
  targets: Set<Body>;
  /** Features whose every body turns (their tool solids turn with them). */
  whole: (feature: string) => boolean;
}

/** Which solids a Rotate turns: all, those of the listed features, or the picked pieces. */
export function rotateSelection(f: Pick<RotateFeature, "bodies" | "pieces">, bodies: readonly Body[]): RotateSelection {
  if (f.pieces === undefined) {
    const targets = f.bodies === undefined ? bodies : bodies.filter((b) => f.bodies!.includes(b.feature));
    return { bodies: bodies.slice(), targets: new Set(targets), whole: (id) => f.bodies === undefined || f.bodies.includes(id) };
  }
  const chosen = new Set<Body>();
  for (const pick of f.pieces) {
    const pieces = bodies.filter((b) => b.feature === pick.feature).flatMap(splitBody);
    const hit = nearestPiece(pieces, pick.at);
    if (hit !== null) chosen.add(hit.piece);
  }
  const out: Body[] = [];
  const targets = new Set<Body>();
  const partly = new Set<string>();
  for (const b of bodies) {
    const pieces = splitBody(b);
    const n = pieces.filter((x) => chosen.has(x)).length;
    if (n === 0) {
      out.push(b);
      partly.add(b.feature);
    } else if (n === pieces.length) {
      out.push(b);
      targets.add(b);
    } else {
      partly.add(b.feature);
      for (const x of pieces) {
        out.push(x);
        if (chosen.has(x)) targets.add(x);
      }
    }
  }
  return { bodies: out, targets, whole: (id) => !partly.has(id) && out.some((b) => b.feature === id && targets.has(b)) };
}

/**
 * Applies a Rotate (in place): the chosen solids are turned, and so are the
 * remembered tool solids of features turned whole -- so a later Pattern of
 * those features repeats them where they now are.
 */
export function applyRotate(
  f: RotateFeature,
  bodies: Body[],
  made: Map<string, MadeTool[]>,
  params: ReadonlyMap<string, number>,
): { ok: boolean; error?: string } {
  const t = rotateTransform(f, bodies, params);
  if (typeof t === "string") return { ok: false, error: t };
  const sel = rotateSelection(f, bodies);
  if (sel.targets.size === 0) return { ok: false, error: "No bodies to rotate - the picked solids are gone" };
  bodies.splice(0, bodies.length, ...sel.bodies.map((b) => (sel.targets.has(b) ? moveBody(b, t) : b)));
  for (const [id, tools] of made) {
    if (sel.whole(id)) made.set(id, tools.map((m) => ({ op: m.op, tool: moveBody(m.tool, t) })));
  }
  return { ok: true };
}
