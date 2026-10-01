/**
 * MinimalCAD Web
 * core/sizeLabels.ts
 *
 * An entity's OWN sizes, shown on it as soon as it is drawn and editable in
 * place: a Line's length, a Circle's diameter, an Arc's radius, a
 * rectangle's width and height. (Where the entity sits relative to others is a separate matter --
 * distance constraints, core/constraints.ts -- placed by hand.)
 *
 * Pure geometry here; ui/canvasView.ts draws the labels and routes a
 * double-click on one to commands/editValue.ts.
 */

import type { Point } from "./types";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Polyline } from "../entities/polyline";

export type SizeKey = "length" | "diameter" | "radius" | "width" | "height";

export interface SizeLabel {
  key: SizeKey;
  value: number;
  /** Shown before the number, e.g. the diameter sign. */
  prefix: string;
  /** What it is called in prompts. */
  name: string;
  /** World point the label hangs off... */
  anchor: Point;
  /** ...and the unit world direction it is pushed away along (off the geometry). */
  away: Point;
}

const unit = (x: number, y: number): Point => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The four corners of `p` if it is a rectangle (closed, four straight
 *  sides, square corners -- at any rotation), else null. */
export function rectangleCorners(p: Polyline): [Point, Point, Point, Point] | null {
  if (!p.closed || p.vertices.length !== 4 || p.vertices.some((v) => v.bulge !== 0)) return null;
  const [a, b, c, d] = p.vertices.map((v) => v.point) as [Point, Point, Point, Point];
  const e1 = { x: b.x - a.x, y: b.y - a.y };
  const e2 = { x: d.x - a.x, y: d.y - a.y };
  const l1 = Math.hypot(e1.x, e1.y);
  const l2 = Math.hypot(e2.x, e2.y);
  if (l1 === 0 || l2 === 0) return null;
  const tol = 1e-6 * (l1 + l2);
  if (Math.abs(e1.x * e2.x + e1.y * e2.y) > tol * Math.max(l1, l2)) return null; // corner at `a` not square
  if (Math.hypot(a.x + e1.x + e2.x - c.x, a.y + e1.y + e2.y - c.y) > tol) return null; // not a parallelogram
  return [a, b, c, d];
}

/** Which of a rectangle's two side directions (from corner 0) counts as its
 *  width: the one lying more along X. */
function widthIsFirstSide(c: readonly Point[]): boolean {
  const e1 = { x: c[1]!.x - c[0]!.x, y: c[1]!.y - c[0]!.y };
  const e2 = { x: c[3]!.x - c[0]!.x, y: c[3]!.y - c[0]!.y };
  return Math.abs(e1.x) * Math.hypot(e2.x, e2.y) >= Math.abs(e2.x) * Math.hypot(e1.x, e1.y);
}

export function sizeLabelsOf(entity: Entity): SizeLabel[] {
  if (entity instanceof Line) {
    const a = entity.startPoint;
    const b = entity.endPoint;
    const value = Math.hypot(b.x - a.x, b.y - a.y);
    if (value === 0) return [];
    return [{ key: "length", value, prefix: "", name: "length", anchor: mid(a, b), away: unit(b.y - a.y, -(b.x - a.x)) }];
  }
  if (entity instanceof Circle) {
    const away = unit(1, -1); // up and to the right on screen (world is Y-down)
    const anchor = { x: entity.center.x + away.x * entity.radius, y: entity.center.y + away.y * entity.radius };
    return [{ key: "diameter", value: entity.radius * 2, prefix: "Ø", name: "diameter", anchor, away }];
  }
  if (entity instanceof Arc) {
    // At the middle of the arc, outside it. (Angles run clockwise on screen in the Y-down world.)
    const sweep = (((entity.endAngle - entity.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    const a = entity.startAngle + sweep / 2;
    const away = { x: Math.cos(a), y: Math.sin(a) };
    const anchor = { x: entity.center.x + away.x * entity.radius, y: entity.center.y + away.y * entity.radius };
    return [{ key: "radius", value: entity.radius, prefix: "R", name: "radius", anchor, away }];
  }
  if (entity instanceof Polyline) {
    const c = rectangleCorners(entity);
    if (c === null) return [];
    const centre = mid(c[0], c[2]);
    const side = (p: Point, q: Point, key: SizeKey): SizeLabel => {
      const m = mid(p, q);
      return { key, value: Math.hypot(q.x - p.x, q.y - p.y), prefix: "", name: key, anchor: m, away: unit(m.x - centre.x, m.y - centre.y) };
    };
    const first = widthIsFirstSide(c);
    return [side(c[0], c[1], first ? "width" : "height"), side(c[0], c[3], first ? "height" : "width")];
  }
  return [];
}

/**
 * Sets one of an entity's own sizes. A line keeps its middle where it is
 * (as typing a new length on a selected line always has); a circle keeps
 * its centre; a rectangle keeps its first corner. False if `key` isn't one
 * of this entity's sizes.
 */
export function applySize(entity: Entity, key: SizeKey, value: number): boolean {
  if (!(value > 0)) return false;
  if (entity instanceof Line && key === "length") {
    const a = entity.startPoint;
    const b = entity.endPoint;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) return false;
    const m = mid(a, b);
    const u = unit(b.x - a.x, b.y - a.y);
    entity.startPoint = { x: m.x - (u.x * value) / 2, y: m.y - (u.y * value) / 2 };
    entity.endPoint = { x: m.x + (u.x * value) / 2, y: m.y + (u.y * value) / 2 };
    return true;
  }
  if (entity instanceof Circle && key === "diameter") {
    entity.radius = value / 2;
    return true;
  }
  if (entity instanceof Arc && key === "radius") {
    entity.radius = value;
    return true;
  }
  if (entity instanceof Polyline && (key === "width" || key === "height")) {
    const c = rectangleCorners(entity);
    if (c === null) return false;
    const e1 = { x: c[1].x - c[0].x, y: c[1].y - c[0].y };
    const e2 = { x: c[3].x - c[0].x, y: c[3].y - c[0].y };
    const firstSide = (key === "width") === widthIsFirstSide(c);
    const l1 = firstSide ? value : Math.hypot(e1.x, e1.y);
    const l2 = firstSide ? Math.hypot(e2.x, e2.y) : value;
    const u1 = unit(e1.x, e1.y);
    const u2 = unit(e2.x, e2.y);
    const b = { x: c[0].x + u1.x * l1, y: c[0].y + u1.y * l1 };
    const d = { x: c[0].x + u2.x * l2, y: c[0].y + u2.y * l2 };
    entity.vertices[1]!.point = b;
    entity.vertices[3]!.point = d;
    entity.vertices[2]!.point = { x: b.x + d.x - c[0].x, y: b.y + d.y - c[0].y };
    return true;
  }
  return false;
}

/** "25", "12.5", "7.25": up to two decimals, no trailing zeros. */
export function formatSize(value: number): string {
  return `${+value.toFixed(2)}`;
}
