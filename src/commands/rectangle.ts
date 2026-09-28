/**
 * MinimalCAD Web
 * commands/rectangle.ts
 *
 * Ported from commands/rectangle.py: two-corner rectangle -> ONE closed
 * 4-vertex Polyline, so it selects/moves/grips as a single rectangle (the
 * desktop app's 4 loose Lines behaved like an already-exploded shape).
 * Still no dedicated Rectangle entity type -- a closed "polyline" is a type
 * the desktop app and DXF export already understand. Explode gives back the
 * 4 Lines when per-edge editing (fillet/offset/chamfer) is needed.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Polyline } from "../entities/polyline";
import { drawGrip } from "../entities/style";
import { parsePoint, parseTwoPositiveFloats } from "../input/dynamicInput";

export class RectangleCommand extends BaseCommand {
  private state: 0 | 1 = 0;
  // "corner": firstCorner is one corner, second point is the opposite
  // corner (the original/default behavior). "center": firstCorner is
  // actually the rectangle's CENTER, and the second point is one corner --
  // the opposite corner is the center's own reflection of it, so the
  // rectangle stays centered on the first point picked.
  private mode: "corner" | "center" = "corner";
  private firstCorner: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.mode = "corner";
    this.firstCorner = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("RECTANGLE", "Pick First Corner (or type x,y, or C for Center)");
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.firstCorner = { ...point };
      this.currentMousePos = { ...point };
      this.state = 1;
      this.commandBar.setStatus("RECTANGLE", "Width: 0.00 | Height: 0.00 (or type w,h)");
      this.commandBar.enableInput();
    } else {
      const { point } = this.engine.snap(worldPos, this.firstCorner);
      this.commitSecondPoint(point);
    }
    this.engine.requestRedraw();
  }

  /** Resolves the second picked point (a plain opposite corner in "corner"
   *  mode, or a corner to be mirrored about the center in "center" mode)
   *  into the rectangle's actual two opposite corners. */
  private resolveCorners(second: Point): [Point, Point] {
    const first = this.firstCorner!;
    if (this.mode === "corner") return [first, second];
    // Center mode: `first` is the center, `second` is one corner -- the
    // opposite corner is second's point-reflection through the center.
    const opposite: Point = { x: 2 * first.x - second.x, y: 2 * first.y - second.y };
    return [opposite, second];
  }

  private commitSecondPoint(worldPos: Point): void {
    const [c1, c2] = this.resolveCorners(worldPos);
    const width = Math.abs(c2.x - c1.x);
    const height = Math.abs(c2.y - c1.y);
    if (width === 0 || height === 0) return; // degenerate rectangle, silently rejected

    this.undo.push(this.document.toDict());
    const p1 = c1;
    const p2: Point = { x: c2.x, y: c1.y };
    const p3 = c2;
    const p4: Point = { x: c1.x, y: c2.y };
    this.document.addEntity(
      new Polyline(
        [p1, p2, p3, p4].map((point) => ({ point, bulge: 0 })),
        true,
      ),
    );
    this.start();
  }

  mouseMove(worldPos: Point): void {
    const reference = this.state === 1 ? this.firstCorner : null;
    const { point } = this.engine.snap(worldPos, reference);
    this.currentMousePos = point;

    if (this.state === 1 && this.firstCorner !== null) {
      const [c1, c2] = this.resolveCorners(point);
      const width = Math.abs(c2.x - c1.x);
      const height = Math.abs(c2.y - c1.y);
      this.commandBar.setStatus(
        "RECTANGLE",
        `Width: ${width.toFixed(2)} | Height: ${height.toFixed(2)} (or type w,h)`,
      );
      // "width,height" -- the exact grammar textInput()'s parseTwoPositiveFloats
      // expects, so an untouched Enter commits this live-previewed size
      // (same as every other command's live default), not just a typed one.
      this.commandBar.setLiveValue(`${width.toFixed(2)},${height.toFixed(2)}`);
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 0) {
      const trimmed = text.trim().toLowerCase();
      if (trimmed === "c" || trimmed === "center") {
        this.mode = "center";
        this.commandBar.setStatus("RECTANGLE", "Pick Center Point (or type x,y)");
        return;
      }
      const point = parsePoint(text, null);
      if (point === null) {
        this.commandBar.setStatus("RECTANGLE", "Invalid point - use x,y, or C for Center");
        return;
      }
      this.firstCorner = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("RECTANGLE", "Width: 0.00 | Height: 0.00 (or type w,h)");
    } else {
      const dims = parseTwoPositiveFloats(text);
      if (dims === null) {
        this.commandBar.setStatus("RECTANGLE", "Invalid - enter width,height");
        return;
      }
      const [width, height] = dims;
      const mouse = this.currentMousePos ?? this.firstCorner!;
      const xDir = mouse.x >= this.firstCorner!.x ? 1 : -1;
      const yDir = mouse.y >= this.firstCorner!.y ? 1 : -1;
      const halfW = this.mode === "center" ? width / 2 : width;
      const halfH = this.mode === "center" ? height / 2 : height;
      this.commitSecondPoint({
        x: this.firstCorner!.x + halfW * xDir,
        y: this.firstCorner!.y + halfH * yDir,
      });
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state !== 1 || this.firstCorner === null || this.currentMousePos === null) return;
    const [c1, c2] = this.resolveCorners(this.currentMousePos);
    const viewport = this.engine.viewport;
    const p1 = viewport.worldToScreen(c1);
    const p2 = viewport.worldToScreen({ x: c2.x, y: c1.y });
    const p3 = viewport.worldToScreen(c2);
    const p4 = viewport.worldToScreen({ x: c1.x, y: c2.y });

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    if (this.mode === "center") {
      drawGrip(ctx, viewport.worldToScreen(this.firstCorner));
    }
  }

  cancel(): void {
    this.state = 0;
    this.mode = "corner";
    this.firstCorner = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
