/**
 * MinimalCAD Web
 * commands/polygon.ts
 *
 * Regular polygons are stored as closed Polylines, so they work with the
 * existing trim, offset, fillet, chamfer, explode, and selection tools.
 * Workflow follows AutoCAD's Polygon command: side count, center, inscribed
 * or circumscribed, then radius / edge distance.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { Polyline } from "../entities/polyline";
import { parsePoint, parsePositiveFloat } from "../input/dynamicInput";

type PolygonMode = "inscribed" | "circumscribed";

export class PolygonCommand extends BaseCommand {
  private state: 0 | 1 | 2 | 3 = 0;
  private sides = 4;
  private center: Point | null = null;
  private mode: PolygonMode = "inscribed";
  private currentMousePos: Point | null = null;
  private rawMousePos: Point | null = null;
  private currentSnapType: string | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.center = null;
    this.currentMousePos = null;
    this.rawMousePos = null;
    this.currentSnapType = null;
    this.mode = "inscribed";
    this.commandBar.setStatus("POLYGON", `Number of Sides (3-1024) <${this.sides}>`);
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  private promptCenter(): void {
    this.state = 1;
    this.commandBar.setStatus("POLYGON", "Pick Center Point (or type x,y)");
  }

  private promptMode(): void {
    this.state = 2;
    this.commandBar.setStatus("POLYGON", "Inscribed in circle or Circumscribed about circle? [I/C]");
  }

  private promptDistance(): void {
    this.state = 3;
    this.commandBar.setStatus(
      "POLYGON",
      `Pick ${this.mode === "inscribed" ? "Radius" : "Edge Distance"} (or type a distance)`,
    );
    this.commandBar.enableInput();
  }

  leftClick(worldPos: Point): void {
    if (this.state === 1) {
      const { point } = this.engine.snap(worldPos);
      this.center = { ...point };
      this.currentMousePos = { ...point };
      this.rawMousePos = { ...point };
      this.promptMode();
    } else if (this.state === 3 && this.center !== null) {
      const { point, snapType } = this.engine.snap(worldPos, this.center);
      this.rawMousePos = point;
      this.currentSnapType = snapType;
      this.currentMousePos = this.resolveDirection(point, snapType);
      this.commitDistance(Math.hypot(this.currentMousePos.x - this.center.x, this.currentMousePos.y - this.center.y));
    }
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    const value = text.trim();
    if (this.state === 0) {
      const parsedSides = value === "" ? this.sides : Number(value);
      if (!/^\d+$/.test(value) && value !== "") {
        this.commandBar.setStatus("POLYGON", "Invalid side count - enter an integer from 3 to 1024");
        return;
      }
      if (!Number.isInteger(parsedSides) || parsedSides < 3 || parsedSides > 1024) {
        this.commandBar.setStatus("POLYGON", "Side count must be from 3 to 1024");
        return;
      }
      this.sides = parsedSides;
      this.promptCenter();
      return;
    }

    if (this.state === 1) {
      const point = parsePoint(value, null);
      if (point === null) {
        this.commandBar.setStatus("POLYGON", "Invalid center - use x,y");
        return;
      }
      this.center = point;
      this.currentMousePos = point;
      this.rawMousePos = point;
      this.currentSnapType = null;
      this.promptMode();
      return;
    }

    if (this.state === 2) {
      const mode = value.toLowerCase();
      if (mode === "i" || mode === "inscribed") this.mode = "inscribed";
      else if (mode === "c" || mode === "circumscribed") this.mode = "circumscribed";
      else {
        this.commandBar.setStatus("POLYGON", "Choose I for Inscribed or C for Circumscribed");
        return;
      }
      this.promptDistance();
      return;
    }

    const distance = parsePositiveFloat(value);
    if (distance === null) {
      this.commandBar.setStatus("POLYGON", "Invalid - enter a positive distance");
      return;
    }
    this.commitDistance(distance);
  }

  mouseMove(worldPos: Point): void {
    if (this.state !== 3 || this.center === null) return;
    const { point, snapType } = this.engine.snap(worldPos, this.center);
    this.rawMousePos = point;
    this.currentSnapType = snapType;
    this.currentMousePos = this.resolveDirection(point, snapType);
    const distance = Math.hypot(this.currentMousePos.x - this.center.x, this.currentMousePos.y - this.center.y);
    this.commandBar.setStatus(
      "POLYGON",
      `${this.mode === "inscribed" ? "Radius" : "Edge Distance"}: ${distance.toFixed(2)} (click or type a distance)`,
    );
    this.commandBar.setLiveValue(distance.toFixed(2));
    this.engine.requestRedraw();
  }

  private createPolygon(distance: number, cursor: Point): Polyline | null {
    if (this.center === null || !Number.isFinite(distance) || distance <= 0) return null;
    const direction = Math.atan2(cursor.y - this.center.y, cursor.x - this.center.x);
    const halfStep = Math.PI / this.sides;
    const circumradius = this.mode === "inscribed" ? distance : distance / Math.cos(halfStep);
    const firstAngle = direction - (this.mode === "circumscribed" ? halfStep : 0);
    const vertices = Array.from({ length: this.sides }, (_, index) => {
      const angle = firstAngle + (2 * Math.PI * index) / this.sides;
      return {
        point: {
          x: this.center!.x + circumradius * Math.cos(angle),
          y: this.center!.y + circumradius * Math.sin(angle),
        },
        bulge: 0,
      };
    });
    return new Polyline(vertices, true);
  }

  /** Match LINE: a real object snap takes priority; otherwise Ortho constrains
   *  the cursor ray from the polygon center to horizontal or vertical. */
  private resolveDirection(point: Point, snapType: string | null): Point {
    if (this.center === null || snapType !== null) return point;
    return this.engine.applyOrtho(this.center, point);
  }

  private commitDistance(distance: number): void {
    if (this.center === null) return;
    const rawCursor = this.rawMousePos ?? this.currentMousePos ?? { x: this.center.x + 1, y: this.center.y };
    const cursor = this.resolveDirection(rawCursor, this.currentSnapType);
    this.currentMousePos = cursor;
    const polygon = this.createPolygon(distance, cursor);
    if (polygon === null) return;
    this.undo.push(this.document.toDict());
    this.document.addEntity(polygon);
    this.start();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state !== 3 || this.center === null || this.currentMousePos === null) return;
    const distance = Math.hypot(
      this.currentMousePos.x - this.center.x,
      this.currentMousePos.y - this.center.y,
    );
    const polygon = this.createPolygon(distance, this.currentMousePos);
    polygon?.draw(ctx, this.engine.viewport, true);
  }

  cancel(): void {
    this.state = 0;
    this.center = null;
    this.currentMousePos = null;
    this.rawMousePos = null;
    this.currentSnapType = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }
}
