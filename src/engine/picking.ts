/**
 * MinimalCAD Web
 * engine/picking.ts
 *
 * Ported from graphics/picking.py: entityAt() (plain first-match-in-document-
 * order hit test -- NOT topmost-first/reverse-order, matching the Python
 * source's own quirk exactly) and gripAt() (per-type grip enumeration, only
 * active when exactly one entity is selected).
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { Selection } from "../core/selection";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Dimension } from "../entities/dimension";

export function entityAt<T extends Entity>(entities: T[], worldPos: Point, tolerance: number): T | null {
  const wx = worldPos.x;
  const wy = worldPos.y;
  for (const entity of entities) {
    const [x0, y0, x1, y1] = entity.getBounds();
    if (wx < x0 - tolerance || wx > x1 + tolerance || wy < y0 - tolerance || wy > y1 + tolerance) {
      continue;
    }
    if (entity.hitTest(worldPos, tolerance)) return entity;
  }
  return null;
}

export type GripKind = "line_extend" | "move_grip" | "circle_resize" | "dimension_grip";

export interface GripHit {
  kind: GripKind;
  entity: Entity;
  /** line_extend: true=start point, false=end point.
   *  move_grip: the anchor point (Line midpoint / Circle center).
   *  circle_resize: the matched quadrant point.
   *  dimension_grip: the Dimension.data key being dragged (e.g. "p1"). */
  extra: boolean | Point | string;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function gripAt(selection: Selection, worldPos: Point, tolerance: number): GripHit | null {
  const selected = selection.getEntities();
  if (selected.length !== 1) return null;
  const entity = selected[0]!;

  if (entity instanceof Line) {
    if (dist(worldPos, entity.startPoint) <= tolerance) {
      return { kind: "line_extend", entity, extra: true };
    }
    if (dist(worldPos, entity.endPoint) <= tolerance) {
      return { kind: "line_extend", entity, extra: false };
    }
    const mid = entity.midpoint();
    if (dist(worldPos, mid) <= tolerance) {
      return { kind: "move_grip", entity, extra: mid };
    }
    return null;
  }

  if (entity instanceof Circle) {
    if (dist(worldPos, entity.center) <= tolerance) {
      return { kind: "move_grip", entity, extra: entity.center };
    }
    for (const q of entity.quadrantPoints()) {
      if (dist(worldPos, q) <= tolerance) {
        return { kind: "circle_resize", entity, extra: q };
      }
    }
    return null;
  }

  if (entity instanceof Dimension) {
    for (const [key, pt] of entity.gripItems()) {
      if (dist(worldPos, pt) <= tolerance) {
        return { kind: "dimension_grip", entity, extra: key };
      }
    }
    return null;
  }

  return null;
}
