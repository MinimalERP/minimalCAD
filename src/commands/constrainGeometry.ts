/**
 * MinimalCAD Web
 * commands/constrainGeometry.ts
 *
 * The geometric constraints -- Horizontal, Vertical, Parallel,
 * Perpendicular, Equal, Coincident -- one command class, one instance per
 * kind (commands/registry.ts). Pick the entity to constrain; for all but
 * Horizontal / Vertical, then pick what it follows (another entity, or in
 * a part sketch an edge of the solid shown behind it). The constraint is
 * live from then on (core/constraints.ts's enforceConstraints()).
 *
 * A constraint that can't hold together with the ones already on the
 * drawing is refused, and nothing changes.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { BaseCommand } from "./base";
import { generateId } from "../core/id";
import {
  constraintError,
  defaultFeatureForClick,
  enforceConstraints,
  isDrivable,
  referenceGeometry,
  RESIDUAL_TOLERANCE,
} from "../core/constraints";
import type { Constraint, ConstraintKind, Drivable, PointFeature } from "../core/constraints";

export type GeometricKind = Exclude<ConstraintKind, "distance">;

const TITLE: Record<GeometricKind, string> = {
  horizontal: "HORIZONTAL",
  vertical: "VERTICAL",
  parallel: "PARALLEL",
  perpendicular: "PERPENDICULAR",
  equal: "EQUAL",
  coincident: "COINCIDENT",
};

/** What to click first, and (if anything) second. */
const PROMPT: Record<GeometricKind, [string, string]> = {
  horizontal: ["Click a line to make horizontal", ""],
  vertical: ["Click a line to make vertical", ""],
  parallel: ["Click the line to turn", "Click the line it must stay parallel to"],
  perpendicular: ["Click the line to turn", "Click the line it must stay square to"],
  equal: ["Click the line or circle to resize", "Click the one it must stay equal to"],
  coincident: ["Click the point to move - a line's end / middle, or a circle", "Click the point it must stay on"],
};

export class ConstrainGeometryCommand extends BaseCommand {
  private driven: Drivable | null = null;
  private drivenFeature: PointFeature = "mid";

  constructor(
    engine: Engine,
    private kind: GeometricKind,
  ) {
    super(engine);
  }

  start(): void {
    this.driven = null;
    this.commandBar.setStatus(TITLE[this.kind], PROMPT[this.kind][0]);
    this.engine.requestRedraw();
  }

  private hit(entities: readonly Entity[], worldPos: Point): Drivable | null {
    const tolerance = this.engine.pickTolerance();
    for (const entity of entities) if (isDrivable(entity) && entity.hitTest(worldPos, tolerance)) return entity;
    return null;
  }

  /** Entity kinds this constraint can drive. */
  private drivable(e: Drivable): boolean {
    if (this.kind === "coincident") return true;
    if (this.kind === "equal") return e instanceof Line || e instanceof Circle || e instanceof Arc;
    return e instanceof Line;
  }

  leftClick(worldPos: Point): void {
    const title = TITLE[this.kind];
    if (this.driven === null) {
      const entity = this.hit(this.document.getEntities(), worldPos);
      if (entity === null) return;
      if (!this.drivable(entity)) {
        this.commandBar.setStatus(title, this.kind === "equal" ? "Pick a line, circle or arc" : "Pick a line");
        return;
      }
      if (this.kind === "horizontal" || this.kind === "vertical") {
        this.apply(entity, "mid", {});
        return;
      }
      this.driven = entity;
      this.drivenFeature = defaultFeatureForClick(entity, worldPos) ?? "mid";
      this.commandBar.setStatus(title, PROMPT[this.kind][1]);
      this.engine.requestRedraw();
      return;
    }

    const own = this.hit(this.document.getEntities(), worldPos);
    const underlay = own === null ? this.hit(this.engine.underlay ?? [], worldPos) : null;
    const ref = own ?? underlay;
    if (ref === null) return;
    if (ref === this.driven) {
      this.commandBar.setStatus(title, "Pick a different entity to follow");
      return;
    }
    const driven = this.driven;
    if (this.kind === "equal") {
      const sameSort = (driven instanceof Line) === (ref instanceof Line) && (ref instanceof Line || ref instanceof Circle || ref instanceof Arc);
      // Reference geometry has no radius of its own to keep (it is only a stand-in point).
      if (!sameSort || (underlay !== null && !(ref instanceof Line))) {
        this.commandBar.setStatus(title, driven instanceof Line ? "Pick another line" : "Pick another circle or arc that you drew");
        return;
      }
    } else if (this.kind !== "coincident" && !(ref instanceof Line)) {
      this.commandBar.setStatus(title, "Pick a line");
      return;
    }

    const refFeature = ref instanceof Line ? "edge" : "center";
    if (underlay === null) {
      const point = this.kind === "coincident" && ref instanceof Line ? (defaultFeatureForClick(ref, worldPos) ?? "mid") : undefined;
      this.apply(driven, this.drivenFeature, { ref_entity_id: ref.id ?? "", ref_feature: refFeature, ...(point === undefined ? {} : { ref_point: point }) });
      return;
    }
    // An edge of the solid: remember where it is now and which edge it is.
    const model = this.engine.modelRefOf?.(underlay);
    let geom = referenceGeometry(underlay);
    if (this.kind === "coincident" && underlay instanceof Line) {
      const pts = [underlay.startPoint, underlay.endPoint, underlay.midpoint()];
      const near = pts.reduce((best, p) => (Math.hypot(p.x - worldPos.x, p.y - worldPos.y) < Math.hypot(best.x - worldPos.x, best.y - worldPos.y) ? p : best));
      geom = { p: { ...near } };
    }
    this.apply(driven, this.drivenFeature, { ref_entity_id: "", ref_feature: refFeature, ref_geom: geom, ...(model === undefined ? {} : { ref_model: model }) });
  }

  private apply(driven: Drivable, feature: PointFeature, rest: Partial<Constraint>): void {
    const title = TITLE[this.kind];
    const doc = this.document;
    const before = doc.toDict();
    const constraint: Constraint = {
      id: generateId(),
      driven_entity_id: driven.id ?? "",
      driven_feature: feature,
      ref_entity_id: "",
      ref_feature: "edge",
      target: 0,
      kind: this.kind,
      ...rest,
    };
    (doc.constraints as Constraint[]).push(constraint);
    enforceConstraints(doc);
    // Everything on the drawing must still hold -- the new one and the old ones.
    const broken = (doc.constraints as Constraint[]).some((c) => {
      const err = constraintError(doc, c);
      return err === null ? c === constraint : err > RESIDUAL_TOLERANCE;
    });
    if (broken) {
      doc.restoreFromDict(before);
      this.commandBar.setStatus(title, "Can't apply - it conflicts with a constraint already there. " + PROMPT[this.kind][0]);
    } else {
      this.undo.push(before);
      this.commandBar.setStatus(title, `Applied. ${PROMPT[this.kind][0]} (right-click to finish)`);
    }
    this.driven = null;
    this.engine.requestRedraw();
  }

  cancel(): void {
    this.driven = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
