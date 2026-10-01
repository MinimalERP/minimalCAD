/**
 * MinimalCAD Web
 * part/pattern.ts
 *
 * Pattern / Mirror: repeats earlier features by re-applying their own tool
 * solids (the block an Extrude adds, the drill a Hole cuts with...) moved
 * to each new place -- in rows and columns, round an axis, or reflected in
 * a plane. Because the tools are repeated (not the finished shape), a
 * patterned hole is a real hole wherever it lands, and everything follows
 * when the original feature is edited.
 */

import type { Body, Edge, Face, FaceGeom, TopoRef } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import type { Frame } from "./plane";
import { evalExpression } from "./params";
import type { FeatureOperation, PatternAxis, PatternFeature } from "./types";
import type { Vec3 } from "./vec3";
import { add, cross, dot, normalize, scale, sub } from "./vec3";

/** A feature's tool solid and how it was applied. */
export interface MadeTool {
  tool: Body;
  op: FeatureOperation;
}

/** A rigid move, or a reflection. */
export interface Transform {
  point(p: Vec3): Vec3;
  dir(v: Vec3): Vec3;
  mirror: boolean;
}

const AXES: Record<PatternAxis, Vec3> = { X: { x: 1, y: 0, z: 0 }, Y: { x: 0, y: 1, z: 0 }, Z: { x: 0, y: 0, z: 1 } };

export function translation(d: Vec3): Transform {
  return { point: (p) => add(p, d), dir: (v) => v, mirror: false };
}

/** Right-handed turn of `angle` radians about the axis through `o` along unit `k`. */
export function rotation(o: Vec3, k: Vec3, angle: number): Transform {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dir = (v: Vec3): Vec3 => add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
  return { point: (p) => add(o, dir(sub(p, o))), dir, mirror: false };
}

/** Reflection in the plane through `o` with unit normal `n`. */
export function reflection(o: Vec3, n: Vec3): Transform {
  const dir = (v: Vec3): Vec3 => sub(v, scale(n, 2 * dot(v, n)));
  return { point: (p) => add(o, dir(sub(p, o))), dir, mirror: true };
}

function moveGeom(g: FaceGeom, t: Transform): FaceGeom {
  if (g.kind === "plane") return { kind: "plane", origin: t.point(g.origin), normal: t.dir(g.normal) };
  if (g.kind === "cylinder") return { kind: "cylinder", axisOrigin: t.point(g.axisOrigin), axis: t.dir(g.axis), radius: g.radius };
  if (g.kind === "cone") return { kind: "cone", apex: t.point(g.apex), axis: t.dir(g.axis), halfAngle: g.halfAngle };
  if (g.kind === "torus") return { kind: "torus", center: t.point(g.center), axis: t.dir(g.axis), major: g.major, minor: g.minor };
  return g;
}

function moveEdge(g: Edge["geom"], t: Transform): Edge["geom"] {
  if (g.kind === "line") return { kind: "line", a: t.point(g.a), b: t.point(g.b) };
  if (g.kind === "polyline") return { kind: "polyline", pts: g.pts.map(t.point) };
  // A reflection reverses the way an arc turns about its (reflected) normal.
  return { kind: "arc", center: t.point(g.center), normal: t.dir(g.normal), radius: g.radius, start: t.point(g.start), sweep: t.mirror ? -g.sweep : g.sweep };
}

/**
 * `body` moved by `t`, as a body of feature `feature`. Its faces get refs of
 * their own (`tag` + the source face's), so later features can pick a
 * patterned face and find it again after a rebuild.
 */
export function transformBody(body: Body, t: Transform, id: string, feature: string, tag: string): Body {
  const { positions: p, normals: n, indices, faceIds } = body.mesh;
  const positions = new Float64Array(p.length);
  const normals = new Float64Array(n.length);
  for (let i = 0; i < p.length; i += 3) {
    const q = t.point({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! });
    const m = t.dir({ x: n[i]!, y: n[i + 1]!, z: n[i + 2]! });
    positions.set([q.x, q.y, q.z], i);
    normals.set([m.x, m.y, m.z], i);
  }
  const idx = new Uint32Array(indices);
  // A reflection turns every triangle inside out: wind them back.
  if (t.mirror) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2]!, idx[i + 1]!];
  const ref = (r: TopoRef): TopoRef => ({ feature, role: r.role, index: `${tag}:${r.feature}:${r.index}` });
  const faces: Face[] = body.faces.map((f) => ({ id: f.id, ref: ref(f.ref), geom: moveGeom(f.geom, t) }));
  const edges: Edge[] = body.edges.map((e) => ({ ref: ref(e.ref), geom: moveEdge(e.geom, t) }));
  return { id, feature, mesh: { positions, normals, indices: idx, faceIds: new Uint32Array(faceIds) }, faces, edges };
}

export interface PatternEnv {
  params: ReadonlyMap<string, number>;
  bodies: readonly Body[];
  /** Frame of an origin plane / work plane by name, or null. */
  plane(key: string): Frame | null;
}

/** The axis of a round face (by ref) among `bodies`. */
function roundFaceAxis(bodies: readonly Body[], ref: TopoRef): { o: Vec3; k: Vec3 } | null {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, ref));
    if (face === undefined) continue;
    if (face.geom.kind === "cylinder") return { o: face.geom.axisOrigin, k: normalize(face.geom.axis) };
    if (face.geom.kind === "cone") return { o: face.geom.apex, k: normalize(face.geom.axis) };
    return null;
  }
  return null;
}

function flatFace(bodies: readonly Body[], ref: TopoRef): { o: Vec3; n: Vec3 } | null {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, ref));
    if (face?.geom.kind === "plane") return { o: face.geom.origin, n: normalize(face.geom.normal) };
  }
  return null;
}

/**
 * Where a pattern puts its copies (the original is not included), or why it
 * can't be worked out.
 */
export function patternTransforms(f: PatternFeature, env: PatternEnv): Transform[] | string {
  const num = (e: string | undefined, what: string): number | string => {
    const v = e === undefined ? null : evalExpression(e, env.params);
    return v === null ? `Invalid ${what}` : v;
  };
  const count = (e: string | undefined, what: string): number | string => {
    const v = num(e, what);
    if (typeof v === "string") return v;
    if (!Number.isInteger(v) || v < 1 || v > 200) return `${what[0]!.toUpperCase()}${what.slice(1)} must be a whole number from 1 to 200`;
    return v;
  };

  if (f.kind === "mirror") {
    let plane: { o: Vec3; n: Vec3 } | null = null;
    if (f.planeFace !== undefined) plane = flatFace(env.bodies, f.planeFace);
    else if (f.plane !== undefined) {
      const frame = env.plane(f.plane);
      plane = frame === null ? null : { o: frame.origin, n: frame.n };
    }
    return plane === null ? "The mirror plane is missing - pick a plane or a flat face" : [reflection(plane.o, plane.n)];
  }

  if (f.kind === "circular") {
    const n = count(f.count1, "count");
    const total = num(f.angle ?? "360", "angle");
    if (typeof n === "string") return n;
    if (typeof total === "string") return total;
    if (!(Math.abs(total) > 0) || Math.abs(total) > 360) return "Angle must be between 0 and 360 (not 0)";
    const axis = f.axisFace !== undefined ? roundFaceAxis(env.bodies, f.axisFace) : { o: { x: 0, y: 0, z: 0 }, k: AXES[f.dir1 ?? "Z"] };
    if (axis === null) return "The round face this pattern turns about no longer exists";
    // A full turn spaces the copies evenly round; a part turn ends on the angle.
    const full = Math.abs(Math.abs(total) - 360) < 1e-9;
    const step = n === 1 ? 0 : ((total / (full ? n : n - 1)) * Math.PI) / 180;
    const out: Transform[] = [];
    for (let i = 1; i < n; i++) out.push(rotation(axis.o, axis.k, step * i));
    return out;
  }

  const n1 = count(f.count1, "count");
  const s1 = num(f.spacing1, "spacing");
  if (typeof n1 === "string") return n1;
  if (typeof s1 === "string") return s1;
  const second = f.dir2 !== undefined;
  const n2 = second ? count(f.count2, "second count") : 1;
  const s2 = second ? num(f.spacing2, "second spacing") : 0;
  if (typeof n2 === "string") return n2;
  if (typeof s2 === "string") return s2;
  if (n1 * n2 > 400) return "Too many copies (more than 400)";
  const d1 = AXES[f.dir1 ?? "X"];
  const d2 = AXES[f.dir2 ?? "Y"];
  const out: Transform[] = [];
  for (let j = 0; j < n2; j++) {
    for (let i = 0; i < n1; i++) {
      if (i === 0 && j === 0) continue;
      out.push(translation(add(scale(d1, s1 * i), scale(d2, s2 * j))));
    }
  }
  return out;
}

/** Every copy's tool solids: `sources` moved by each transform. */
export function patternTools(f: Pick<PatternFeature, "id">, sources: readonly MadeTool[], transforms: readonly Transform[]): MadeTool[] {
  const out: MadeTool[] = [];
  transforms.forEach((t, i) => {
    sources.forEach((s, k) => out.push({ tool: transformBody(s.tool, t, `${f.id}.${i}.${k}`, f.id, `${i}`), op: s.op }));
  });
  return out;
}
