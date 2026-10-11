/**
 * MinimalCAD Web
 * commands/transformBase.ts
 *
 * Ported from commands/transform_base.py's PickTransformCommand -- shared
 * base for Move/Copy/Rotate (Phase D) and Scale/Mirror (Phase F).
 *
 * Ghost-preview rendering deliberately diverges from the Python source: Qt's
 * painter transform stack let Move/Rotate cheat with a translate/rotate
 * ghost while Scale/Mirror had to recompute geometry per frame. This port
 * has no canvas transform stack in the first place (see the rendering-
 * approach note in ui/canvasView.ts), so every transform command's ghost is
 * built the same way -- entity.copy() + the same mutation the commit path
 * itself applies -- via drawGhosts() below. This works uniformly for
 * Move/Copy/Rotate (plain .move()/.rotate()); Scale/Mirror (Phase F) instead
 * pass a per-type reconstruction function with the same signature.
 */

import type { Entity } from "../entities/entity";
import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { entityAt } from "../engine/picking";

export type EntityConstructor = new (...args: never[]) => Entity;

export abstract class PickTransformCommand extends BaseCommand {
  protected eligibleTypes: EntityConstructor[] | null = null;
  protected targetEntities: Entity[] = [];

  constructor(engine: Engine) {
    super(engine);
  }

  private isEligible(entity: Entity): boolean {
    if (this.eligibleTypes === null) return true;
    return this.eligibleTypes.some((ctor) => entity instanceof ctor);
  }

  /** Still choosing what to work on (nothing picked yet): the canvas shows
   *  a pick box and lights up the entity under it. */
  pick(): ((entity: Entity) => boolean) | null {
    return this.targetEntities.length === 0 ? (e) => this.isEligible(e) : null;
  }

  protected preSelected(): Entity[] {
    return this.engine.selection.getEntities().filter((e) => this.isEligible(e));
  }

  protected pickTargetAt(worldPos: Point): Entity | null {
    const candidates = this.document.getEntities().filter((e) => this.isEligible(e));
    return entityAt(candidates, worldPos, this.engine.pickTolerance());
  }

  protected drawTargetsSelected(ctx: CanvasRenderingContext2D): void {
    for (const entity of this.targetEntities) {
      entity.drawSelected(ctx, this.engine.viewport);
    }
  }

  /** Draws a preview copy of each target entity, transformed by `transformFn`
   *  (mutating the copy in place -- e.g. `(e) => e.move(dx, dy)`). */
  protected drawGhosts(ctx: CanvasRenderingContext2D, transformFn: (copy: Entity) => void): void {
    for (const entity of this.targetEntities) {
      const ghost = entity.copy();
      transformFn(ghost);
      ghost.draw(ctx, this.engine.viewport, true);
    }
  }

  /** Commit tail for Move/Rotate: mutates the SAME entities in place. */
  protected commitMutate(mutateFn: (entity: Entity) => void): void {
    this.undo.push(this.document.toDict());
    for (const entity of this.targetEntities) {
      mutateFn(entity);
    }
    this.engine.selection.clear();
    this.start();
  }

  /** Commit tail for Copy/Scale/Mirror: builds new entities, originals untouched.
   *  `buildFn` may return one entity, an array of entities, or null (skip). */
  protected commitNew(buildFn: (entity: Entity) => Entity | Entity[] | null): void {
    this.undo.push(this.document.toDict());
    for (const entity of this.targetEntities) {
      const result = buildFn(entity);
      if (result === null) continue;
      if (Array.isArray(result)) {
        for (const r of result) this.document.addEntity(r);
      } else {
        this.document.addEntity(result);
      }
    }
    this.engine.selection.clear();
    this.start();
  }
}
