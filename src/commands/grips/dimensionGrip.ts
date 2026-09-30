/**
 * MinimalCAD Web
 * commands/grips/dimensionGrip.ts
 *
 * Ported from commands/dimension_grip.py: repositions a single grip point of
 * a selected Dimension (p1/p2, text_position, a leader's `point`, ...) by
 * dragging or typing a new location. Contextual-only -- entered directly via
 * the grip hit-test in ui/canvasView.ts's mousedown, not typeable, so
 * start() alone leaves it inert; begin() arms it.
 *
 * See entities/dimension.ts's constrainGrip() for why linear's p1/p2 are
 * axis-restricted while every other dim_type's grips drag freely.
 */

import type { Point } from "../../core/types";
import type { Engine } from "../../engine/engine";
import { BaseCommand } from "../base";
import type { Dimension } from "../../entities/dimension";
import { parsePoint } from "../../input/dynamicInput";

export class DimensionGripCommand extends BaseCommand {
  private dimension: Dimension | null = null;
  private key: string | null = null;
  private originalPoint: Point | null = null;
  private currentPoint: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.dimension = null;
    this.key = null;
    this.originalPoint = null;
    this.currentPoint = null;
    this.commandBar.setStatus("DIMENSION GRIP", "Click a dimension's grip to reposition it");
  }

  begin(dimension: Dimension, key: string): void {
    this.dimension = dimension;
    this.key = key;
    this.originalPoint = { ...(dimension.data[this.key] as Point) };
    this.currentPoint = { ...this.originalPoint };

    this.commandBar.setStatus("DIMENSION GRIP", "Drag, or type a point (x,y or dist<angle)");
    this.commandBar.enableInput();
    this.commandBar.setValue(`${this.originalPoint.x.toFixed(2)}, ${this.originalPoint.y.toFixed(2)}`);
  }

  leftClick(worldPos: Point): void {
    if (this.dimension === null || this.key === null || this.originalPoint === null) return;
    const { point } = this.engine.snap(worldPos, this.originalPoint);
    this.execute(this.dimension.constrainGrip(this.key, point));
  }

  mouseMove(worldPos: Point): void {
    if (this.dimension === null || this.key === null || this.originalPoint === null) return;
    const { point } = this.engine.snap(worldPos, this.originalPoint);
    const constrained = this.dimension.constrainGrip(this.key, point);
    this.currentPoint = constrained;
    this.commandBar.setLiveValue(`${constrained.x.toFixed(2)}, ${constrained.y.toFixed(2)}`);
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.dimension === null || this.key === null || this.originalPoint === null) return;
    if (!text.trim()) return;

    const point = parsePoint(text, this.originalPoint);
    if (point === null) {
      this.commandBar.setStatus("DIMENSION GRIP", "Invalid - use x,y or dist<angle");
      return;
    }
    this.execute(this.dimension.constrainGrip(this.key, point));
  }

  private execute(newPoint: Point): void {
    this.undo.push(this.document.toDict());
    // Dragging the text: it stays where it's dropped, even outside the
    // extension lines (small dimensions).
    if (this.key === "text_position") this.dimension!.pinText();
    this.dimension!.data[this.key!] = { ...newPoint };
    this.engine.selection.clear();
    this.engine.cancelCommand();
    this.engine.requestRedraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.dimension === null || this.key === null || this.currentPoint === null) return;
    const preview = this.dimension.copy();
    if (this.key === "text_position") preview.pinText();
    preview.data[this.key] = { ...this.currentPoint };
    preview.draw(ctx, this.engine.viewport, true);
  }

  cancel(): void {
    this.dimension = null;
    this.key = null;
    this.originalPoint = null;
    this.currentPoint = null;
    this.commandBar.setReady();
  }
}
