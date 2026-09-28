/**
 * MinimalCAD Web
 * commands/copy.ts
 *
 * Ported from commands/copy.py: same skeleton as Move, plus a 4th state for
 * array-copy count -- only reachable via a TYPED displacement, not a mouse
 * click (a mouse click always commits exactly one copy immediately).
 */

import type { Point } from "../core/types";
import type { Entity } from "../entities/entity";
import type { Engine } from "../engine/engine";
import { PickTransformCommand } from "./transformBase";
import { parsePoint } from "../input/dynamicInput";

export class CopyCommand extends PickTransformCommand {
  private state: 0 | 1 | 2 | 3 = 0;
  private referencePoint: Point | null = null;
  private currentMousePos: Point | null = null;
  private pendingDx = 0;
  private pendingDy = 0;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.commandBar.disableDualInput();
    const preSelected = this.preSelected();
    if (preSelected.length > 0) {
      this.targetEntities = preSelected;
      this.state = 1;
      this.commandBar.setStatus("COPY", `${preSelected.length} selected - Pick Reference Point`);
    } else {
      this.targetEntities = [];
      this.state = 0;
      this.commandBar.setStatus("COPY", "Select Object(s)");
    }
    this.referencePoint = null;
    this.currentMousePos = null;
    this.engine.requestRedraw();
  }

  private currentAngle(): number {
    if (this.referencePoint === null || this.currentMousePos === null) return 0;
    const dx = this.currentMousePos.x - this.referencePoint.x;
    const dy = this.currentMousePos.y - this.referencePoint.y;
    if (dx === 0 && dy === 0) return 0;
    return Math.atan2(dy, dx);
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const pick = this.pickTargetAt(worldPos);
      if (pick === null) return;
      this.targetEntities = [pick];
      this.state = 1;
      this.commandBar.setStatus("COPY", "1 selected - Pick Reference Point");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.referencePoint = point;
      this.currentMousePos = point;
      this.state = 2;
      this.commandBar.enableDualInput("0.00", "0.0");
    } else if (this.state === 2) {
      const { point, snapType } = this.engine.snap(worldPos, this.referencePoint);
      const resolved =
        snapType === null ? this.engine.applyOrtho(this.referencePoint!, point) : point;
      // Mouse click always commits exactly one copy immediately.
      this.executeCopy(resolved.x - this.referencePoint!.x, resolved.y - this.referencePoint!.y, 1);
    } else {
      // state 3: a plain click while awaiting a count confirms count=1.
      this.executeCopy(this.pendingDx, this.pendingDy, 1);
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    // Matches the desktop app's own mouse_move: snap previews from the
    // FIRST point-pick state onward (state 1, "Pick Reference Point"), not
    // just the final displacement state -- state 0 (still choosing which
    // entity to copy) and state 3 (typed-only copy count) have no point to
    // snap toward at all.
    if (this.state === 0 || this.state === 3) return;
    const reference = this.state === 2 ? this.referencePoint : null;
    const { point, snapType } = this.engine.snap(worldPos, reference);
    this.currentMousePos =
      this.state === 2 && this.referencePoint !== null && snapType === null
        ? this.engine.applyOrtho(this.referencePoint, point)
        : point;

    if (this.state === 2 && this.referencePoint !== null) {
      const dx = this.currentMousePos.x - this.referencePoint.x;
      const dy = this.currentMousePos.y - this.referencePoint.y;
      const distance = Math.hypot(dx, dy);
      const angleDeg = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360; // CCW, Y up
      this.commandBar.setLiveValue(distance.toFixed(2));
      this.commandBar.setLiveAngle(angleDeg.toFixed(1));
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 2 && this.referencePoint !== null) {
      const point = parsePoint(text, this.referencePoint, this.currentAngle());
      if (point === null) {
        this.commandBar.setStatus("COPY", "Invalid - use x,y, dist<angle, or a bare distance");
        return;
      }
      const dx = point.x - this.referencePoint.x;
      const dy = point.y - this.referencePoint.y;
      if (dx === 0 && dy === 0) {
        this.start();
        return;
      }
      this.pendingDx = dx;
      this.pendingDy = dy;
      this.state = 3;
      this.commandBar.disableDualInput();
      this.commandBar.enableInput();
      this.commandBar.setStatus("COPY", "Number of Copies (Enter for 1)");
      return;
    }

    if (this.state === 3) {
      const trimmed = text.trim();
      let count = 1;
      if (trimmed !== "") {
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000 || String(parsed) !== trimmed) {
          this.commandBar.setStatus("COPY", "Invalid - enter a whole number of copies (1-1000)");
          return;
        }
        count = parsed;
      }
      this.executeCopy(this.pendingDx, this.pendingDy, count);
    }
  }

  private executeCopy(dx: number, dy: number, count: number): void {
    if (dx === 0 && dy === 0) {
      this.start();
      return;
    }
    this.commitNew((entity: Entity) => {
      const copies: Entity[] = [];
      for (let k = 1; k <= count; k++) {
        const c = entity.copy();
        c.move(dx * k, dy * k);
        copies.push(c);
      }
      return copies;
    });
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state < 1) return;
    this.drawTargetsSelected(ctx);

    if (this.state === 2 && this.referencePoint !== null && this.currentMousePos !== null) {
      const dx = this.currentMousePos.x - this.referencePoint.x;
      const dy = this.currentMousePos.y - this.referencePoint.y;
      this.drawGhosts(ctx, (e) => e.move(dx, dy));
    } else if (this.state === 3) {
      // Live-preview however many copies are currently typed (not yet
      // submitted) -- reads the command bar's raw text directly, parsed
      // defensively since it may be empty or mid-edit.
      const raw = this.commandBar.text();
      let previewCount = 1;
      if (raw !== "") {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 1) previewCount = parsed;
      }
      previewCount = Math.min(previewCount, 50);

      for (let k = 1; k <= previewCount; k++) {
        this.drawGhosts(ctx, (e) => e.move(this.pendingDx * k, this.pendingDy * k));
      }
    }
  }

  cancel(): void {
    this.state = 0;
    this.targetEntities = [];
    this.referencePoint = null;
    this.currentMousePos = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
