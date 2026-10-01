/**
 * MinimalCAD Web
 * drawing/section.ts
 *
 * Section views, and keeping annotations with their view.
 *
 * A section view shows the part cut by a plane square to the view's own
 * direction: everything nearer the viewer than the plane is removed, and
 * the faces the cut makes are hatched. The cut is a real boolean (the
 * part minus a big block), so the view is then projected like any other.
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import { Dimension } from "../entities/dimension";
import type { Body } from "../part/kernel/types";
import { faceHasRef } from "../part/kernel/types";
import { extrudeRegions } from "../part/kernel/extrude";
import { bodyBounds } from "../part/kernel/brep";
import { regionFromSegments } from "../part/profile";
import { applyOperation } from "../part/rebuild";
import type { Vec3 } from "../part/vec3";
import { dot, sub } from "../part/vec3";
import type { ViewAxes } from "./hlr";

/** Feature name of the block a section cuts with: the cut faces carry it. */
export const SECTION_FEATURE = "§section";

/** `bodies` with everything in front of the plane through `at` (towards the
 *  viewer, along axes.dir) cut away. */
export function sectionBodies(bodies: readonly Body[], at: Vec3, axes: ViewAxes): Body[] {
  if (bodies.length === 0) return [];
  // A block big enough to swallow the whole model, its back face on the plane.
  let reach = 1;
  for (const b of bodies) {
    const { min, max } = bodyBounds(b);
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) reach = Math.max(reach, Math.hypot(x - at.x, y - at.y, z - at.z));
  }
  const s = reach * 1.5 + 1;
  const sq = [
    { x: -s, y: -s },
    { x: s, y: -s },
    { x: s, y: s },
    { x: -s, y: s },
  ];
  const region = regionFromSegments(sq.map((a, i) => ({ kind: "line" as const, a, b: sq[(i + 1) % 4]! })));
  const tool = extrudeRegions(SECTION_FEATURE, [region], { origin: at, u: axes.right, v: axes.up, n: axes.dir }, 0, 2 * s);
  const out = bodies.slice();
  applyOperation(out, tool, "cut");
  return out;
}

/**
 * Hatch lines over the cut faces, in the view's own 2D (model units; x
 * along axes.right, y along axes.up): 45 degree lines `spacing` apart,
 * clipped to the faces the section block made.
 */
export function sectionHatch(cut: readonly Body[], axes: ViewAxes, spacing: number): [Point, Point][] {
  const tris: [Point, Point, Point][] = [];
  const cap = { feature: SECTION_FEATURE, role: "start" as const, index: "0" };
  for (const body of cut) {
    const ids = new Set(body.faces.filter((f) => faceHasRef(f, cap)).map((f) => f.id));
    if (ids.size === 0) continue;
    const { positions: p, indices, faceIds } = body.mesh;
    const at = (i: number): Point => {
      const v = { x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! };
      return { x: dot(v, axes.right), y: dot(v, axes.up) };
    };
    for (let t = 0; t < faceIds.length; t++) {
      if (ids.has(faceIds[t]!)) tris.push([at(indices[t * 3]!), at(indices[t * 3 + 1]!), at(indices[t * 3 + 2]!)]);
    }
  }
  if (tris.length === 0 || !(spacing > 0)) return [];
  // Lines run along d; c = p . n picks the line.
  const d = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const n = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of tris) {
    for (const q of t) {
      const c = q.x * n.x + q.y * n.y;
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
  }
  const out: [Point, Point][] = [];
  const eps = (hi - lo) * 1e-9 + 1e-12;
  for (let k = Math.ceil(lo / spacing); k * spacing <= hi; k++) {
    const c = k * spacing;
    // Where this line is inside each triangle, as [from, to] along d.
    const spans: [number, number][] = [];
    for (const t of tris) {
      const hits: number[] = [];
      for (let e = 0; e < 3; e++) {
        const a = t[e]!;
        const b = t[(e + 1) % 3]!;
        const ca = a.x * n.x + a.y * n.y - c;
        const cb = b.x * n.x + b.y * n.y - c;
        if (ca > 0 === cb > 0) continue;
        const f = ca / (ca - cb);
        hits.push((a.x + (b.x - a.x) * f) * d.x + (a.y + (b.y - a.y) * f) * d.y);
      }
      if (hits.length >= 2) spans.push([Math.min(...hits), Math.max(...hits)]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let cur: [number, number] | null = null;
    const flush = (): void => {
      if (cur !== null && cur[1] - cur[0] > eps) {
        out.push([
          { x: n.x * c + d.x * cur[0], y: n.y * c + d.y * cur[0] },
          { x: n.x * c + d.x * cur[1], y: n.y * c + d.y * cur[1] },
        ]);
      }
    };
    for (const s of spans) {
      if (cur !== null && s[0] <= cur[1] + eps) cur[1] = Math.max(cur[1], s[1]);
      else {
        flush();
        cur = [s[0], s[1]];
      }
    }
    flush();
  }
  return out;
}

/** "A", "B", ... the first letter no section on the sheet uses yet. */
export function nextSectionName(used: readonly string[]): string {
  for (let i = 0; i < 26; i++) {
    const name = String.fromCharCode(65 + i);
    if (!used.includes(name)) return name;
  }
  return `S${used.length + 1}`;
}

/** The distance of point `p` in front of (+) the section plane. */
export function inFrontOf(p: Vec3, at: Vec3, axes: ViewAxes): number {
  return dot(sub(p, at), axes.dir);
}

// --- Annotations follow their view ---

interface ViewBox {
  id: string;
  box: readonly [number, number, number, number];
}
interface Placed {
  id: string;
  x: number;
  y: number;
  scale: number;
}

function isPoint(v: unknown): v is Point {
  return typeof v === "object" && v !== null && typeof (v as Point).x === "number" && typeof (v as Point).y === "number";
}

/** The point an annotation belongs to its view by: what a dimension
 *  measures from; otherwise the middle of the entity. */
function anchorOf(e: Entity): Point {
  if (e instanceof Dimension) {
    for (const key of ["p1", "center", "vertex", "radius_point", "point", "line1_p1"]) if (isPoint(e.data[key])) return e.data[key] as Point;
  }
  const [x0, y0, x1, y1] = e.getBounds();
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

/**
 * Keeps the sheet's annotations with their views when views are moved,
 * rescaled or deleted. `boxes` are the views' boxes as drawn BEFORE the
 * change (world coords); an annotation belongs to the smallest view whose
 * box holds its anchor. A moved view's annotations move with it; a
 * rescaled view's are scaled about its centre, and its dimensions go on
 * measuring the part; a deleted view's dimensions go with it. Annotations
 * on no view are left alone. Returns the entities to keep.
 */
export function carryAnnotations(entities: readonly Entity[], boxes: readonly ViewBox[], before: readonly Placed[], after: readonly Placed[]): Entity[] {
  const keep: Entity[] = [];
  for (const e of entities) {
    const a = anchorOf(e);
    let owner: ViewBox | null = null;
    let area = Infinity;
    for (const v of boxes) {
      const [x0, y0, x1, y1] = v.box;
      if (a.x < x0 - 1 || a.x > x1 + 1 || a.y < y0 - 1 || a.y > y1 + 1) continue;
      const size = (x1 - x0) * (y1 - y0);
      if (size < area) {
        area = size;
        owner = v;
      }
    }
    const was = owner === null ? undefined : before.find((v) => v.id === owner!.id);
    if (was === undefined) {
      keep.push(e);
      continue;
    }
    const now = after.find((v) => v.id === was.id);
    if (now === undefined) {
      if (!(e instanceof Dimension)) keep.push(e); // a deleted view takes its dimensions; plain lines / notes stay
      continue;
    }
    keep.push(e);
    const f = now.scale / was.scale;
    // World is Y-down: a view's paper centre (x, y) is world (x, -y).
    const map = (p: Point): Point => ({ x: now.x + (p.x - was.x) * f, y: -now.y + (p.y + was.y) * f });
    if (f === 1 && now.x === was.x && now.y === was.y) continue;
    if (e instanceof Dimension) {
      for (const [key, value] of Object.entries(e.data)) if (isPoint(value)) e.data[key] = map(value);
      e.data.measure_scale = 1 / now.scale;
    } else {
      const to = map(a);
      e.move(to.x - a.x, to.y - a.y);
    }
  }
  return keep;
}
