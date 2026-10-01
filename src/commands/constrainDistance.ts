/**
 * MinimalCAD Web
 * commands/constrainDistance.ts
 *
 * Ported from commands/constrain_distance.py: one-click "constrain from a
 * reference" workflow driving core/constraints.ts's one-shot distance
 * solver -- pick the entity to position (its point feature becomes the
 * thing being solved for), pick a reference entity (a Line's own edge, or
 * another entity's center), type the target distance. Repeat picking more
 * references against the SAME driven entity to fully locate it (e.g. two
 * perpendicular rectangle sides), or right-click (BaseCommand's default)
 * to stop and re-run the command for a different entity.
 *
 * Solving re-runs ALL of the driven entity's constraints together every
 * time a new one is added (not just the newest), so two references land
 * the point at their exact intersection rather than sequentially, and a
 * distance that would be geometrically incompatible with what's already
 * there is rejected outright instead of silently landing somewhere wrong
 * -- see core/constraints.ts's solvePoint() residual check.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { generateId } from "../core/id";
import { evalNumber } from "../input/dynamicInput";
import {
  isDrivable,
  defaultFeatureForClick,
  referenceFeatureFor,
  rawDistanceAndGradient,
  solvePoint,
  referenceEntity,
  referenceGeometry,
  applyDrivenMove,
  featurePoint,
  RESIDUAL_TOLERANCE,
} from "../core/constraints";
import type { Drivable, PointFeature, ReferenceFeature, Constraint, ConstraintRef } from "../core/constraints";

export class ConstrainDistanceCommand extends BaseCommand {
  // State 0: pick the entity to position (driven)
  // State 1: pick a reference entity to measure from
  // State 2: type the target distance
  private state: 0 | 1 | 2 = 0;
  private drivenEntity: Drivable | null = null;
  private drivenFeature: PointFeature | null = null;
  private refEntity: Drivable | null = null;
  private refFeature: ReferenceFeature | null = null;
  /** The reference is reference geometry (a projected edge of the solid
   *  behind a part sketch), not an entity of the document. */
  private refIsUnderlay = false;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.drivenEntity = null;
    this.drivenFeature = null;
    this.refEntity = null;
    this.refFeature = null;
    this.commandBar.setStatus("CONSTRAIN", "Pick entity to position");
    this.engine.requestRedraw();
  }

  private pickEntity(worldPos: Point): Drivable | null {
    const tolerance = this.engine.pickTolerance();
    for (const entity of this.document.getEntities()) {
      if (isDrivable(entity) && entity.hitTest(worldPos, tolerance)) return entity;
    }
    return null;
  }

  /** `ref_model` for reference geometry that is an edge of the solid, so the
   *  constraint follows the solid. */
  private modelRef(entity: Drivable): { ref_model?: unknown } {
    const ref = this.engine.modelRefOf?.(entity);
    return ref === undefined ? {} : { ref_model: ref };
  }

  /** A reference may also be the reference geometry behind a part sketch. */
  private pickReference(worldPos: Point): { entity: Drivable; underlay: boolean } | null {
    const own = this.pickEntity(worldPos);
    if (own !== null) return { entity: own, underlay: false };
    const tolerance = this.engine.pickTolerance();
    for (const entity of this.engine.underlay ?? []) {
      if (isDrivable(entity) && entity.hitTest(worldPos, tolerance)) return { entity, underlay: true };
    }
    return null;
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const entity = this.pickEntity(worldPos);
      if (entity === null) return;
      const feature = defaultFeatureForClick(entity, worldPos);
      if (feature === null) {
        this.commandBar.setStatus("CONSTRAIN", "Unsupported entity - pick a Line, Circle, Arc, or Ellipse");
        return;
      }
      this.drivenEntity = entity;
      this.drivenFeature = feature;
      this.state = 1;
      this.commandBar.setStatus("CONSTRAIN", "Pick a reference to measure from - a line / circle, or an edge of the solid behind the sketch");
    } else if (this.state === 1) {
      const picked = this.pickReference(worldPos);
      if (picked === null) return;
      const entity = picked.entity;
      if (entity === this.drivenEntity) {
        this.commandBar.setStatus("CONSTRAIN", "Reference must be a different entity");
        return;
      }
      const feature = referenceFeatureFor(entity);
      if (feature === null) {
        this.commandBar.setStatus("CONSTRAIN", "Unsupported reference - pick a Line, Circle, Arc, or Ellipse");
        return;
      }
      this.refEntity = entity;
      this.refFeature = feature;
      this.refIsUnderlay = picked.underlay;
      this.state = 2;
      this.commandBar.setStatus("CONSTRAIN", "Enter distance");
      this.commandBar.enableInput();
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state !== 2) return;
    const magnitude = evalNumber(text);
    if (magnitude === null || magnitude <= 0) {
      this.commandBar.setStatus("CONSTRAIN", "Invalid - enter a positive distance");
      return;
    }
    this.apply(magnitude);
  }

  private apply(magnitude: number): void {
    const drivenEntity = this.drivenEntity!;
    const drivenFeature = this.drivenFeature!;
    const refEntity = this.refEntity!;
    const refFeature = this.refFeature!;

    const currentPoint = featurePoint(drivenEntity, drivenFeature);

    // Fix which side of a reference edge the point stays on: whichever
    // side it's already on right now, so typing a distance never flips
    // the entity across the reference wall/line.
    const { distance: raw } = rawDistanceAndGradient(refEntity, refFeature, currentPoint);
    const target = refFeature !== "edge" ? magnitude : raw >= 0 ? magnitude : -magnitude;

    const existing = (this.document.constraints as Constraint[]).filter(
      (c) => c.driven_entity_id === drivenEntity.id,
    );
    const refs: ConstraintRef[] = [];
    for (const c of existing) {
      const ent = referenceEntity(this.document, c);
      if (ent === null) continue; // stale constraint pointing at a since-deleted entity
      refs.push({ refEntity: ent, refFeature: c.ref_feature, target: c.target });
    }
    refs.push({ refEntity, refFeature, target });

    const { point: solved, residual } = solvePoint(currentPoint, refs);
    if (solved === null || residual > RESIDUAL_TOLERANCE) {
      this.commandBar.setStatus(
        "CONSTRAIN",
        "Conflicting constraint - would violate an existing constraint on this entity, ignored",
      );
      this.state = 1;
      this.refEntity = null;
      this.refFeature = null;
      this.engine.requestRedraw();
      return;
    }

    this.undo.push(this.document.toDict());
    applyDrivenMove(drivenEntity, drivenFeature, solved);
    (this.document.constraints as Constraint[]).push({
      id: generateId(),
      driven_entity_id: drivenEntity.id,
      driven_feature: drivenFeature,
      ref_entity_id: this.refIsUnderlay ? "" : refEntity.id,
      ref_feature: refFeature,
      target,
      ...(this.refIsUnderlay ? { ref_geom: referenceGeometry(refEntity), ...this.modelRef(refEntity) } : {}),
    });

    this.refEntity = null;
    this.refFeature = null;
    this.state = 1;
    this.commandBar.setStatus(
      "CONSTRAIN",
      `Distance applied (${existing.length + 1} on this entity) - pick another reference, or right-click to finish`,
    );
    this.engine.requestRedraw();
  }

  cancel(): void {
    this.state = 0;
    this.drivenEntity = null;
    this.drivenFeature = null;
    this.refEntity = null;
    this.refFeature = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
