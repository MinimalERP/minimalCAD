/**
 * MinimalCAD Web
 * part/faceTopology.ts
 *
 * The edges that lie ON a flat face (its own boundary and holes), in the
 * face's plane coordinates -- for osnaps and edge picking on that face only,
 * so hidden edges of other parts never pull the cursor.
 */

import type { Point } from "../core/types";
import type { Body, Edge } from "./kernel/types";
import type { Frame } from "./plane";
import type { Vec3 } from "./vec3";
import { cross, dot, length, normalize, sub } from "./vec3";

export interface FaceSnap {
  point: Point;
  kind: "endpoint" | "midpoint" | "center";
}

export interface FaceEdges {
  lines: [Point, Point][];
  circles: { center: Point; radius: number }[];
  snaps: FaceSnap[];
}

function onPlane(frame: Frame, p: Vec3, tol: number): boolean {
  return Math.abs(dot(sub(p, frame.origin), frame.n)) <= tol;
}

function toFace(frame: Frame, p: Vec3): Point {
  const d = sub(p, frame.origin);
  return { x: dot(d, frame.u), y: dot(d, frame.v) };
}

function arcEnd(g: Extract<Edge["geom"], { kind: "arc" }>): Vec3 {
  const e1 = normalize(sub(g.start, g.center));
  const e2 = cross(normalize(g.normal), e1);
  const c = Math.cos(g.sweep);
  const s = Math.sin(g.sweep);
  return {
    x: g.center.x + g.radius * (e1.x * c + e2.x * s),
    y: g.center.y + g.radius * (e1.y * c + e2.y * s),
    z: g.center.z + g.radius * (e1.z * c + e2.z * s),
  };
}

/** Edges of `body` lying in `frame`'s plane, as face coordinates. */
export function edgesOnFace(body: Body, frame: Frame): FaceEdges {
  let size = 1;
  const p = body.mesh.positions;
  for (let i = 0; i < p.length; i++) size = Math.max(size, Math.abs(p[i]!));
  const tol = size * 1e-7;

  const out: FaceEdges = { lines: [], circles: [], snaps: [] };
  for (const e of body.edges) {
    const g = e.geom;
    if (g.kind === "line") {
      if (!onPlane(frame, g.a, tol) || !onPlane(frame, g.b, tol)) continue;
      const a = toFace(frame, g.a);
      const b = toFace(frame, g.b);
      out.lines.push([a, b]);
      out.snaps.push({ point: a, kind: "endpoint" }, { point: b, kind: "endpoint" });
      out.snaps.push({ point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: "midpoint" });
    } else if (g.kind === "arc") {
      // Only circles lying flat in the face (normal along the face normal).
      if (!onPlane(frame, g.center, tol) || length(cross(normalize(g.normal), frame.n)) > 1e-6) continue;
      const c = toFace(frame, g.center);
      out.circles.push({ center: c, radius: g.radius });
      out.snaps.push({ point: c, kind: "center" });
      if (Math.abs(Math.abs(g.sweep) - 2 * Math.PI) > 1e-9) {
        out.snaps.push({ point: toFace(frame, g.start), kind: "endpoint" }, { point: toFace(frame, arcEnd(g)), kind: "endpoint" });
      }
    } else if (g.pts.every((q) => onPlane(frame, q, tol))) {
      const pts = g.pts.map((q) => toFace(frame, q));
      out.snaps.push({ point: pts[0]!, kind: "endpoint" }, { point: pts[pts.length - 1]!, kind: "endpoint" });
    }
  }
  return out;
}
