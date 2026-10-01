/**
 * MinimalCAD Web
 * part/sketchRefs.ts
 *
 * Lets a sketch constraint measure from the SOLID and keep doing so as the
 * solid changes. The reference geometry behind a sketch is the solid's
 * edges projected onto its plane (part/project.ts); a constraint made
 * against one remembers WHICH edge it was -- the faces it runs between,
 * which survive rebuilds -- and this module finds that edge's projection
 * again in the model as it is now.
 */

import type { Point } from "../core/types";
import type { Constraint } from "../core/constraints";
import { isDrivable } from "../core/constraints";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Ellipse } from "../entities/ellipse";
import type { Face, TopoRef } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import type { Projected } from "./project";
import { edgeFaceIds, modelTol } from "./edgeBlend";
import { add, scale } from "./vec3";

/** Which edge of the solid a piece of reference geometry is. */
export interface ModelEdgeRef {
  /** The faces the edge runs between (one, for a round face's outline). */
  faces: TopoRef[];
  /** A round face's side outline, not an edge. */
  outline?: true;
}

const facesCache = new WeakMap<Projected, Face[]>();

/** The faces meeting along a projected entity's source edge. */
function facesOf(p: Projected): Face[] {
  const cached = facesCache.get(p);
  if (cached !== undefined) return cached;
  let faces: Face[] = [];
  if (p.face !== null) faces = [p.face];
  else if (p.edge !== null) {
    const g = p.edge.geom;
    const probe = g.kind === "line" ? scale(add(g.a, g.b), 0.5) : g.kind === "arc" ? g.start : g.pts.length >= 2 ? scale(add(g.pts[0]!, g.pts[1]!), 0.5) : g.pts[0];
    if (probe !== undefined) faces = edgeFaceIds(p.body, probe, modelTol(p.body)).map((i) => p.body.faces[i]!);
  }
  facesCache.set(p, faces);
  return faces;
}

/** What to remember about reference geometry `p` so it can be found again. */
export function modelEdgeRef(p: Projected): ModelEdgeRef | null {
  const faces = facesOf(p);
  if (faces.length === 0) return null;
  return p.face !== null ? { faces: [p.face.ref], outline: true } : { faces: faces.map((f) => f.ref) };
}

function isModelEdgeRef(v: unknown): v is ModelEdgeRef {
  return typeof v === "object" && v !== null && Array.isArray((v as ModelEdgeRef).faces);
}

/** Where an entity "is", for telling apart several edges between the same faces. */
function anchor(e: Entity): Point | null {
  if (e instanceof Line) return e.midpoint();
  if (e instanceof Circle || e instanceof Arc || e instanceof Ellipse) return e.center;
  return null;
}

/**
 * Document.modelRef for a sketch whose reference geometry is `projected`:
 * given a constraint, the reference entity it means, as the solid is now.
 * Null if that edge is gone (the caller falls back to where it used to be).
 */
export function modelRefResolver(projected: readonly Projected[]): (constraint: unknown) => Entity | null {
  return (constraint) => {
    const c = constraint as Constraint;
    const ref = c.ref_model;
    if (!isModelEdgeRef(ref) || ref.faces.length === 0) return null;
    const g = c.ref_geom;
    const was: Point | null = g === undefined ? null : "p" in g ? g.p : { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    // A coincident point is on a line's end, so the stored point isn't the line's middle: don't sort by it.
    const byNearness = g !== undefined && !("p" in g && c.kind === "coincident");
    const candidates = projected
      .filter((p) => isDrivable(p.entity) && (ref.outline === true) === (p.face !== null))
      .map((p) => {
        const a = anchor(p.entity);
        return { p, d: byNearness && was !== null && a !== null ? Math.hypot(a.x - was.x, a.y - was.y) : 0 };
      })
      .sort((x, y) => x.d - y.d);
    let best: { p: Projected; d: number } | null = null;
    for (const cand of candidates) {
      const faces = facesOf(cand.p);
      if (!ref.faces.every((r) => faces.some((f) => faceHasRef(f, r)))) continue;
      if (byNearness) return cand.p.entity; // sorted: the nearest match
      // Coincident: the matching edge with a point nearest the stored one.
      const e = cand.p.entity;
      const pts = e instanceof Line ? [e.startPoint, e.endPoint, e.midpoint()] : [anchor(e)!];
      const d = was === null ? 0 : Math.min(...pts.map((q) => Math.hypot(q.x - was.x, q.y - was.y)));
      if (best === null || d < best.d) best = { p: cand.p, d };
    }
    return best?.p.entity ?? null;
  };
}
