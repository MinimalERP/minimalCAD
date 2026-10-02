/**
 * MinimalCAD Web
 * commands/exportPdf.ts
 *
 * Ported from commands/export_pdf.py: pick a rectangular export window
 * directly on the canvas (or type 'a'/'all' to skip straight to the whole
 * document's own bounding box), choose a page scale mode, then download
 * that window -- fit to a borderless A4 landscape page -- as a PDF (see
 * io/pdf.ts for the actual renderer). Corner-picking state machine mirrors
 * commands/rectangle.ts's own two-corner pattern closely.
 */

import type { Bounds, Point } from "../core/types";
import type { Engine } from "../engine/engine";
import { BaseCommand } from "./base";
import { parsePoint, parseTwoPositiveFloats } from "../input/dynamicInput";
import type { PdfScaleMode } from "../io/pdf";
import { downloadPdfBytes, promptFilename } from "../io/saveLoad";

const SCALE_LABELS: Record<PdfScaleMode, string> = { fit: "Fit to Page", "1:1": "1:1 mm" };

export class ExportPdfCommand extends BaseCommand {
  // State 0: pick first corner of the export window (or type x,y / 'a' / 'all')
  // State 1: pick the opposite corner (or type w,h)
  // State 2: choose a scale mode (typed only)
  private state: 0 | 1 | 2 = 0;
  private corner1: Point | null = null;
  private currentMousePos: Point | null = null;
  private pendingRect: Bounds | null = null;

  // Persists across exports (and across re-activating the tool), same
  // convention as Fillet's radius / Text's height.
  private scaleMode: PdfScaleMode = "fit";

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.state = 0;
    this.corner1 = null;
    this.currentMousePos = null;
    this.pendingRect = null;
    this.commandBar.setStatus("PDF EXPORT", "Pick First Corner of Export Window (or type x,y, or 'a' for entire drawing)");
    this.commandBar.enableInput();
    this.engine.requestRedraw();
  }

  leftClick(worldPos: Point): void {
    if (this.state === 0) {
      const { point } = this.engine.snap(worldPos);
      this.corner1 = point;
      this.currentMousePos = point;
      this.state = 1;
      this.commandBar.setStatus("PDF EXPORT", "Pick Opposite Corner (or type w,h)");
    } else if (this.state === 1) {
      const { point } = this.engine.snap(worldPos, this.corner1);
      this.finishWindow(point);
    }
    this.engine.requestRedraw();
  }

  mouseMove(worldPos: Point): void {
    const reference = this.state === 1 ? this.corner1 : null;
    const { point } = this.engine.snap(worldPos, reference);
    this.currentMousePos = point;
    this.engine.requestRedraw();
  }

  textInput(text: string): void {
    if (this.state === 0) {
      if (["a", "all"].includes(text.trim().toLowerCase())) {
        this.finishWholeDocument();
        return;
      }
      const point = parsePoint(text, null);
      if (point === null) {
        this.commandBar.setStatus("PDF EXPORT", "Invalid point - use x,y");
        return;
      }
      this.corner1 = point;
      this.currentMousePos = { ...point };
      this.state = 1;
      this.commandBar.setStatus("PDF EXPORT", "Pick Opposite Corner (or type w,h)");
    } else if (this.state === 1) {
      const dims = parseTwoPositiveFloats(text);
      if (dims === null) {
        this.commandBar.setStatus("PDF EXPORT", "Invalid - use width,height");
        return;
      }
      const [width, height] = dims;
      const mouse = this.currentMousePos ?? this.corner1!;
      const xDir = mouse.x >= this.corner1!.x ? 1 : -1;
      const yDir = mouse.y >= this.corner1!.y ? 1 : -1;
      this.finishWindow({ x: this.corner1!.x + width * xDir, y: this.corner1!.y + height * yDir });
    } else {
      const raw = text.trim().toLowerCase();
      if (raw === "" || raw === "f" || raw === "fit") {
        this.scaleMode = "fit";
      } else if (raw === "1" || raw === "1:1" || raw === "11") {
        this.scaleMode = "1:1";
      } else {
        this.commandBar.setStatus("PDF EXPORT", "Invalid - Enter for Fit to Page, or type 1 for 1:1 mm");
        return;
      }
      this.runExport(this.pendingRect!);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.state !== 1 || this.corner1 === null || this.currentMousePos === null) return;
    const viewport = this.engine.viewport;
    const p1 = viewport.worldToScreen(this.corner1);
    const p2 = viewport.worldToScreen({ x: this.currentMousePos.x, y: this.corner1.y });
    const p3 = viewport.worldToScreen(this.currentMousePos);
    const p4 = viewport.worldToScreen({ x: this.corner1.x, y: this.currentMousePos.y });

    ctx.strokeStyle = "#1e90ff";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  cancel(): void {
    this.state = 0;
    this.corner1 = null;
    this.currentMousePos = null;
    this.pendingRect = null;
    this.commandBar.setReady();
    this.engine.requestRedraw();
  }

  // --- Internal ---

  private finishWindow(corner2: Point): void {
    const x0 = Math.min(this.corner1!.x, corner2.x);
    const x1 = Math.max(this.corner1!.x, corner2.x);
    const y0 = Math.min(this.corner1!.y, corner2.y);
    const y1 = Math.max(this.corner1!.y, corner2.y);

    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) {
      this.commandBar.setStatus("PDF EXPORT", "Window too small - pick again");
      this.start();
      return;
    }
    this.promptScaleMode([x0, y0, x1, y1]);
  }

  private finishWholeDocument(): void {
    if (this.document.getEntities().length === 0) {
      this.commandBar.setStatus("PDF EXPORT", "Nothing to export - drawing is empty");
      this.start();
      return;
    }
    this.promptScaleMode(this.document.getBounds());
  }

  private promptScaleMode(rect: Bounds): void {
    this.pendingRect = rect;
    this.state = 2;
    this.commandBar.setStatus(
      "PDF EXPORT",
      `Scale <${SCALE_LABELS[this.scaleMode]}> (Enter to keep, or type 1 for 1:1 mm, f for Fit to Page)`,
    );
    this.commandBar.enableInput();
  }

  private runExport(rect: Bounds): void {
    void import("../io/pdf").then(({ exportPdf }) => {
      const result = exportPdf(this.document, rect, this.scaleMode);
      if (result === null) {
        this.commandBar.setStatus("PDF EXPORT", "Nothing to export - drawing is empty");
        this.start();
        return;
      }

      const filename = promptFilename("Export PDF", "pdf");
      if (filename !== null) downloadPdfBytes(result.bytes, filename);

      if (result.warning !== null) {
        this.commandBar.setStatus("PDF EXPORT", `${result.warning} - Pick First Corner for another export`);
        this.state = 0;
        this.corner1 = null;
        this.currentMousePos = null;
        this.pendingRect = null;
        this.commandBar.enableInput();
        return;
      }
      this.start();
    });
  }
}
