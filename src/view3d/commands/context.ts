/**
 * MinimalCAD Web
 * view3d/commands/context.ts
 *
 * What a 3D feature command (Extrude, Hole, Work Plane, ...) gets from the
 * model controller, and what it must provide back. Each command owns one
 * FeatureDialog and the view's pick mode while it runs.
 */

import type { PartData } from "../../part/types";
import type { RebuildResult } from "../../part/rebuild";
import type { Hit, ModelView } from "../modelView";
import type { Point } from "../../core/types";

export interface ModelContext {
  readonly view: ModelView;
  /** Where dialogs are mounted (the 3D canvas wrapper). */
  readonly dialogParent: HTMLElement;
  part(): PartData;
  result(): RebuildResult | null;
  params(): ReadonlyMap<string, number>;
  drawingEntities(): Record<string, unknown>[];
  /** Undo snapshot + mutate Document.part + rebuild. */
  commit(mutate: (part: PartData) => void): void;
  /** Sketch wireframes; `alsoShow` = consumed sketches to show anyway. */
  showWireframes(alsoShow?: ReadonlySet<string>): void;
  /** One-line hint in the command bar (no typing needed). */
  status(command: string, text: string): void;
  /** The command ended (OK or Cancel): back to idle. */
  done(): void;
}

export interface ModelCommand {
  onPick?(hit: Hit): void;
  onFacePointHover?(hit: { point: Point; snap: string | null } | null): void;
  onSurfaceHover?(hit: Extract<Hit, { kind: "surfacePoint" }> | null): void;
  /** A row of the Model tree was clicked while this command runs; return
   *  true if the command took it (e.g. Pattern: that feature to repeat). */
  onTreePick?(id: string): boolean;
  /** A key in the 3D view; return true if handled (e.g. Delete a selected dimension). */
  onKey?(e: KeyboardEvent): boolean;
  /** Enter in the 3D view. */
  ok(): void;
  /** Esc / another command started: close the dialog and clean the view. */
  cancel(): void;
}
