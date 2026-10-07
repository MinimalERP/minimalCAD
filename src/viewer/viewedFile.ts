/**
 * MinimalCAD Web
 * viewer/viewedFile.ts
 *
 * A saved drawing as the view-only page (view.html, viewer/main.ts) shows
 * and prints it: either a drawing sheet made from a 3D model (paper, title
 * block, views, with its dimensions and notes) or a plain 2D drawing. It
 * is drawn by the editor's own code -- every entity's draw(), the sheet's
 * paintSheet() -- so what is seen here is what the editor shows, and the
 * PDF is the one the editor exports (io/pdf.ts). Nothing here can change a
 * drawing: there are no commands, and the document never leaves this page.
 */

import type { Bounds } from "../core/types";
import { Document } from "../core/document";
import type { Viewport } from "../engine/viewport";
import { validateDocumentSnapshot } from "../io/fileFormat";
import type { PdfScaleMode } from "../io/pdf";
import { exportPdf, exportSheetPdf } from "../io/pdf";
import type { PaintStyle, SheetData, SheetGraphics } from "../drawing/sheet";
import { PAPER_SIZE, ViewCache, paintSheet, parseSheets, shadeColor, sheetGraphics } from "../drawing/sheet";
import { parsePart } from "../part/types";
import { rebuild } from "../part/rebuild";

export const BACKGROUND = "#1e1e1e"; // the editor's own canvas colour
const SCREEN: PaintStyle = { paper: "#2b2f36", ink: "#e6e6e6", minWidth: 0.8, maxWeightZoom: 3, shade: (s) => shadeColor([176, 188, 204], s) };
/** Paper: black ink, shaded faces in light greys (prints well in mono). */
const PRINT: PaintStyle = { paper: null, ink: "#000", minWidth: 0, shade: (s) => shadeColor([236, 238, 242], 0.35 + 0.65 * s) };

export type OpenResult = { ok: true; file: ViewedFile } | { ok: false; message: string };

export interface ViewedPdf {
  bytes: Uint8Array;
  /** Set when a 1:1 page could not hold the whole drawing. */
  warning: string | null;
}

export class ViewedFile {
  private constructor(
    private readonly document: Document,
    private readonly sheet: SheetData | null,
    private readonly graphics: SheetGraphics | null,
  ) {}

  /** Reads a saved file (the parsed .jcad object). Never throws. */
  static open(raw: unknown): OpenResult {
    const parsed = validateDocumentSnapshot(raw);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    const document = new Document();
    try {
      document.restoreFromDict(parsed.snapshot);
      const sheet = parseSheets(document.sheets)[0] ?? null;
      if (sheet !== null) {
        const part = parsePart(sheet.model?.part);
        const bodies = part === null ? [] : rebuild(part, sheet.model?.entities ?? []).bodies;
        return { ok: true, file: new ViewedFile(document, sheet, sheetGraphics(sheet, bodies, new ViewCache())) };
      }
    } catch (e) {
      return { ok: false, message: `This drawing could not be drawn: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (document.entities.length > 0) return { ok: true, file: new ViewedFile(document, null, null) };
    if (document.part !== undefined) return { ok: false, message: "This file is a 3D model with no drawing yet. Make a drawing of it in MinimalCAD and save it on the item." };
    return { ok: false, message: "This drawing is empty." };
  }

  /** A drawing sheet (true paper size) or a plain 2D drawing. */
  get kind(): "sheet" | "drawing" {
    return this.sheet === null ? "drawing" : "sheet";
  }

  /** What "fit" shows: the paper, or everything drawn. */
  bounds(): Bounds {
    if (this.sheet === null) return this.document.getBounds();
    const { w, h } = PAPER_SIZE[this.sheet.paper];
    return [0, -h, w, 0];
  }

  /** Draws the file on a canvas already scaled to CSS pixels. */
  paint(ctx: CanvasRenderingContext2D, viewport: Viewport, width: number, height: number): void {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    if (this.sheet !== null && this.graphics !== null) paintSheet(ctx, viewport, this.sheet, this.graphics, SCREEN);
    const [vx0, vy0, vx1, vy1] = viewport.visibleWorldRect();
    for (const entity of this.document.getEntities()) {
      const [ex0, ey0, ex1, ey1] = entity.getBounds();
      if (ex1 >= vx0 && ex0 <= vx1 && ey1 >= vy0 && ey0 <= vy1) entity.draw(ctx, viewport, false);
    }
  }

  /** The page to print: a sheet at its paper size; a 2D drawing on A4
   *  landscape, fitted or at 1:1 (`scale` is ignored for a sheet). */
  async pdf(scale: PdfScaleMode): Promise<ViewedPdf> {
    if (this.sheet !== null && this.graphics !== null) {
      const { sheet, graphics } = this;
      const { w, h } = PAPER_SIZE[sheet.paper];
      const bytes = await exportSheetPdf(w, h, (ctx, vp) => paintSheet(ctx, vp, sheet, graphics, PRINT), this.document.entities);
      return { bytes, warning: null };
    }
    const result = exportPdf(this.document, null, scale);
    if (result === null) throw new Error("There is nothing to print");
    return result;
  }
}
