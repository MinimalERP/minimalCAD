/**
 * MinimalCAD Web
 * part/edgeBlend.ts
 *
 * Fillet and Chamfer, on our own engine. Every picked edge gets a "corner
 * tool" whose cross-section is built once in 2D, square to the edge:
 *
 *        outside (convex) edge            inside (concave) edge
 *        -> the tool is CUT away          -> the tool is ADDED
 *
 *          B |                                 A ____________
 *            |__  <- fillet arc / chamfer        |  __
 *            |  \_                               | /  <- arc / chamfer
 *     _______|____\___ A                         |/________ B
 *
 * A straight edge between two flat faces: the section is extruded along
 * the edge (the fillet face comes out an exact cylinder). A circle rim
 * where a round face meets a flat face square to its axis: the section is
 * revolved about that axis.
 *
 * Edges are found again on every rebuild by their two faces (stable refs)
 * and a nearby point -- see EdgeRef in types.ts.
 */

import type { Point } from "../core/types";
import type { Body, Edge, Face } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import { extrudeRegions } from "./kernel/extrude";
import { revolveProfile } from "./kernel/revolve";
import type { FaceGroup, RZ } from "./kernel/revolve";
import { evalExpression } from "./params";
import type { Segment } from "./profile";
import { regionFromSegments } from "./profile";
import type { EdgeFeature, EdgeRef } from "./types";
import type { Vec3 } from "./vec3";
import { add, cross, dot, length, normalize, scale, sub } from "./vec3";

/** An edge a fillet / chamfer can go on. */
export interface BlendEdge {
  body: Body;
  edge: Edge;
  kind: "line" | "circle";
  faceA: Face;
  faceB: Face;
  /** Points along it (display, picking, nearest-point matching). */
  polyline: Vec3[];
  /** A point on it (stored in the EdgeRef). */
  at: Vec3;
}

function modelTol(body: Body): number {
  let size = 1;
  const p = body.mesh.positions;
  for (let i = 0; i < p.length; i++) size = Math.max(size, Math.abs(p[i]!));
  return size * 1e-6 + 1e-9;
}

const vtx = (body: Body, i: number): Vec3 => {
  const p = body.mesh.positions;
  return { x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! };
};

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return length(sub(p, add(a, scale(ab, t))));
}

function arcPoints(g: Extract<Edge["geom"], { kind: "arc" }>): Vec3[] {
  const e1 = normalize(sub(g.start, g.center));
  const e2 = cross(normalize(g.normal), e1);
  const n = Math.max(8, Math.ceil(Math.abs(g.sweep) / (Math.PI / 36)));
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (g.sweep * i) / n;
    out.push(add(g.center, add(scale(e1, g.radius * Math.cos(t)), scale(e2, g.radius * Math.sin(t)))));
  }
  return out;
}

/** The faces meeting along `edge` (by the mesh triangles touching it). */
function edgeFaceIds(body: Body, probe: Vec3, tol: number): number[] {
  const { indices, faceIds } = body.mesh;
  const ids = new Set<number>();
  for (let t = 0; t < faceIds.length; t++) {
    const f = faceIds[t]!;
    if (ids.has(f)) continue;
    for (let k = 0; k < 3; k++) {
      if (distToSegment(probe, vtx(body, indices[t * 3 + k]!), vtx(body, indices[t * 3 + ((k + 1) % 3)]!)) <= tol) {
        ids.add(f);
        break;
      }
    }
  }
  return [...ids];
}

/** Every edge of `body` a fillet / chamfer can go on. */
export function blendEdges(body: Body): BlendEdge[] {
  const tol = modelTol(body);
  const out: BlendEdge[] = [];
  for (const edge of body.edges) {
    const g = edge.geom;
    if (g.kind === "line") {
      const at = scale(add(g.a, g.b), 0.5);
      const ids = edgeFaceIds(body, at, tol);
      if (ids.length !== 2) continue;
      const [fa, fb] = ids.map((i) => body.faces[i]!) as [Face, Face];
      if (fa.geom.kind !== "plane" || fb.geom.kind !== "plane") continue;
      if (length(cross(normalize(fa.geom.normal), normalize(fb.geom.normal))) < 1e-6) continue; // flat: no corner
      out.push({ body, edge, kind: "line", faceA: fa, faceB: fb, polyline: [g.a, g.b], at });
    } else if (g.kind === "arc") {
      if (Math.abs(Math.abs(g.sweep) - 2 * Math.PI) > 1e-6) continue; // full circle rims only
      const ids = edgeFaceIds(body, g.start, tol);
      if (ids.length !== 2) continue;
      const faces = ids.map((i) => body.faces[i]!);
      const plane = faces.find((f) => f.geom.kind === "plane");
      const cyl = faces.find((f) => f.geom.kind === "cylinder");
      if (plane === undefined || cyl === undefined || plane.geom.kind !== "plane" || cyl.geom.kind !== "cylinder") continue;
      const axis = normalize(cyl.geom.axis);
      if (Math.abs(Math.abs(dot(normalize(plane.geom.normal), axis)) - 1) > 1e-6) continue;
      out.push({ body, edge, kind: "circle", faceA: plane, faceB: cyl, polyline: arcPoints(g), at: g.start });
    }
  }
  return out;
}

/** Distance from `p` to a blendable edge. */
export function distToBlendEdge(e: BlendEdge, p: Vec3): number {
  const g = e.edge.geom;
  if (g.kind === "line") return distToSegment(p, g.a, g.b);
  if (g.kind === "arc") {
    const n = normalize(g.normal);
    const d = sub(p, g.center);
    const h = dot(d, n);
    return Math.hypot(h, length(sub(d, scale(n, h))) - g.radius);
  }
  return Infinity;
}

export function edgeRefOf(e: BlendEdge): EdgeRef {
  return { faces: [e.faceA.ref, e.faceB.ref], at: e.at };
}

/** True if `e` is the edge `ref` names (same two faces, either order). */
export function matchesRef(e: BlendEdge, ref: EdgeRef): boolean {
  const [a, b] = ref.faces;
  return (faceHasRef(e.faceA, a) && faceHasRef(e.faceB, b)) || (faceHasRef(e.faceA, b) && faceHasRef(e.faceB, a));
}

/** The edge `ref` names among `edges`: between its two faces, nearest its point. */
export function resolveEdgeRef(edges: readonly BlendEdge[], ref: EdgeRef): BlendEdge | null {
  let best: BlendEdge | null = null;
  let bestD = Infinity;
  for (const e of edges) {
    if (!matchesRef(e, ref)) continue;
    const d = distToBlendEdge(e, ref.at);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

// --- the corner, square to the edge (2D) ---

/** The edge's corner in 2D: at the origin, face A running along tA and B
 *  along tB (unit, away from the edge), with outward normals nA, nB. */
interface Corner {
  tA: Point;
  tB: Point;
  nA: Point;
  nB: Point;
  convex: boolean;
}

const p2 = (x: number, y: number): Point => ({ x, y });
const add2 = (a: Point, b: Point): Point => p2(a.x + b.x, a.y + b.y);
const mul2 = (a: Point, s: number): Point => p2(a.x * s, a.y * s);
const dot2 = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const norm2 = (a: Point): Point => mul2(a, 1 / Math.hypot(a.x, a.y));

/** The 2D tool section (a closed chain of segments), or an error. */
export function cornerSection(
  c: Corner,
  f: { type: "fillet" | "chamfer"; d1: number; d2: number },
  margin: number,
): Segment[] | string {
  const alpha = Math.acos(Math.max(-1, Math.min(1, dot2(c.tA, c.tB))));
  if (!(alpha > 1e-6 && alpha < Math.PI - 1e-6)) return "The faces at this edge are flat to each other";
  const s = c.convex ? 1 : -1;
  const line = (a: Point, b: Point): Segment => ({ kind: "line", a, b });
  // Beyond the faces: into air for a cut, into material for an add.
  const outer = (pa: Point, pb: Point): Segment[] => {
    const qa = add2(pa, mul2(c.nA, s * margin));
    const corner = mul2(add2(c.nA, c.nB), s * margin);
    const qb = add2(pb, mul2(c.nB, s * margin));
    return [line(pa, qa), line(qa, corner), line(corner, qb), line(qb, pb)];
  };
  if (f.type === "chamfer") {
    const pa = mul2(c.tA, f.d1);
    const pb = mul2(c.tB, f.d2);
    return [...outer(pa, pb), line(pb, pa)];
  }
  const r = f.d1;
  const d = r / Math.tan(alpha / 2);
  const ta = mul2(c.tA, d);
  const tb = mul2(c.tB, d);
  const center = mul2(norm2(add2(c.tA, c.tB)), r / Math.sin(alpha / 2));
  const a0 = Math.atan2(tb.y - center.y, tb.x - center.x);
  let sweep = Math.atan2(ta.y - center.y, ta.x - center.x) - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  return [...outer(ta, tb), { kind: "arc", c: center, r, a0, sweep }];
}

/** A point of `face` just off the edge (tells which side of it the face
 *  is): the centre of one of its triangles with two corners on the edge.
 *  (A disc's triangles may have all three on its rim -- the centre is
 *  still inside.) */
function offEdgePoint(body: Body, face: Face, onEdge: (p: Vec3) => boolean): Vec3 | null {
  const { indices, faceIds } = body.mesh;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face.id) continue;
    const v = [0, 1, 2].map((k) => vtx(body, indices[t * 3 + k]!));
    if (v.filter(onEdge).length < 2) continue;
    const c = scale(add(add(v[0]!, v[1]!), v[2]!), 1 / 3);
    if (!onEdge(c)) return c;
  }
  return null;
}

/** Outward normal of a round face at a point on it (from the render mesh). */
function cylOutwardSign(body: Body, face: Face, radial: (p: Vec3) => Vec3): number {
  const { indices, faceIds, normals } = body.mesh;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face.id) continue;
    const i = indices[t * 3]!;
    const n = { x: normals[i * 3]!, y: normals[i * 3 + 1]!, z: normals[i * 3 + 2]! };
    return Math.sign(dot(n, radial(vtx(body, i)))) || 1;
  }
  return 1;
}

export interface BlendTool {
  body: Body;
  /** true = cut (outside edge), false = add (inside edge). */
  cut: boolean;
}

/** The tool for one edge. `first` = which face the chamfer's first distance
 *  / angle is on (ref.faces[0]). */
function edgeTool(e: BlendEdge, first: Face, f: EdgeFeature, v: { d1: number; d2: number }, tag: string): BlendTool | string {
  const tol = modelTol(e.body) * 10;
  const [fa, fb] = first === e.faceB ? [e.faceB, e.faceA] : [e.faceA, e.faceB];
  const margin = Math.max(v.d1, v.d2) * 0.5 + 0.2;
  const g = e.edge.geom;

  if (g.kind === "line") {
    const dir = normalize(sub(g.b, g.a));
    const onEdge = (p: Vec3): boolean => {
      const d = sub(p, g.a);
      return length(sub(d, scale(dir, dot(d, dir)))) <= tol;
    };
    const flatten = (w: Vec3): Vec3 => normalize(sub(w, scale(dir, dot(w, dir))));
    const pa = offEdgePoint(e.body, fa, onEdge);
    const pb = offEdgePoint(e.body, fb, onEdge);
    if (pa === null || pb === null) return "Can't tell the sides of this edge";
    const wa = sub(pa, g.a);
    const wb = sub(pb, g.a);
    const u = flatten(wa);
    const vv = cross(dir, u);
    const to2 = (w: Vec3): Point => p2(dot(w, u), dot(w, vv));
    if (fa.geom.kind !== "plane" || fb.geom.kind !== "plane") return "Not a corner between two flat faces";
    const c: Corner = { tA: p2(1, 0), tB: norm2(to2(flatten(wb))), nA: norm2(to2(fa.geom.normal)), nB: norm2(to2(fb.geom.normal)), convex: false };
    c.convex = dot2(c.tA, c.nB) < 0;
    const section = cornerSection(c, { type: f.type, ...v }, margin);
    if (typeof section === "string") return section;
    const len = length(sub(g.b, g.a));
    // An outside edge's cut runs a little past its ends (clean corners into
    // air); an inside edge's added material stops exactly at them.
    const ext = c.convex ? margin : 0;
    const body = extrudeRegions(`${f.id}.${tag}`, [regionFromSegments(section)], { origin: g.a, u, v: vv, n: dir }, -ext, len + ext);
    return { body, cut: c.convex };
  }

  if (g.kind === "arc") {
    const plane = e.faceA.geom.kind === "plane" ? e.faceA : e.faceB;
    const cyl = plane === e.faceA ? e.faceB : e.faceA;
    if (plane.geom.kind !== "plane" || cyl.geom.kind !== "cylinder") return "Not a round face meeting a flat one";
    const R = g.radius;
    const z = normalize(plane.geom.normal);
    const O = g.center;
    const radialOf = (p: Vec3): Vec3 => {
      const d = sub(p, O);
      return normalize(sub(d, scale(z, dot(d, z))));
    };
    const rOf = (p: Vec3): number => {
      const d = sub(p, O);
      return length(sub(d, scale(z, dot(d, z))));
    };
    const onEdge = (p: Vec3): boolean => Math.abs(dot(sub(p, O), z)) <= tol && Math.abs(rOf(p) - R) <= tol + R * 1e-6;
    const offPlane = offEdgePoint(e.body, plane, onEdge);
    const offCyl = offEdgePoint(e.body, cyl, onEdge);
    if (offPlane === null || offCyl === null) return "Can't tell the sides of this edge";
    // (r - R, z) coordinates in the half-plane through the axis.
    const planeSide = Math.sign(rOf(offPlane) - R) || 1;
    const cylSide = Math.sign(dot(sub(offCyl, O), z)) || 1;
    const cylOut = cylOutwardSign(e.body, cyl, radialOf);
    const P = { t: p2(planeSide, 0), n: p2(0, 1) };
    const C = { t: p2(0, cylSide), n: p2(cylOut, 0) };
    const [A, B] = fa === plane ? [P, C] : [C, P];
    const c: Corner = { tA: A.t, tB: B.t, nA: A.n, nB: B.n, convex: dot2(A.t, B.n) < 0 };
    const section = cornerSection(c, { type: f.type, ...v }, Math.min(margin, R * 0.4));
    if (typeof section === "string") return section;
    const loop = regionFromSegments(section).outer;
    const pts: RZ[] = loop.polygon.map((q) => ({ r: R + q.x, z: q.y }));
    if (pts.some((q) => !(q.r > 0))) return "Too big for this round edge";
    // The fillet arc's samples make ONE face: a torus (no seams drawn across it).
    const groups: FaceGroup[] = [];
    loop.segments.forEach((sg, k) => {
      if (sg.kind !== "arc") return;
      const from = loop.segmentStart[k]!;
      const to = k + 1 < loop.segments.length ? loop.segmentStart[k + 1]! : loop.polygon.length;
      groups.push({ from, to, geom: { kind: "torus", center: add(O, scale(z, sg.c.y)), axis: z, major: R + sg.c.x, minor: sg.r } });
    });
    const body = revolveProfile(`${f.id}.${tag}`, "0", [...pts, pts[0]!], { origin: O, dir: z }, groups);
    return { body, cut: c.convex };
  }
  return "Unsupported edge";
}

/** Evaluated sizes: d1 on the first face, d2 on the second (fillet: both = radius). */
export function blendSizes(f: EdgeFeature, params: ReadonlyMap<string, number>, alpha?: number): { d1: number; d2: number } | string {
  const size = evalExpression(f.size, params);
  if (size === null || !(size > 0)) return `${f.type === "fillet" ? "Radius" : "Distance"} must be a positive number`;
  if (f.type === "fillet" || (f.mode ?? "equal") === "equal") return { d1: size, d2: size };
  if (f.mode === "two") {
    const d2 = evalExpression(f.size2 ?? "", params);
    if (d2 === null || !(d2 > 0)) return "Distance 2 must be a positive number";
    return { d1: size, d2 };
  }
  const angle = evalExpression(f.angle ?? "", params);
  if (angle === null || !(angle > 0 && angle < 180)) return "Angle must be between 0 and 180";
  const a = alpha ?? Math.PI / 2; // angle between the faces
  const th = (angle * Math.PI) / 180;
  if (a + th >= Math.PI) return "Angle too large for this corner";
  return { d1: size, d2: (size * Math.sin(th)) / Math.sin(Math.PI - a - th) };
}

/** Tools for every edge of the feature, found on `bodies`; or an error. */
export function edgeTools(f: EdgeFeature, bodies: readonly Body[], params: ReadonlyMap<string, number>): BlendTool[] | string {
  if (f.edges.length === 0) return "No edges picked";
  const perBody = new Map<Body, BlendEdge[]>();
  const all = (): BlendEdge[] => bodies.flatMap((b) => {
    let list = perBody.get(b);
    if (list === undefined) {
      list = blendEdges(b);
      perBody.set(b, list);
    }
    return list;
  });
  const edges = all();
  const tools: BlendTool[] = [];
  for (const [i, ref] of f.edges.entries()) {
    const e = resolveEdgeRef(edges, ref);
    if (e === null) return `Edge ${i + 1} is no longer there`;
    const first = faceHasRef(e.faceA, ref.faces[0]) ? e.faceA : e.faceB;
    const alpha = e.kind === "line" && e.faceA.geom.kind === "plane" && e.faceB.geom.kind === "plane"
      ? Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(normalize(e.faceA.geom.normal), normalize(e.faceB.geom.normal)))))
      : Math.PI / 2;
    const v = blendSizes(f, params, alpha);
    if (typeof v === "string") return v;
    const t = edgeTool(e, first, f, v, `${i}`);
    if (typeof t === "string") return `Edge ${i + 1}: ${t}`;
    tools.push(t);
  }
  return tools;
}
