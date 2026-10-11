/**
 * MinimalCAD Web
 * commands/explode.ts
 *
 * Ported from commands/explode.py: breaks a composite entity down into its
 * constituent primitives -- Polyline into its own Line/Arc segments
 * (Polyline.segmentEntities(), the same per-edge reconstruction its own
 * draw() already uses), Dimension into the Line/Arc/Text primitives its
 * draw() calls already amount to (Dimension.explode(), the same machinery
 * io/dxf.ts's DXF export uses to give a Dimension a flat primitive form).
 * Anything else (Line, Arc, Circle, Ellipse, Text) is already a primitive
 * -- EXPLODE leaves it untouched. No Table in this web port yet (see
 * entities/registry.ts), so it isn't in EXPLODABLE_TYPES here either.
 *
 * Two ways to invoke it, mirroring JOIN's own two entry points: pre-select
 * one or more Polylines/Dimensions before running EXPLODE to break every
 * one apart immediately as a single undo step, or (nothing pre-selected)
 * click one at a time, looping to explode more without re-running the tool.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import { BaseCommand } from "./base";
import { Polyline } from "../entities/polyline";
import { Dimension } from "../entities/dimension";

type Explodable = Polyline | Dimension;

function isExplodable(entity: Entity): entity is Explodable {
  return entity instanceof Polyline || entity instanceof Dimension;
}

export class ExplodeCommand extends BaseCommand {
  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    const preSelected = this.engine.selection.getEntities().filter(isExplodable);
    if (preSelected.length > 0) {
      this.explodeAll(preSelected);
      return;
    }
    this.commandBar.setStatus("EXPLODE", "Click a Polyline/Dimension to explode (Esc to finish)");
    this.commandBar.enableInput();
  }

  pick(): (entity: Entity) => boolean {
    return isExplodable;
  }

  leftClick(worldPos: Point): void {
    for (const entity of this.document.getEntities()) {
      if (isExplodable(entity) && entity.hitTest(worldPos, this.engine.pickTolerance())) {
        this.explodeAll([entity]);
        break;
      }
    }
  }

  cancel(): void {
    this.commandBar.setReady();
  }

  private explodeAll(entities: Explodable[]): void {
    this.undo.push(this.document.toDict());

    let pieceCount = 0;
    for (const entity of entities) {
      const pieces = entity instanceof Polyline ? entity.segmentEntities() : entity.explode();
      this.document.removeEntity(entity);
      for (const piece of pieces) {
        this.document.addEntity(piece);
        pieceCount++;
      }
    }

    this.engine.selection.clear();
    this.commandBar.enableInput();
    this.commandBar.setStatus(
      "EXPLODE",
      `Exploded ${entities.length} - ${pieceCount} piece(s) - select another, or Esc to finish`,
    );
    this.engine.requestRedraw();
  }
}
