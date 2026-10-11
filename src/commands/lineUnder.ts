/**
 * MinimalCAD Web
 * commands/lineUnder.ts
 *
 * The straight line under a click, for the dimension commands' "click a line
 * to dimension it": a Line of the drawing, or a straight side of a polyline
 * (a rectangle's side). Null when the click is on nothing straight.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { entityAt } from "../engine/picking";
import { Line } from "../entities/line";
import { Polyline } from "../entities/polyline";

export function lineUnder(engine: Engine, worldPos: Point): Line | null {
  const lines = [...engine.document.getEntities(), ...engine.underlay].flatMap((e) => (e instanceof Polyline ? e.segmentEntities() : [e])).filter((e): e is Line => e instanceof Line);
  return entityAt(lines, worldPos, engine.pickTolerance());
}
