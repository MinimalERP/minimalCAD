/**
 * MinimalCAD Web
 * part/workPlane.ts
 *
 * Work planes tied to the model: a plane hinged on a straight edge of a flat
 * face, tilted from that face by an angle (like a lid opening on the edge),
 * then offset along its own normal. Stored by reference (face + edge), so
 * it follows the model through rebuilds.
 */

import type { Body, Face } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import type { Frame } from "./plane";
import type { EdgeRef, FacePlaneRef, ModelPlaneRef, TangentPlaneRef } from "./types";
import { modelPlaneKind } from "./types";
import type { TopoRef } from "./kernel/types";
import { faceFrame, offsetFrame } from "./plane";
import { alongSurface, cylTo3d, roundFrame, surfaceNormal } from "./cylFrame";
import type { Vec3 } from "./vec3";
import { add, cross, dot, length, normalize, scale, sub } from "./vec3";
import { edgeFaceIds, modelTol } from "./edgeBlend";

/** A straight edge of a flat face a plane can hinge on. */
export interface HingeEdge {
  body: Body;
  face: Face;
  /** The face on the other side of the edge (null on an open edge). */
  other: Face | null;
  a: Vec3;
  b: Vec3;
}

/** Every straight edge bounding the flat face `face` of `body`. */
export function hingeEdges(body: Body, face: Face): HingeEdge[] {
  if (face.geom.kind !== "plane") return [];
  const tol = modelTol(body);
  const out: HingeEdge[] = [];
  for (const edge of body.edges) {
    const g = edge.geom;
    if (g.kind !== "line" || length(sub(g.b, g.a)) <= tol) continue;
    const ids = edgeFaceIds(body, scale(add(g.a, g.b), 0.5), tol);
    if (!ids.includes(face.id)) continue;
    const otherId = ids.find((i) => i !== face.id);
    out.push({ body, face, other: otherId === undefined ? null : body.faces[otherId]!, a: g.a, b: g.b });
  }
  return out;
}

export function hingeRef(e: HingeEdge): EdgeRef {
  return { faces: [e.face.ref, (e.other ?? e.face).ref], at: scale(add(e.a, e.b), 0.5) };
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return length(sub(p, add(a, scale(ab, t))));
}

/** The hinge `on` names among `bodies`, or why it can't be found. Prefers
 *  the edge shared with the same neighbouring face; else the nearest edge
 *  of the face to where the hinge was. */
export function resolveHinge(bodies: readonly Body[], on: FacePlaneRef): HingeEdge | string {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, on.face));
    if (face === undefined) continue;
    if (face.geom.kind !== "plane") return "The face this plane is on is no longer flat";
    const edges = hingeEdges(body, face);
    if (edges.length === 0) return "The face this plane is on has no straight edge left";
    const near = (list: HingeEdge[]): HingeEdge | undefined =>
      list.slice().sort((p, q) => distToSegment(on.hinge.at, p.a, p.b) - distToSegment(on.hinge.at, q.a, q.b))[0];
    const same = edges.filter((e) => e.other !== null && on.hinge.faces.some((r) => faceHasRef(e.other!, r) && !faceHasRef(face, r)));
    return near(same) ?? near(edges)!;
  }
  return "The face this plane is on no longer exists";
}

/** The round face `on` names among `bodies`, or why it can't be found. */
export function resolveRoundFace(bodies: readonly Body[], on: TangentPlaneRef): { body: Body; face: Face } | string {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, on.face));
    if (face === undefined) continue;
    return roundFrame(face.geom) !== null ? { body, face } : "The face this plane is on is no longer round";
  }
  return "The round face this plane is on no longer exists";
}

/**
 * The plane touching round face `face` (a cylinder or a cone) along one line, `angleDeg` round
 * its axis (0 = toward world +Z, or +X on a vertical shaft -- the same zero
 * radial holes use), moved `offset` out from the surface (negative = into
 * the part: a flat, a keyway seat). Its normal points out of the shaft; its
 * horizontal (u) runs along the axis, so distances along the shaft read
 * left to right; the origin is the world origin dropped onto the axis and
 * carried out to the plane. `centerAt` is the middle of the face's length,
 * on the plane (for display).
 */
export function tangentFrame(body: Body, face: Face, angleDeg: number, offset: number): { frame: Frame; centerAt: Vec3 } {
  const cyl = roundFrame(face.geom);
  if (cyl === null) throw new Error("tangentFrame needs a round face");
  const n = surfaceNormal(cyl, angleDeg);
  const u = alongSurface(cyl, angleDeg);
  const v = cross(n, u);
  // The face's own length along the axis (from the frame's origin), from its triangles.
  const { positions: p, indices, faceIds } = body.mesh;
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face.id) continue;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k]!;
      const along = dot(sub({ x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! }, cyl.origin), cyl.axis);
      lo = Math.min(lo, along);
      hi = Math.max(hi, along);
    }
  }
  const mid = Number.isFinite(lo) ? (lo + hi) / 2 : 0;
  const lift = scale(n, offset);
  if (cyl.slope !== 0) {
    // A cone: the plane touches it along a slant line (u), and every such
    // plane passes through the apex -- the origin, so distances up the cone
    // read from its tip.
    return { frame: { u, v, n, origin: add(cyl.origin, lift) }, centerAt: add(cylTo3d(cyl, { x: mid, y: angleDeg }), lift) };
  }
  const onAxis = add(cyl.origin, scale(u, dot(scale(cyl.origin, -1), u)));
  const out = scale(n, cyl.radius + offset);
  const middle = Number.isFinite(lo) ? add(cyl.origin, scale(u, mid)) : onAxis;
  return { frame: { u, v, n, origin: add(onAxis, out) }, centerAt: add(middle, out) };
}

/** Rodrigues rotation of `p` about unit axis `k` by `angle` radians. */
function rotate(p: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(p, c), scale(cross(k, p), s)), scale(k, dot(k, p) * (1 - c)));
}

/**
 * The plane hinged on `e`, tilted `angleDeg` from its face and moved
 * `offset` along its own normal. At 0 degrees it IS the face's plane
 * (normal outward); a positive angle lifts the side lying over the face
 * away from it. Its horizontal (u) runs along the hinge, its vertical (v)
 * starts out pointing into the face; the origin is the world origin
 * dropped onto the hinge line, so sketch coordinates line up with the
 * model's along the edge. `hingeAt` is the hinge's middle (for display).
 */
export function hingedFrame(e: HingeEdge, angleDeg: number, offset: number): { frame: Frame; hingeAt: Vec3 } {
  const nF = normalize(e.face.geom.kind === "plane" ? e.face.geom.normal : { x: 0, y: 0, z: 1 });
  const dir = normalize(sub(e.b, e.a));
  // Into the face from the hinge: toward the face's own triangles.
  const { positions: p, indices, faceIds } = e.body.mesh;
  let c = { x: 0, y: 0, z: 0 };
  let count = 0;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== e.face.id) continue;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k]!;
      c = add(c, { x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! });
      count++;
    }
  }
  let inward = normalize(cross(nF, dir));
  if (count > 0 && dot(inward, sub(scale(c, 1 / count), e.a)) < 0) inward = scale(inward, -1);
  const u = cross(inward, nF); // along the hinge, so that u x inward = nF
  const a = (angleDeg * Math.PI) / 180;
  const v = rotate(inward, u, a);
  const n = rotate(nF, u, a);
  const onLine = add(e.a, scale(u, dot(scale(e.a, -1), u)));
  const lift = scale(n, offset);
  return { frame: { u, v, n, origin: add(onLine, lift) }, hingeAt: add(scale(add(e.a, e.b), 0.5), lift) };
}

/** Where a model plane ended up, plus how to draw it. */
export interface ModelPlane {
  frame: Frame;
  /** Hinged: the middle of the hinge edge (the square rises from it). */
  hingeAt?: Vec3;
  /** Otherwise: where the square is centred. */
  centerAt?: Vec3;
}

/** The middle of a face (mean of its triangles' corners). */
export function faceCentre(body: Body, face: Face): Vec3 {
  const { positions: p, indices, faceIds } = body.mesh;
  let c = { x: 0, y: 0, z: 0 };
  let n = 0;
  for (let t = 0; t < faceIds.length; t++) {
    if (faceIds[t] !== face.id) continue;
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k]!;
      c = add(c, { x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! });
      n++;
    }
  }
  return n === 0 ? c : scale(c, 1 / n);
}

/** The flat face `ref` names among `bodies`, or why it can't be found. */
export function resolveFlatFace(bodies: readonly Body[], ref: TopoRef): { body: Body; face: Face } | string {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, ref));
    if (face === undefined) continue;
    return face.geom.kind === "plane" ? { body, face } : "The face this plane is on is no longer flat";
  }
  return "The face this plane is on no longer exists";
}

/** Parallel to a flat face, `offset` out from it (negative = into the part).
 *  Oriented exactly like a sketch on that face. */
export function parallelFrame(body: Body, face: Face, offset: number): ModelPlane {
  if (face.geom.kind !== "plane") throw new Error("parallelFrame needs a flat face");
  const frame = offsetFrame(faceFrame(face.geom.origin, face.geom.normal), offset);
  return { frame, centerAt: add(faceCentre(body, face), scale(frame.n, offset)) };
}

/** Halfway between two parallel flat faces (facing the same way as the
 *  first), or why there is no such plane. */
export function midFrame(a: { body: Body; face: Face }, b: { body: Body; face: Face }, offset: number): ModelPlane | string {
  if (a.face.geom.kind !== "plane" || b.face.geom.kind !== "plane") return "Both faces must be flat";
  const n = normalize(a.face.geom.normal);
  if (length(cross(n, normalize(b.face.geom.normal))) > 1e-6) return "The two faces are not parallel";
  const gap = dot(sub(b.face.geom.origin, a.face.geom.origin), n);
  if (Math.abs(gap) < 1e-9) return "The two faces lie in the same plane";
  const frame = offsetFrame(faceFrame(a.face.geom.origin, n), gap / 2 + offset);
  const ca = faceCentre(a.body, a.face);
  return { frame, centerAt: add(ca, scale(n, gap / 2 + offset)) };
}

/** Through three points: horizontal from the first toward the second, the
 *  third on its upper side; origin at the first. */
export function pointsFrame(p: readonly [Vec3, Vec3, Vec3], offset: number): ModelPlane | string {
  const e1 = sub(p[1], p[0]);
  const normal = cross(e1, sub(p[2], p[0]));
  if (length(e1) < 1e-9 || length(normal) < 1e-9 * (1 + length(e1) ** 2)) return "The three points are in one line";
  const u = normalize(e1);
  const n = normalize(normal);
  const lift = scale(n, offset);
  const centre = scale(add(add(p[0], p[1]), p[2]), 1 / 3);
  return { frame: { u, v: cross(n, u), n, origin: add(p[0], lift) }, centerAt: add(centre, lift) };
}

/**
 * Any model plane against the solids as they stand: where it is, or why it
 * can't be made. `angle` is in degrees and only some kinds use it.
 */
export function modelPlane(on: ModelPlaneRef, bodies: readonly Body[], angle: number, offset: number): ModelPlane | string {
  const kind = modelPlaneKind(on);
  if (kind === "points") return pointsFrame((on as { points: [Vec3, Vec3, Vec3] }).points, offset);
  if (kind === "tangent") {
    const round = resolveRoundFace(bodies, on as TangentPlaneRef);
    return typeof round === "string" ? round : tangentFrame(round.body, round.face, angle, offset);
  }
  if (kind === "hinge") {
    const hinge = resolveHinge(bodies, on as FacePlaneRef);
    return typeof hinge === "string" ? hinge : hingedFrame(hinge, angle, offset);
  }
  const first = resolveFlatFace(bodies, (on as { face: TopoRef }).face);
  if (typeof first === "string") return first;
  if (kind === "parallel") return parallelFrame(first.body, first.face, offset);
  const second = resolveFlatFace(bodies, (on as { face2: TopoRef }).face2);
  return typeof second === "string" ? second : midFrame(first, second, offset);
}
