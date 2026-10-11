/**
 * MinimalCAD Web
 * commands/polylineCorners.ts
 *
 * Lets FILLET and CHAMFER work on the sides of a polyline (a rectangle is
 * one): both commands only know separate Lines and Arcs, so a polyline that
 * is clicked is opened into its segments for the length of the command and
 * put back together as one outline afterwards -- now with the new corner in
 * it. If nothing came of it (Esc, a radius too large) the pieces are joined
 * straight back, and the drawing is as it was.
 */

import type { Point } from "../core/types";
import type { DocumentSnapshot } from "../core/document";
import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import { Polyline } from "../entities/polyline";
import { entityAt } from "../engine/picking";
import { joinAll } from "./join";

export class PolylineCorners {
  /** Everything that was in the drawing beside the opened polyline(s). */
  private outside: Set<Entity> | null = null;
  /** The drawing before the first polyline was opened: what an undo of the
   *  corner goes back to, so the opening is never a step of its own. */
  private before: DocumentSnapshot | null = null;

  constructor(private engine: Engine) {}

  /** If the click is on a polyline, opens it into its Lines and Arcs (they
   *  take its place in the drawing) so the command can pick one of them. */
  openAt(worldPos: Point): void {
    const doc = this.engine.document;
    const polylines = doc.getEntities().filter((e): e is Polyline => e instanceof Polyline);
    const hit = entityAt(polylines, worldPos, this.engine.pickTolerance());
    if (hit !== null) this.open(hit);
  }

  /** Opens one polyline of the drawing into its Lines and Arcs. */
  open(hit: Polyline): void {
    const doc = this.engine.document;
    if (this.outside === null) {
      this.before = doc.toDict();
      this.outside = new Set(doc.getEntities());
    }
    this.outside.delete(hit);
    doc.removeEntity(hit);
    for (const piece of hit.segmentEntities()) doc.addEntity(piece);
  }

  /** Was this entity in the drawing on its own (not a piece of an opened
   *  polyline)? */
  isLoose(entity: Entity): boolean {
    return this.outside !== null && this.outside.has(entity);
  }

  /** These entities took the place of a loose one: they stay on their own
   *  when the opened pieces are joined back. */
  keepApart(entities: Entity[]): void {
    if (this.outside === null) return;
    for (const e of entities) this.outside.add(e);
  }

  /** What to push on the undo stack before changing the corner. */
  undoState(): DocumentSnapshot {
    return this.before ?? this.engine.document.toDict();
  }

  /** Joins the opened pieces (and the corner made between them) back into
   *  one outline. Safe to call when nothing was opened. */
  close(): void {
    if (this.outside === null) return;
    const outside = this.outside;
    this.outside = null;
    this.before = null;
    const doc = this.engine.document;
    const pieces = doc.getEntities().filter((e) => !outside.has(e));
    const { result } = joinAll(pieces);
    for (const e of pieces) doc.removeEntity(e);
    for (const e of result) doc.addEntity(e);
  }
}
