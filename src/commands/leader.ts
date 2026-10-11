/**
 * MinimalCAD Web
 * commands/leader.ts
 *
 * Ported from commands/leader.py: pick the point being called out (arrow
 * tip), pick where the instruction text should land, then type the text
 * itself. Mirrors the radial dimension leaders (arrow + landing segment +
 * text) but points at an arbitrary location instead of a circle/arc
 * boundary, with free-form text instead of an auto-computed measurement.
 * Same simplification as commands/text.ts over its Python source: this
 * port's textInput() is already called generically for every submission
 * while the command is active, so states 1 (landing point, typed) and 2
 * (the text itself) just branch on `this.state` inside it directly, with no
 * need for Python's one-off signal connect/disconnect dance.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Dimension } from "../entities/dimension";
import { parsePoint } from "../input/dynamicInput";

export class LeaderCommand extends BaseCommand {
  // State 0: pick the point being called out
  // State 1: pick where the text should land
  // State 2: type the instruction text
  private state: 0 | 1 | 2 = 0;
  private point: Point | null = null;
  private currentMousePos: Point | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.point = null;
    this.currentMousePos = null;
    this.commandBar.setStatus("LEADER", "Pick point to call out");
    this.commandBar.disableInput();
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.point = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("LEADER", "Pick text position");
      this.commandBar.enableInput();
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos, this.point);
      this.currentMousePos = point;
      this.enterTextEntryStep();
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.currentMousePos = point;
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos, this.point);
      this.currentMousePos = point;
    } else {
      return;
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 1) {
      const point = parsePoint(text, this.point);
      if (point === null) {
        this.commandBar.setStatus("LEADER", "Invalid point - use x,y or dist<angle");
        return;
      }
      this.currentMousePos = point;
      this.enterTextEntryStep();
      return;
    }

    if (this.state === 2) {
      const clean = text.trim();
      if (!clean) return; // ignore empty strings, keep focus for another attempt

      this.undo.push(this.document.toDict());
      const leader = new Dimension("leader", this.engine.styleDimension({ point: this.point!, text_position: this.currentMousePos!, text: clean }));
      this.document.addEntity(leader);

      this.start();
      this.engine.requestRedraw();
    }
  }

  private enterTextEntryStep(): void {
    this.state = 2;
    this.commandBar.setStatus("LEADER", "Enter Text:");
    this.commandBar.enableInput("text");
    this.engine.requestRedraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.point === null || this.currentMousePos === null) return;
    let previewStr: string;
    if (this.state === 1) {
      previewStr = "Text";
    } else if (this.state === 2) {
      previewStr = this.commandBar.text() || "Text";
    } else {
      return;
    }
    const preview = new Dimension("leader", this.engine.styleDimension({ point: this.point, text_position: this.currentMousePos, text: previewStr }));
    preview.draw(ctx, this.engine.viewport, true);
  }

  cancel(): void {
    this.state = 0;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
