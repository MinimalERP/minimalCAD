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

/** Which bodies a Rotate turns. */
export function rotateTargets(f: Pick<RotateFeature, "bodies">, bodies: readonly Body[]): Body[] {
  if (f.bodies === undefined) return bodies.slice();
  return bodies.filter((b) => f.bodies!.includes(b.feature));
}

/**
 * Applies a Rotate (in place): the chosen bodies are turned, and so are the
 * remembered tool solids of the features that made them -- so a later
 * Pattern of those features repeats them where they now are.
 */
export function applyRotate(
  f: RotateFeature,
  bodies: Body[],
  made: Map<string, MadeTool[]>,
  params: ReadonlyMap<string, number>,
): { ok: boolean; error?: string } {
  const t = rotateTransform(f, bodies, params);
  if (typeof t === "string") return { ok: false, error: t };
  const targets = rotateTargets(f, bodies);
  if (targets.length === 0) return { ok: false, error: "No bodies to rotate - the picked solids are gone" };
  for (const b of targets) bodies[bodies.indexOf(b)] = moveBody(b, t);
  const all = f.bodies === undefined;
  for (const [id, tools] of made) {
    if (all || f.bodies!.includes(id)) made.set(id, tools.map((m) => ({ op: m.op, tool: moveBody(m.tool, t) })));
  }
  return { ok: true };
}

