/**
 * MinimalCAD Web
 * core/document.ts
 *
 * Ported from document.py's Document class. Pure drawing database: stores
 * entities, serializes/restores the whole document as a plain JSON-shaped
 * object (the same shape the desktop app reads/writes).
 */

import type { Bounds } from "./types";
import { unionBounds } from "./types";
import type { Entity } from "../entities/entity";
import { ENTITY_TYPES } from "../entities/registry";

export interface DocumentSnapshot {
  entities: Record<string, unknown>[];
  // Opaque passthrough: v1 doesn't interpret constraints at all, but a file
  // loaded from the desktop app may already carry some -- round-tripping
  // them unread (rather than dropping them on save) avoids silently
  // destroying data the user didn't ask this app to touch.
  constraints: unknown[];
  // Opaque passthrough for the 3D/drawing workspaces (part/types.ts owns the
  // real schema, so this 2D core never imports any 3D code). Only emitted
  // when present, so a pure-2D file stays byte-identical to the desktop
  // app's own .jcad shape.
  part?: unknown;
  sheets?: unknown;
}

export interface ParseResult {
  entities: Entity[];
  skippedCount: number;
}

export class Document {
  entities: Entity[] = [];
  constraints: unknown[] = [];
  constraintsDirty = true;
  private entityMap: Map<string, Entity> | null = null;

  /** Set while this document is a part sketch: finds the reference geometry
   *  (a projected edge of the solid, as it is NOW) a constraint measures
   *  from -- see core/constraints.ts's referenceEntity(). Never saved. */
  modelRef: ((constraint: unknown) => unknown) | null = null;
  /** 3D part (sketches + feature history) -- see DocumentSnapshot.part. */
  part: unknown = undefined;
  sheets: unknown = undefined;

  getEntityById(id: string): Entity | null {
    if (this.entityMap === null) {
      this.entityMap = new Map();
      for (const e of this.entities) {
        if (e.id !== undefined) this.entityMap.set(e.id, e);
      }
    }
    return this.entityMap.get(id) ?? null;
  }

  addEntity(entity: Entity): void {
    if (!this.entities.includes(entity)) {
      this.entities.push(entity);
      if (this.entityMap !== null && entity.id !== undefined) {
        this.entityMap.set(entity.id, entity);
      }
      this.constraintsDirty = true;
    }
  }

  removeEntity(entity: Entity): void {
    const idx = this.entities.indexOf(entity);
    if (idx !== -1) this.entities.splice(idx, 1);
    if (this.entityMap !== null && entity.id !== undefined) {
      this.entityMap.delete(entity.id);
    }
    this.constraintsDirty = true;

    // Purge any constraint referencing this entity's id -- a no-op today
    // since v1 never creates constraints, but keeps removeEntity's contract
    // identical to the Python source's for whenever a constraints feature
    // (and passthrough-loaded desktop constraints) becomes load-bearing.
    if (entity.id !== undefined && this.constraints.length > 0) {
      this.constraints = this.constraints.filter((c) => {
        const rec = c as { driven_entity_id?: string; ref_entity_id?: string };
        return rec.driven_entity_id !== entity.id && rec.ref_entity_id !== entity.id;
      });
    }
  }

  clear(): void {
    this.entities = [];
    this.constraints = [];
    this.entityMap = null;
    this.constraintsDirty = true;
    this.part = undefined;
    this.sheets = undefined;
  }

  getEntities(): Entity[] {
    return this.entities.slice();
  }

  getBounds(): Bounds {
    if (this.entities.length === 0) return [0, 0, 0, 0];
    let bounds = this.entities[0]!.getBounds();
    for (const entity of this.entities.slice(1)) {
      bounds = unionBounds(bounds, entity.getBounds());
    }
    return bounds;
  }

  toDict(): DocumentSnapshot {
    const snapshot: DocumentSnapshot = {
      entities: this.entities.map((e) => e.serialize()),
      // A copy: a snapshot must not change when a constraint is added or
      // edited afterwards (undo would otherwise "restore" the new state).
      constraints: structuredClone(this.constraints),
    };
    if (this.part !== undefined) snapshot.part = structuredClone(this.part);
    if (this.sheets !== undefined) snapshot.sheets = structuredClone(this.sheets);
    return snapshot;
  }

  /** Rebuilds this Document's entities/constraints IN PLACE (undo/redo, Load) so any
   *  held reference to this Document instance stays valid across a reload. */
  restoreFromDict(data: DocumentSnapshot): ParseResult {
    const result = parseEntities(data.entities);
    this.entities = result.entities;
    this.constraints = structuredClone(data.constraints ?? []);
    this.part = data.part === undefined ? undefined : structuredClone(data.part);
    this.sheets = data.sheets === undefined ? undefined : structuredClone(data.sheets);
    this.entityMap = null;
    this.constraintsDirty = true;
    return result;
  }
}

/** World-unit gap placed between a document's existing content and anything
 *  newly merged into it beside that (Insert Drawing) -- see placeBeside(). */
export const PLACEMENT_MARGIN = 50.0;

/** Combined bounding box of a plain entity list -- shared by originAlign and
 *  placeBeside, neither of which has a Document wrapping `entities` to call
 *  .getBounds() on. Assumes `entities` is non-empty, matching document.py's
 *  own bounds_of() (callers already check before merging in new content). */
export function boundsOf(entities: Entity[]): Bounds {
  let bounds = entities[0]!.getBounds();
  for (const entity of entities.slice(1)) {
    bounds = unionBounds(bounds, entity.getBounds());
  }
  return bounds;
}

/** Translates `entities` in place so their combined bounding box sits right
 *  at the origin, extending into the first quadrant: left edge -> x=0, and
 *  -- since this app's world space is Y-down with DXF export negating Y on
 *  the way out (see io/dxf.ts's flipY) -- bottom-on-screen edge -> y=0, so
 *  the exported Y comes out >= 0 too, not just X. No-op if already there. */
export function originAlign(entities: Entity[]): void {
  const [minX, , , maxY] = boundsOf(entities);
  const dx = -minX;
  const dy = -maxY;
  if (dx !== 0 || dy !== 0) {
    for (const entity of entities) entity.move(dx, dy);
  }
}

/**
 * Translates `entities` in place so their combined bounding box sits just to
 * the right of `targetBounds`, bottom-aligned, with a PLACEMENT_MARGIN gap.
 *
 * "Bottom" here means maxY, not minY: this app's world space is Y-down (see
 * originAlign above), so the numerically largest Y is the visually lowest
 * point -- the one that should land on the X axis, matching how the very
 * first import into an empty document is placed by originAlign. Aligning on
 * minY instead would line up the *tops* of the new and existing geometry,
 * leaving their bottoms at whatever height each entity's own size happens
 * to put them -- fine for same-sized geometry, but visibly inconsistent for
 * anything else.
 *
 * Used by Insert Drawing (merging another .jcad's entities onto the current
 * canvas) so the newly added entities land predictably next to what's
 * already there rather than at their own original coordinates, which could
 * be arbitrarily far away and blow out the immediately-following zoomExtents.
 */
export function placeBeside(targetBounds: Bounds, entities: Entity[]): void {
  const [, , cx1, cy1] = targetBounds;
  const [minX, , , maxY] = boundsOf(entities);
  const dx = cx1 - minX + PLACEMENT_MARGIN;
  const dy = cy1 - maxY;
  if (dx !== 0 || dy !== 0) {
    for (const entity of entities) entity.move(dx, dy);
  }
}

/** Type-dispatches a snapshot's entity list back into live entity instances,
 *  skipping (rather than aborting on) any unrecognized/corrupted entry --
 *  e.g. an Ellipse/Text/Table/Dimension from a real desktop-app file that
 *  this v1 web port doesn't support yet. */
export function parseEntities(items: Record<string, unknown>[]): ParseResult {
  const entities: Entity[] = [];
  let skippedCount = 0;

  for (const item of items) {
    const typeKey = typeof item.type === "string" ? item.type.toLowerCase() : null;
    const factory = typeKey !== null ? ENTITY_TYPES[typeKey] : undefined;
    if (factory === undefined) {
      skippedCount++;
      continue;
    }
    try {
      entities.push(factory(item));
    } catch {
      skippedCount++;
    }
  }

  return { entities, skippedCount };
}
