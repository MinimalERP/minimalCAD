/**
 * MinimalCAD Web
 * drawing/drawingController.ts
 *
 * A drawing is its own TAB (like an Inventor .idw next to its part): the
 * tab's Engine edits one sheet, so every annotation tool -- dimensions,
 * text, leaders, lines -- works on it unchanged and snaps to the views.
 *
 * The tab's Document holds it all: the sheet's settings and views in
 * Document.sheets (so Undo covers placing / moving / deleting views), the
 * annotations as its entities, and a snapshot of the model (part +
 * its 2D drawing) so a saved drawing opens and prints on its own.
 *
 * Linked to the model tab it was made from: each time the drawing tab is
 * shown it re-reads that tab's part, and every view follows the model.
 */

import type { Point } from "../core/types";
import type { Engine } from "../engine/engine";
import type { Viewport } from "../engine/viewport";
import type { Command } from "../commands/types";
import { Dimension } from "../entities/dimension";
import type { Body } from "../part/kernel/types";
import { rebuild } from "../part/rebuild";
import { parsePart } from "../part/types";
import { FeatureDialog } from "../view3d/featureDialog";
import { exportSheetPdf } from "../io/pdf";
import { downloadPdfBytes, promptFilename } from "../io/saveLoad";
import { showToast } from "../ui/toast";
import type { Orient } from "./orientCube";
import { isIso, orientationCube } from "./orientCube";
import type { PaintStyle, Paper, Projection, SheetData, SheetGraphics, SheetView, Side, ViewStyle } from "./sheet";
import {
  ORIENTATIONS,
  relativeName,
  reproject,
  rootOf,
  PAPER_SIZE,
  ViewCache,
  formatScale,
  newSheet,
  paintSheet,
  parseScale,
  parseSheets,
  projectedAxes,
  isoAxes,
  shadeColor,
  sheetGraphics,
  suggestScale,
  viewAt,
} from "./sheet";

export type DrawingAction = "sheet" | "baseview" | "projview" | "moveview" | "editview" | "deleteview" | "print";

export interface DrawingHost {
  /** The linked model tab's part + 2D drawing, or null if it's gone. */
  source(): { name: string; part: unknown; entities: Record<string, unknown>[] } | null;
  dialogParent: HTMLElement;
  requestRedraw(): void;
}

const SCREEN: PaintStyle = { paper: "#2b2f36", ink: "#e6e6e6", minWidth: 0.8, shade: (s) => shadeColor([176, 188, 204], s) };
const PREVIEW: PaintStyle = { paper: null, ink: "#5aa0ff", minWidth: 1, shade: (s) => shadeColor([60, 110, 180], s) };
/** Paper: black ink, shaded faces in light greys (prints well in mono). */
const PRINT: PaintStyle = { paper: null, ink: "#000", minWidth: 0, shade: (s) => shadeColor([236, 238, 242], 0.35 + 0.65 * s) };

export class DrawingController {
  private cache = new ViewCache();
  private bodies: readonly Body[] = [];
  private graphics: SheetGraphics | null = null;
  private graphicsKey = "";
  private modelKey = "";

  constructor(
    readonly engine: Engine,
    readonly viewport: Viewport,
    private host: DrawingHost,
  ) {
    engine.backdrop = (ctx) => this.paint(ctx);
    engine.underlayHidden = true;
    engine.ucsLabels = ["", ""];
  }

  // --- lifecycle ---

  /** Shows the tab's sheet (a new one if it has none), refreshed from the
   *  linked model tab if that's still open. */
  enter(firstTime: boolean): void {
    const doc = this.engine.document;
    const saved = parseSheets(doc.sheets)[0];
    let sheet = saved ?? newSheet();
    const src = this.host.source();
    if (src !== null) sheet = { ...sheet, model: { name: src.name, part: src.part, entities: src.entities } };
    // Not an edit of the drawing: no undo step.
    doc.sheets = [{ ...sheet, entities: [], constraints: [] }];
    if (saved === undefined) this.engine.undo.clear();
    const modelKey = JSON.stringify(sheet.model ?? null);
    if (modelKey !== this.modelKey) {
      this.modelKey = modelKey;
      const part = parsePart(sheet.model?.part);
      this.bodies = part === null ? [] : rebuild(part, sheet.model?.entities ?? []).bodies;
      this.graphics = null;
    }
    this.refresh();
    if (firstTime) this.zoomSheet();
    if (firstTime && this.sheet().views.length === 0) {
      if (this.bodies.length === 0) showToast("No 3D part in the model tab yet - model one in 3D, then add views here.");
      else this.action("baseview");
    }
  }

  sheet(): SheetData {
    return parseSheets(this.engine.document.sheets)[0] ?? newSheet();
  }

  /** Replaces the sheet's settings / views as one undoable step. */
  private setSheet(next: SheetData): void {
    this.engine.undo.push(this.engine.document.toDict());
    this.engine.document.sheets = [{ ...next, entities: [], constraints: [] }];
    this.refresh();
  }

  zoomSheet(): void {
    const { w, h } = PAPER_SIZE[this.sheet().paper];
    this.viewport.zoomExtents([0, -h, w, 0]);
    this.host.requestRedraw();
  }

  // --- graphics ---

  private refresh(): SheetGraphics {
    const sheet = this.sheet();
    const key = JSON.stringify({ ...sheet, model: undefined });
    if (this.graphics === null || key !== this.graphicsKey) {
      this.graphics = sheetGraphics(sheet, this.bodies, this.cache);
      this.graphicsKey = key;
      this.engine.underlay = this.graphics.snap;
    }
    return this.graphics;
  }

  private paint(ctx: CanvasRenderingContext2D): void {
    const g = this.refresh(); // also catches Undo / Redo of view changes
    this.scaleNewDimensions(g);
    paintSheet(ctx, this.viewport, this.sheet(), g, SCREEN);
  }

  /** A dimension drawn on a view measures the PART: paper mm / view scale. */
  private scaleNewDimensions(g: SheetGraphics): void {
    for (const e of this.engine.document.entities) {
      if (!(e instanceof Dimension) || e.data.measure_scale !== undefined) continue;
      const anchor = ["p1", "center", "vertex", "radius_point"].map((k) => e.data[k]).find((v) => typeof v === "object" && v !== null) as Point | undefined;
      const id = anchor === undefined ? null : viewAt(g, anchor, 1);
      const view = g.views.find((v) => v.id === id);
      e.data.measure_scale = view === undefined ? 1 : 1 / view.scale;
      e.data.trim_zeros = 1;
    }
  }

  // --- actions ---

  action(a: DrawingAction): void {
    const cm = this.engine.commandManager;
    if (a === "sheet") this.sheetDialog();
    else if (a === "baseview") cm.startCustom("BASE VIEW", new BaseViewCommand(this));
    else if (a === "projview") cm.startCustom("PROJECTED VIEW", new ProjectedViewCommand(this));
    else if (a === "moveview") cm.startCustom("MOVE VIEW", new PickViewCommand(this, "move"));
    else if (a === "editview") cm.startCustom("EDIT VIEW", new PickViewCommand(this, "edit"));
    else if (a === "deleteview") cm.startCustom("DELETE VIEW", new PickViewCommand(this, "delete"));
    else if (a === "print") void this.print();
    this.host.requestRedraw();
  }

  private sheetDialog(): void {
    const s = this.sheet();
    const next: SheetData = { ...s, title: { ...s.title } };
    const d = new FeatureDialog(this.host.dialogParent, "Sheet", {
      onOk: () => {
        d.close();
        // Same places, the views that belong there in the new projection.
        this.setSheet(next.projection === s.projection ? next : { ...next, views: reproject(next.views, next.projection) });
        this.zoomSheet();
      },
      onCancel: () => d.close(),
    });
    d.choice<Paper>("Paper", [{ value: "A4", label: "A4" }, { value: "A2", label: "A2" }], s.paper, (v) => (next.paper = v));
    d.choice<Projection>(
      "Projection",
      [
        { value: "first", label: "1st angle", title: "ISO / IS: top view below the front, left view on the right" },
        { value: "third", label: "3rd angle", title: "ASME: top view above the front, right view on the right" },
      ],
      s.projection,
      (v) => (next.projection = v),
    );
    const text = (label: string, key: keyof SheetData["title"]): void => {
      d.number(label, "", s.title[key], (v) => (next.title[key] = v));
    };
    text("Company", "company");
    text("Title", "title");
    text("Drawing no.", "drawingNo");
    text("Material", "material");
    text("Drawn by", "drawnBy");
    text("Date", "date");
    text("Revision", "revision");
    d.hint("Switching 1st / 3rd angle keeps the views where they are and swaps which view each one is.");
    d.focusFirst();
  }

  private async print(): Promise<void> {
    this.engine.cancelCommand();
    const sheet = this.sheet();
    const g = this.refresh();
    const { w, h } = PAPER_SIZE[sheet.paper];
    const bytes = await exportSheetPdf(w, h, (ctx, vp) => paintSheet(ctx, vp, sheet, g, PRINT), this.engine.document.entities);
    const name = promptFilename("Print sheet to PDF", "pdf", sheet.title.drawingNo || sheet.title.title || "Drawing");
    if (name !== null) downloadPdfBytes(bytes, name);
  }

  /** The PDF for the sheet as it stands (tests / automation). */
  pdfBytes(): Promise<Uint8Array> {
    const sheet = this.sheet();
    const g = this.refresh();
    const { w, h } = PAPER_SIZE[sheet.paper];
    return exportSheetPdf(w, h, (ctx, vp) => paintSheet(ctx, vp, sheet, g, PRINT), this.engine.document.entities);
  }

  // --- helpers for the commands ---

  graphicsNow(): SheetGraphics {
    return this.refresh();
  }

  hasBodies(): boolean {
    return this.bodies.length > 0;
  }

  suggestScale(): number {
    return suggestScale(this.bodies, this.sheet().paper);
  }

  nextViewId(): string {
    const ids = new Set(this.sheet().views.map((v) => v.id));
    let n = 1;
    while (ids.has(`View${n}`)) n++;
    return `View${n}`;
  }

  addView(v: SheetView): void {
    const s = this.sheet();
    this.setSheet({ ...s, views: [...s.views, v] });
  }

  replaceViews(views: SheetView[]): void {
    this.setSheet({ ...this.sheet(), views });
  }

  /** Paper point (Y up) of a world point. */
  paperOf(p: Point): Point {
    return { x: p.x, y: -p.y };
  }

  /** Draws `views` (not yet on the sheet) as a light preview. */
  drawPreview(ctx: CanvasRenderingContext2D, views: SheetView[]): void {
    const tmp: SheetData = { ...this.sheet(), views };
    const g = sheetGraphics(tmp, this.bodies, this.cache);
    // Only the view lines: drop the frame (drawn already) -- the frame's
    // prims come first, views' after; rebuild from views only.
    const frameCount = sheetGraphics({ ...tmp, views: [] }, this.bodies, this.cache).prims.length;
    paintSheet(ctx, this.viewport, tmp, { ...g, prims: g.prims.slice(frameCount) }, PREVIEW);
  }

  /** The view's box in world coords, if it's on the sheet. */
  boxOf(id: string): [number, number, number, number] | null {
    return this.refresh().views.find((v) => v.id === id)?.box ?? null;
  }

  dialog(title: string, onOk: () => void, onCancel: () => void): FeatureDialog {
    return new FeatureDialog(this.host.dialogParent, title, { onOk, onCancel });
  }

  status(text: string, name = "DRAWING"): void {
    this.engine.commandBar.setStatus(name, text);
  }

  done(): void {
    this.engine.cancelCommand();
    this.host.requestRedraw();
  }

  redraw(): void {
    this.host.requestRedraw();
  }
}

// ---------------------------------------------------------------------------
// Commands

abstract class DrawingCommand implements Command {
  constructor(protected c: DrawingController) {}
  abstract start(): void;
  leftClick(_pt: Point): void {}
  rightClick(_pt: Point): void {
    this.c.done();
  }
  mouseMove(_pt: Point): void {}
  keyPress(key: string): void {
    if (key === "Enter") this.c.done();
  }
  /** Enter on the command line arrives as empty text: finish. */
  textInput(text: string): void {
    if (text.trim() === "") this.c.done();
  }
  draw(_ctx: CanvasRenderingContext2D): void {}
  cancel(): void {
    this.c.engine.commandBar.setReady();
  }
}

const STYLE_CHOICES: { value: ViewStyle; label: string; title: string }[] = [
  { value: "lines", label: "Lines", title: "Visible edges (and hidden ones dashed, if on)" },
  { value: "shaded", label: "Shaded", title: "Faces shaded, visible edges on top - reads like a picture of the part" },
];


/** Base View: pick orientation / scale in the dialog, click to place. */
class BaseViewCommand extends DrawingCommand {
  private dialog: FeatureDialog | null = null;
  private orient: Orient = { dir: ORIENTATIONS.front.dir, up: ORIENTATIONS.front.up };
  private scale = 1;
  private hidden = true;
  private style: ViewStyle = "lines";
  private at: Point | null = null;

  start(): void {
    if (!this.c.hasBodies()) {
      showToast("No 3D part to draw yet - model one in 3D first.");
      this.c.done();
      return;
    }
    this.scale = this.c.suggestScale();
    const d = (this.dialog = this.c.dialog(
      "Base View",
      () => this.place(this.at ?? this.defaultSpot()),
      () => this.c.done(),
    ));
    d.hint("Turn the part to the side you want as the FRONT (main) view:");
    orientationCube(d.custom("fd-cube"), this.orient, (o) => {
      const wasIso = isIso(this.orient);
      this.orient = o;
      // Iso reads best shaded; the flat views as line drawings.
      if (isIso(o) !== wasIso) {
        this.style = isIso(o) ? "shaded" : "lines";
        this.hidden = !isIso(o);
        styleChoice.set(this.style);
        hiddenToggle.set(this.hidden);
      }
      this.c.redraw();
    });
    const styleChoice = d.choice<ViewStyle>("Style", STYLE_CHOICES, this.style, (v) => {
      this.style = v;
      this.c.redraw();
    });
    const scaleField = d.number("Scale", "", formatScale(this.scale), (t) => {
      const s = parseScale(t);
      d.setError(s === null ? "Scale like 1:2, 2:1 or 0.5" : null);
      if (s !== null) this.scale = s;
      this.c.redraw();
    });
    void scaleField;
    const hiddenToggle = d.toggle("Hidden lines", "Show hidden edges dashed", (on) => {
      this.hidden = on;
      this.c.redraw();
    });
    hiddenToggle.set(this.hidden);
    d.hint("Move onto the sheet and click to place the view (or OK for the top-left).");
    this.c.status("Click on the sheet to place the base view", "BASE VIEW");
  }

  private defaultSpot(): Point {
    const { h } = PAPER_SIZE[this.c.sheet().paper];
    return { x: 80, y: -(h - 70) };
  }

  private view(at: Point): SheetView {
    const o = this.orient;
    const p = this.c.paperOf(at);
    // Whatever side was chosen, the base view is the drawing's main view.
    const label = isIso(o) ? "ISO VIEW" : "FRONT VIEW";
    return { id: this.c.nextViewId(), dir: o.dir, up: o.up, scale: this.scale, x: p.x, y: p.y, hiddenLines: this.hidden, style: this.style, label };
  }

  private place(at: Point): void {
    this.dialog?.close();
    this.dialog = null;
    this.c.addView(this.view(at));
    this.c.done();
    showToast("Base view placed - use Projected View to add the others.");
  }

  mouseMove(pt: Point): void {
    this.at = pt;
    this.c.redraw();
  }

  leftClick(pt: Point): void {
    this.place(pt);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.at !== null) this.c.drawPreview(ctx, [this.view(this.at)]);
  }

  cancel(): void {
    this.dialog?.close();
    this.dialog = null;
    super.cancel();
  }
}

/** Where a point lies from `box` (world): off a corner (past the box both
 *  across and up/down) -> an iso direction; else the side of its larger
 *  offset. */
function sideOf(box: [number, number, number, number], p: Point): Side | { iso: [1 | -1, 1 | -1] } {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const dx = p.x - cx;
  const dy = cy - p.y; // paper up
  const outX = p.x < box[0] || p.x > box[2];
  const outY = p.y < box[1] || p.y > box[3];
  if (outX && outY) return { iso: [dx >= 0 ? 1 : -1, dy >= 0 ? 1 : -1] };
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "up" : "down";
}

/** Projected View: click a view, then click where the new one goes. It is
 *  kept in line with its parent; left / right / above / below decide which
 *  view it is (per the sheet's 1st / 3rd angle setting). Off a corner it's
 *  an iso view from that corner, placed freely and shaded. */
class ProjectedViewCommand extends DrawingCommand {
  private parent: SheetView | null = null;
  private at: Point | null = null;

  start(): void {
    const views = this.c.sheet().views;
    if (views.length === 0) {
      showToast("Place a base view first.");
      this.c.done();
      return;
    }
    this.parent = views.length === 1 ? views[0]! : null;
    this.prompt();
  }

  private prompt(): void {
    this.c.status(
      this.parent === null
        ? "Click the view to project from"
        : `From ${this.parent.label}: move right / left / up / down (or off a corner for iso) and click to place - Enter when done`,
      "PROJECTED VIEW",
    );
  }

  private candidate(): SheetView | null {
    const p = this.parent;
    const box = p === null ? null : this.c.boxOf(p.id);
    if (p === null || box === null || this.at === null) return null;
    const side = sideOf(box, this.at);
    const pos = this.c.paperOf(this.at);
    if (typeof side === "object") {
      const axes = isoAxes(p, side.iso[0], side.iso[1]);
      return {
        id: this.c.nextViewId(),
        dir: axes.dir,
        up: axes.up,
        scale: p.scale,
        x: pos.x,
        y: pos.y,
        parent: p.id,
        free: true,
        hiddenLines: false,
        style: "shaded",
        label: "ISO VIEW",
      };
    }
    const axes = projectedAxes(p, side, this.c.sheet().projection);
    const horizontal = side === "left" || side === "right";
    const name = relativeName(axes, rootOf(p, this.c.sheet().views));
    return {
      id: this.c.nextViewId(),
      dir: axes.dir,
      up: axes.up,
      scale: p.scale,
      x: horizontal ? pos.x : p.x,
      y: horizontal ? p.y : pos.y,
      parent: p.id,
      hiddenLines: p.hiddenLines,
      style: p.style === "shaded" ? "shaded" : "lines",
      label: name,
    };
  }

  mouseMove(pt: Point): void {
    this.at = pt;
    this.c.redraw();
  }

  leftClick(pt: Point): void {
    this.at = pt;
    if (this.parent === null) {
      const id = viewAt(this.c.graphicsNow(), pt);
      this.parent = this.c.sheet().views.find((v) => v.id === id) ?? null;
      this.prompt();
      return;
    }
    // Clicking inside the parent itself does nothing.
    const box = this.c.boxOf(this.parent.id);
    if (box !== null && pt.x >= box[0] && pt.x <= box[2] && pt.y >= box[1] && pt.y <= box[3]) return;
    const v = this.candidate();
    if (v !== null) this.c.addView(v);
    this.c.redraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const v = this.parent === null ? null : this.candidate();
    if (v !== null) this.c.drawPreview(ctx, [v]);
  }
}

/** Click a view, then move / edit / delete it. */
class PickViewCommand extends DrawingCommand {
  private picked: SheetView | null = null;
  private from: Point | null = null;
  private at: Point | null = null;
  private dialog: FeatureDialog | null = null;

  constructor(
    c: DrawingController,
    private mode: "move" | "edit" | "delete",
  ) {
    super(c);
  }

  start(): void {
    this.picked = null;
    this.c.status(
      this.mode === "move" ? "Click a view to move" : this.mode === "edit" ? "Click a view to edit" : "Click a view to delete (its projected views go too)",
      `${this.mode.toUpperCase()} VIEW`,
    );
  }

  /** The view plus every view projected from it (recursively). `aligned`:
   *  only views kept in line (not iso ones) -- what moves / rescales along. */
  private family(id: string, views: SheetView[], aligned = false): Set<string> {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const v of views) {
        if (aligned && v.free === true) continue;
        if (v.parent !== undefined && out.has(v.parent) && !out.has(v.id)) {
          out.add(v.id);
          grew = true;
        }
      }
    }
    return out;
  }

  /** Views after moving `picked` by (dx, dy) paper mm: its family goes
   *  along; a projected view only slides along its line with the parent. */
  private moved(dx: number, dy: number): SheetView[] {
    const views = this.c.sheet().views;
    const p = this.picked!;
    const parent = views.find((v) => v.id === p.parent);
    if (parent !== undefined && p.free !== true) {
      if (Math.abs(p.y - parent.y) < 1e-6) dy = 0;
      else dx = 0;
    }
    const fam = this.family(p.id, views, true);
    return views.map((v) => (fam.has(v.id) ? { ...v, x: v.x + dx, y: v.y + dy } : v));
  }

  leftClick(pt: Point): void {
    const views = this.c.sheet().views;
    if (this.picked === null) {
      const id = viewAt(this.c.graphicsNow(), pt);
      this.picked = views.find((v) => v.id === id) ?? null;
      if (this.picked === null) return;
      if (this.mode === "delete") {
        const fam = this.family(this.picked.id, views);
        this.c.replaceViews(views.filter((v) => !fam.has(v.id)));
        this.picked = null;
        this.c.redraw();
        return;
      }
      if (this.mode === "edit") {
        this.editDialog(this.picked);
        return;
      }
      this.from = pt;
      this.c.status("Click the new position", "MOVE VIEW");
      return;
    }
    if (this.mode === "move" && this.from !== null) {
      this.c.replaceViews(this.moved(pt.x - this.from.x, -(pt.y - this.from.y)));
      this.c.done();
    }
  }

  private editDialog(v: SheetView): void {
    let scale = v.scale;
    let hidden = v.hiddenLines;
    let label = v.label;
    let style: ViewStyle = v.style ?? "lines";
    let orient: Orient = { dir: v.dir, up: v.up };
    const ownScale = v.parent === undefined || v.free === true;
    const d = (this.dialog = this.c.dialog(
      `Edit ${v.label}`,
      () => {
        d.close();
        this.dialog = null;
        const views = this.c.sheet().views;
        const fam = this.family(v.id, views, true);
        // An in-line projected view keeps its parent's scale; a new scale
        // on a base / iso view carries to the views in line with it.
        this.c.replaceViews(
          reproject(
            views.map((x) => {
              if (x.id === v.id) return { ...x, ...orient, scale: ownScale ? scale : x.scale, hiddenLines: hidden, label, style };
              if (fam.has(x.id) && ownScale) return { ...x, scale };
              return x;
            }),
            this.c.sheet().projection,
          ),
        );
        this.c.done();
      },
      () => this.c.done(),
    ));
    if (v.parent === undefined) {
      d.hint("Orientation (the FRONT / main view) - its projected views follow:");
      orientationCube(d.custom("fd-cube"), orient, (o) => (orient = o));
    }
    if (ownScale) {
      d.number("Scale", "", formatScale(scale), (t) => {
        const s = parseScale(t);
        d.setError(s === null ? "Scale like 1:2, 2:1 or 0.5" : null);
        if (s !== null) scale = s;
      });
    } else d.hint(`Scale ${formatScale(v.scale)} - follows its parent view.`);
    d.choice<ViewStyle>("Style", STYLE_CHOICES, style, (s) => (style = s));
    const t = d.toggle("Hidden lines", "Show hidden edges dashed (line views)", (on) => (hidden = on));
    t.set(hidden);
    d.number("Label", "", label, (s) => (label = s));
    d.focusFirst();
  }

  mouseMove(pt: Point): void {
    this.at = pt;
    if (this.mode === "move" && this.picked !== null) this.c.redraw();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.mode !== "move" || this.picked === null || this.from === null || this.at === null) return;
    const all = this.moved(this.at.x - this.from.x, -(this.at.y - this.from.y));
    const fam = this.family(this.picked.id, all, true);
    this.c.drawPreview(
      ctx,
      all.filter((v) => fam.has(v.id)),
    );
  }

  cancel(): void {
    this.dialog?.close();
    this.dialog = null;
    super.cancel();
  }
}

