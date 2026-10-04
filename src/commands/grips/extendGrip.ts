/**
 * MinimalCAD Web
 * commands/grips/extendGrip.ts
 *
 * Ported from commands/extend_grip.py: drags one endpoint of a Line,
 * leaving the other fixed. Contextual-only, armed via begin().
 */

import type { Point } from "../../core/types";
import type { Line } from "../../entities/line";
import type { Engine } from "../../engine/engine";
import { BaseCommand } from "../base";
import { evalNumber, parsePoint } from "../../input/dynamicInput";

export class ExtendGripCommand extends BaseCommand {
  private entity: Line | null = null;
  private isStart = true;
  private currentPos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.entity = null;
    this.currentPos = null;
    this.commandBar.setStatus("LINE", "Click an endpoint grip to extend it");
  }

  begin(entity: Line, isStart: boolean): void {
    this.entity = entity;
    this.isStart = isStart;
    this.currentPos = isStart ? { ...entity.startPoint } : { ...entity.endPoint };
    this.commandBar.setStatus("LINE", "Drag, or type the new length (+10 / -10 to extend / shorten by)");
    this.commandBar.enableInput();
    this.commandBar.setValue(this.lengthTo(this.currentPos).toFixed(2));
  }

  /**
   * Where the dragged end goes: along the line's own direction, so the drag
   * only makes it longer or shorter. A snap onto other geometry (or a typed
   * point) still puts the end exactly there, which is how it gets re-aimed.
   */
  private resolve(worldPos: Point): Point {
    const { point, snapType } = this.engine.snap(worldPos, this.currentPos!);
    if (snapType !== null) return point;
    const fixed = this.isStart ? this.entity!.endPoint : this.entity!.startPoint;
    const grabbed = this.isStart ? this.entity!.startPoint : this.entity!.endPoint;
    const len = Math.hypot(grabbed.x - fixed.x, grabbed.y - fixed.y);
    if (len === 0) return point;
    const u = { x: (grabbed.x - fixed.x) / len, y: (grabbed.y - fixed.y) / len };
    // Never through the fixed end and out the other side.
    const t = Math.max((point.x - fixed.x) * u.x + (point.y - fixed.y) * u.y, len * 1e-6);
    return { x: fixed.x + u.x * t, y: fixed.y + u.y * t };
  }

  leftClick(worldPos: Point): void {
    if (this.entity === null || this.currentPos === null) return;
    this.execute(this.resolve(worldPos));
  }

  mouseMove(worldPos: Point): void {
    if (this.entity === null || this.currentPos === null) return;
    const point = this.resolve(worldPos);
    this.currentPos = point;
    this.commandBar.setLiveValue(this.lengthTo(point).toFixed(2));
    this.engine.requestRedraw();
  }

  private fixedEnd(): Point {
    return this.isStart ? this.entity!.endPoint : this.entity!.startPoint;
  }

  private lengthTo(point: Point): number {
    const fixed = this.fixedEnd();
    return Math.hypot(point.x - fixed.x, point.y - fixed.y);
  }

  /** "80" = the new length; "+10" / "-10" = longer / shorter by that much,
   *  at the grabbed end. A full point ("x,y", "dist<angle") still re-aims it. */
  textInput(text: string): void {
    if (this.entity === null || this.currentPos === null) return;
    const typed = text.trim();
    if (typed.includes(",") || typed.includes("<")) {
      const point = parsePoint(typed, this.currentPos);
      if (point === null) this.commandBar.setStatus("LINE", "Invalid - use x,y or dist<angle");
      else this.execute(point);
      return;
    }
    const fixed = this.fixedEnd();
    const grabbed = this.isStart ? this.entity.startPoint : this.entity.endPoint;
    const len = Math.hypot(grabbed.x - fixed.x, grabbed.y - fixed.y);
    const by = typed.startsWith("+") || typed.startsWith("-");
    const value = evalNumber(by ? typed.slice(1) : typed);
    const length = value === null ? null : by ? len + (typed.startsWith("-") ? -value : value) : value;
    if (length === null || !(length > 0) || len === 0) {
      this.commandBar.setStatus("LINE", "Invalid - type the new length, or +10 / -10 to extend / shorten by");
      return;
    }
    this.execute({ x: fixed.x + ((grabbed.x - fixed.x) / len) * length, y: fixed.y + ((grabbed.y - fixed.y) / len) * length });
  }

  private execute(point: Point): void {
    this.undo.push(this.document.toDict());
    if (this.isStart) {
      this.entity!.startPoint = point;
    } else {
      this.entity!.endPoint = point;
    }
    this.engine.selection.clear();
    this.engine.cancelCommand();
    this.engine.requestRedraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.entity === null || this.currentPos === null) return;
    const ghost = this.entity.copy();
    if (this.isStart) ghost.startPoint = this.currentPos;
    else ghost.endPoint = this.currentPos;
    ghost.draw(ctx, this.engine.viewport, true);
  }

  cancel(): void {
    this.entity = null;
    this.currentPos = null;
    this.commandBar.setReady();
  }
}
