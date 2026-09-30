/**
 * MinimalCAD Web
 * io/pdf.ts
 *
 * Vector PDF export -- ported from file_io/pdf.py's "fit a window to a
 * borderless A4 landscape page" driver, adapted for this port's different
 * rendering architecture: entities pre-transform their own points to screen
 * space via Viewport.worldToScreen() before touching the drawing context,
 * rather than drawing in world space against a live CTM the way Qt's
 * QPainter does (see entities/entity.ts's own header comment). That
 * difference is what lets this reuse every entity's EXISTING, already-
 * correct draw() method completely unchanged -- same architectural choice
 * the Python source makes with its own _PrintPainterProxy -- by feeding it:
 *
 *  - a real Viewport instance (engine/viewport.ts), its zoom/panOffset set
 *    to the resolved world->page affine fit, so entities' own
 *    worldToScreen() calls land directly in final page-point space with no
 *    extra transform needed anywhere else, and
 *  - PdfCanvasContext below, a small CanvasRenderingContext2D-shaped shim
 *    that intercepts every drawing call an entity actually makes (verified
 *    against every entities/*.ts draw()/private helper) and appends the
 *    equivalent PDF content-stream operator instead of touching a real
 *    canvas -- forcing black ink at a fixed physical line weight/font size
 *    exactly like the Python source's own print-time overrides, for exactly
 *    the same reason (a cosmetic 1px pen and a pixel-sized font are correct
 *    on screen but meaningless on a print page).
 *
 * No PDF library dependency -- same "hand-write the format from spec"
 * precedent as io/dxf.ts. A single-page vector PDF's object/xref/trailer
 * structure is compact enough to build directly, and every number/string
 * this module ever emits is plain ASCII/Latin-1, so the whole file is built
 * as a JS string (one char == one byte) and packed into a Uint8Array only
 * at the very end.
 */

import type { Bounds, Point } from "../core/types";
import type { Document } from "../core/document";
import { Viewport } from "../engine/viewport";
import { measureText } from "../entities/textMetrics";

export type PdfScaleMode = "fit" | "1:1";

// A4 landscape, in PDF points (1/72 inch) -- 297mm x 210mm exactly.
const POINTS_PER_MM = 72.0 / 25.4;
const PAGE_WIDTH_PT = 297.0 * POINTS_PER_MM;
const PAGE_HEIGHT_PT = 210.0 * POINTS_PER_MM;

const PRINT_LINE_WEIGHT_MM = 0.25; // target physical stroke width for exported geometry, matching file_io/pdf.py
const MIN_PRINT_TEXT_MM = 1.2; // legibility floor -- see file_io/pdf.py's identical constant

// Fit-mode-only ceiling on resolved text size -- NOT part of file_io/pdf.py
// (confirmed by running that exact code: a Text/Dimension authored well
// above TEXT_SCALE_ANCHOR_WORLD -- a deliberately large title, or a
// Dimension with a large per-instance `scale` -- has no upper bound there
// either, so its "fit" print size grows proportionally without limit and
// can overlap neighboring labels once the drawing's own extent forces a
// small fit scale. 1:1 mode is deliberately NOT capped: there, mm IS the
// literal world size by definition, so an oversized result there is the
// user's own explicit real-world sizing, not a runaway computation.
const MAX_PRINT_TEXT_MM = 8.0;
const TEXT_SCALE_ANCHOR_WORLD = 3.5; // entities/text.ts's DEFAULT_HEIGHT and entities/dimension.ts's TEXT_HEIGHT
const FIT_TEXT_HEIGHT_MM = 2.5; // what TEXT_SCALE_ANCHOR_WORLD prints as in "fit" mode

export interface PdfExportResult {
  bytes: Uint8Array;
  warning: string | null;
}

// --- Rigid (translate + rotate, never scale/shear) 2D transform -- the only
// kind ctx.translate()/ctx.rotate() ever compose here (see entities/text.ts,
// the sole caller of either among every entity this app has). ---

class RigidTransform {
  constructor(
    private readonly tx = 0,
    private readonly ty = 0,
    private readonly angle = 0,
  ) {}

  translated(dx: number, dy: number): RigidTransform {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    return new RigidTransform(this.tx + dx * cos - dy * sin, this.ty + dx * sin + dy * cos, this.angle);
  }

  rotated(rad: number): RigidTransform {
    return new RigidTransform(this.tx, this.ty, this.angle + rad);
  }

  apply(p: Point): Point {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    return { x: this.tx + p.x * cos - p.y * sin, y: this.ty + p.x * sin + p.y * cos };
  }
}

function num(n: number): string {
  return n.toFixed(3);
}

/** "#rrggbb" / "rgb(r, g, b)" -> PDF "r g b" (0..1), or null. */
function pdfColor(css: string): string | null {
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex !== null) rgb = [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16));
  const fn = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(css.trim());
  if (fn !== null) rgb = [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  if (/^#000$/.test(css.trim())) rgb = [0, 0, 0];
  return rgb === null ? null : rgb.map((v) => (v / 255).toFixed(3)).join(" ");
}

/** Escapes a string for a PDF literal `(...)` string and drops anything
 *  outside Latin-1 (WinAnsiEncoding's practical range for the built-in
 *  Helvetica font this module uses, no font embedding) -- a CAD drawing's
 *  text/dimension labels are overwhelmingly plain ASCII, so this is a
 *  deliberate, documented scope limit rather than a full Unicode layout
 *  engine: an unrepresentable character prints as '?' instead of corrupting
 *  the file or silently vanishing. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    const byte = code <= 0xff ? code : 63; // 63 = '?'
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += "\\" + String.fromCharCode(byte); // ( ) \
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** One cubic-bezier-per-<=90-degree-chunk approximation of an (elliptical)
 *  arc, in the LOCAL unrotated/untranslated ellipse frame (center at the
 *  origin, axes along local X/Y) -- callers rotate+translate the returned
 *  control points themselves. Standard "magic number" construction:
 *  k = 4/3 * tan(chunk/4) places each cubic's control points tangent to the
 *  ellipse at both chunk endpoints. `end` may exceed `start` by more than
 *  2*PI's worth of chunks; each successive chunk just keeps sweeping. */
function ellipseBezierSegments(
  rx: number,
  ry: number,
  start: number,
  end: number,
): { c1: Point; c2: Point; p: Point }[] {
  const segments: { c1: Point; c2: Point; p: Point }[] = [];
  const totalSweep = end - start;
  if (totalSweep <= 0) return segments;

  const chunkCount = Math.max(1, Math.ceil(totalSweep / (Math.PI / 2)));
  const chunk = totalSweep / chunkCount;
  const pointAt = (a: number): Point => ({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
  const tangentAt = (a: number): Point => ({ x: -rx * Math.sin(a), y: ry * Math.cos(a) });
  const k = (4.0 / 3.0) * Math.tan(chunk / 4.0);

  for (let i = 0; i < chunkCount; i++) {
    const a0 = start + i * chunk;
    const a1 = a0 + chunk;
    const p0 = pointAt(a0);
    const p1 = pointAt(a1);
    const t0 = tangentAt(a0);
    const t1 = tangentAt(a1);
    segments.push({
      c1: { x: p0.x + k * t0.x, y: p0.y + k * t0.y },
      c2: { x: p1.x - k * t1.x, y: p1.y - k * t1.y },
      p: p1,
    });
  }
  return segments;
}

type PathOp = { kind: "m" | "l"; p: Point } | { kind: "c"; c1: Point; c2: Point; p: Point } | { kind: "h" };

/**
 * A CanvasRenderingContext2D-shaped shim covering exactly the subset of the
 * API every entities/*.ts draw() method (and Dimension's private drawing
 * helpers) actually calls -- verified directly against their source rather
 * than guessed. Renders nothing itself; every call appends a PDF content-
 * stream operator to `ops` instead. Cast to CanvasRenderingContext2D at the
 * one call site that hands this to an entity's draw() -- see exportPdf()
 * below.
 *
 * Two print-specific overrides, mirroring file_io/pdf.py's
 * _PrintPainterProxy exactly (see that class's own docstring for the full
 * rationale): stroke color is always solid black regardless of what an
 * entity sets (COLOR_NORMAL is white, correct on the app's dark canvas,
 * invisible on a white page), and font size is resolved from the entity's
 * own WORLD-space size rather than used as-is -- see setFontPx() below.
 */
class PdfCanvasContext {
  readonly ops: string[] = [];

  private stack: RigidTransform[] = [new RigidTransform()];
  private current(): RigidTransform {
    return this.stack[this.stack.length - 1]!;
  }

  private path: PathOp[] = [];
  private dash: number[] = [];

  // Raw px size an entity last assigned via `ctx.font = "<n>px ..."` --
  // resolved to a real print point size (setFontPx()) before every fillText().
  private lastFontPx = MIN_PRINT_TEXT_MM * POINTS_PER_MM;
  textAlign = "left";
  textBaseline = "alphabetic";

  constructor(
    private readonly scale: number, // world -> page-point scale (this export's fake Viewport.zoom)
    private readonly mmPerWorldUnit: number, // font-size resolution factor -- see exportPdf()'s scale_mode handling
    private readonly maxTextMm: number | null, // fit-mode-only overlap guard -- see MAX_PRINT_TEXT_MM's own comment
  ) {}

  // --- Transform stack ---

  save(): void {
    this.stack.push(this.current());
  }

  restore(): void {
    if (this.stack.length > 1) this.stack.pop();
  }

  translate(dx: number, dy: number): void {
    this.stack[this.stack.length - 1] = this.current().translated(dx, dy);
  }

  rotate(rad: number): void {
    this.stack[this.stack.length - 1] = this.current().rotated(rad);
  }

  // --- Property setters entities assign but this print path treats specially ---

  set strokeStyle(v: string) {
    /* always solid black ink -- see class doc comment -- except a sheet's own shading */
    const c = this.honorLineWidth ? pdfColor(v) : null;
    if (c !== null) this.ops.push(`${c} RG`);
  }
  set fillStyle(v: string) {
    const c = this.honorLineWidth ? pdfColor(v) : null;
    if (c !== null) this.ops.push(`${c} rg`);
  }
  /** Drawing sheets set this while painting their own graphics, whose line
   *  widths ARE physical (page points); entities keep the fixed weight. */
  honorLineWidth = false;
  set lineWidth(v: number) {
    /* otherwise always the fixed physical PRINT_LINE_WEIGHT_MM -- see emitPageSetup() */
    if (this.honorLineWidth) this.ops.push(`${num(v)} w`);
  }

  set font(value: string) {
    const match = /(\d+(?:\.\d+)?)px/.exec(value);
    if (match !== undefined && match !== null) this.lastFontPx = Number(match[1]);
  }

  /** Reverses this context's own scale to recover the entity's original
   *  WORLD-space size (every entity computes `worldSize * viewport.zoom`
   *  before assigning `ctx.font`, and this shim's Viewport IS `this.scale`),
   *  then resolves that to a real, fixed physical point size -- proportional
   *  to `mmPerWorldUnit` (1.0 for a true 1:1 mm export, or a fixed ratio
   *  anchored on TEXT_SCALE_ANCHOR_WORLD for a fit-to-page export), floored
   *  to MIN_PRINT_TEXT_MM so a tiny/degenerate source height never collapses
   *  to unreadable print output. Otherwise the exact analogue of
   *  file_io/pdf.py's _resolve_point_size, just starting from a different
   *  representation (Canvas bakes the scale into the px size it hands the
   *  context; Qt's font point size never had it baked in to begin with) --
   *  EXCEPT for `maxTextMm`, which that Python source doesn't have: without
   *  it, a Text/Dimension authored well above TEXT_SCALE_ANCHOR_WORLD prints
   *  proportionally larger with no ceiling, and once a drawing's own extent
   *  forces a small fit scale, that oversized label can swallow whatever
   *  else is nearby (confirmed against the desktop app directly -- this
   *  isn't a porting gap, it's a real bug in the shared algorithm). */
  private resolvedFontSizePt(): number {
    const worldSize = this.lastFontPx / (this.scale || 1);
    let mm = Math.max(worldSize * this.mmPerWorldUnit, MIN_PRINT_TEXT_MM);
    if (this.maxTextMm !== null) mm = Math.min(mm, this.maxTextMm);
    return mm * POINTS_PER_MM;
  }

  // --- Path construction ---

  beginPath(): void {
    this.path = [];
  }

  closePath(): void {
    this.path.push({ kind: "h" });
  }

  moveTo(x: number, y: number): void {
    this.path.push({ kind: "m", p: this.current().apply({ x, y }) });
  }

  lineTo(x: number, y: number): void {
    this.path.push({ kind: "l", p: this.current().apply({ x, y }) });
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, _ccw = false): void {
    this.appendEllipseArc({ x, y }, radius, radius, 0, startAngle, endAngle);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    _ccw = false,
  ): void {
    this.appendEllipseArc({ x, y }, radiusX, radiusY, rotation, startAngle, endAngle);
  }

  /** Shared by arc()/ellipse(): builds bezier segments in the ellipse's own
   *  local frame, then rotates (the ellipse/arc's OWN intrinsic rotation
   *  argument, independent of this context's translate/rotate stack) and
   *  translates by its center, then runs the result through this context's
   *  transform stack same as any other point -- composes correctly whether
   *  or not a caller ever wraps an arc in save()/translate()/rotate() (none
   *  currently do, but nothing here assumes that). */
  private appendEllipseArc(center: Point, rx: number, ry: number, rotation: number, start: number, end: number): void {
    const sweepEnd = end <= start ? end + 2 * Math.PI : end;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const toCtxLocal = (p: Point): Point => ({
      x: center.x + p.x * cos - p.y * sin,
      y: center.y + p.x * sin + p.y * cos,
    });

    const segments = ellipseBezierSegments(rx, ry, start, sweepEnd);
    if (segments.length === 0) return;

    // Matches real Canvas2D semantics: arc()/ellipse() moves to their own
    // start point when the current path is empty, but draws a connecting
    // LINE from whatever the current point already is otherwise. Unlike
    // Canvas, PDF has no implicit moveto -- a path's very first operator
    // must be "m" or every renderer (verified against Ghostscript/poppler)
    // rejects the path outright with "no current point".
    const startPoint = toCtxLocal({ x: rx * Math.cos(start), y: ry * Math.sin(start) });
    this.path.push({ kind: this.path.length === 0 ? "m" : "l", p: this.current().apply(startPoint) });

    for (const seg of segments) {
      this.path.push({
        kind: "c",
        c1: this.current().apply(toCtxLocal(seg.c1)),
        c2: this.current().apply(toCtxLocal(seg.c2)),
        p: this.current().apply(toCtxLocal(seg.p)),
      });
    }
  }

  setLineDash(segments: number[]): void {
    this.dash = segments.slice();
  }

  stroke(): void {
    if (this.path.length === 0) return;
    this.ops.push(this.dash.length > 0 ? `[${this.dash.map(num).join(" ")}] 0 d` : "[] 0 d");
    this.emitPath();
    this.ops.push("S");
    this.path = [];
  }

  private emitPath(): void {
    for (const op of this.path) {
      if (op.kind === "h") {
        this.ops.push("h");
        continue;
      }
      if (op.kind === "m" || op.kind === "l") {
        const p = flipY(op.p);
        this.ops.push(`${num(p.x)} ${num(p.y)} ${op.kind}`);
        continue;
      }
      if (op.kind !== "c") continue; // unreachable -- exhaustive over PathOp's 3 kinds, keeps TS narrowing simple
      const c1 = flipY(op.c1);
      const c2 = flipY(op.c2);
      const p = flipY(op.p);
      this.ops.push(`${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(p.x)} ${num(p.y)} c`);
    }
  }

  // --- Rects -- only reachable via drawSelected() paths PDF export never
  // calls (export always draws entities unselected), kept for interface
  // completeness/robustness rather than because anything exercises them today. ---

  /** Fills the current path (a sheet's shaded views). */
  fill(rule?: "nonzero" | "evenodd"): void {
    if (this.path.length === 0) return;
    this.emitPath();
    this.ops.push(rule === "evenodd" ? "f*" : "f");
  }

  /** Fill (even-odd) AND stroke the current path with one operator -- a
   *  shaded patch's outline is written once, not twice. */
  fillStrokeEvenOdd(): void {
    if (this.path.length === 0) return;
    this.ops.push("[] 0 d");
    this.emitPath();
    this.ops.push("B*");
    this.path = [];
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.strokeOrFillRect(x, y, w, h, "f");
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.strokeOrFillRect(x, y, w, h, "S");
  }

  private strokeOrFillRect(x: number, y: number, w: number, h: number, paint: "f" | "S"): void {
    const corners = [
      this.current().apply({ x, y }),
      this.current().apply({ x: x + w, y }),
      this.current().apply({ x: x + w, y: y + h }),
      this.current().apply({ x, y: y + h }),
    ].map(flipY);
    const [p0, p1, p2, p3] = corners as [Point, Point, Point, Point];
    this.ops.push(`${num(p0.x)} ${num(p0.y)} m`);
    this.ops.push(`${num(p1.x)} ${num(p1.y)} l`);
    this.ops.push(`${num(p2.x)} ${num(p2.y)} l`);
    this.ops.push(`${num(p3.x)} ${num(p3.y)} l`);
    this.ops.push("h");
    this.ops.push(paint);
  }

  // --- Text ---

  fillText(text: string, x: number, y: number): void {
    const fontSizePt = this.resolvedFontSizePt();
    const { width, ascent, descent } = measureText(text, fontSizePt);

    const alignShift = this.textAlign === "center" ? width / 2 : this.textAlign === "right" ? width : 0;
    const baselineY = this.textBaseline === "middle" ? y + (ascent - descent) / 2 : y;
    const localAnchor: Point = { x: x - alignShift, y: baselineY };
    const localAxis: Point = { x: localAnchor.x + 1, y: localAnchor.y };

    const devAnchor = flipY(this.current().apply(localAnchor));
    const devAxis = flipY(this.current().apply(localAxis));
    const angle = Math.atan2(devAxis.y - devAnchor.y, devAxis.x - devAnchor.x);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    this.ops.push("BT");
    this.ops.push(`/F1 ${num(fontSizePt)} Tf`);
    this.ops.push(`${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(devAnchor.x)} ${num(devAnchor.y)} Tm`);
    this.ops.push(`(${pdfString(text)}) Tj`);
    this.ops.push("ET");
  }
}

let pageHeightForFlip = PAGE_HEIGHT_PT;

/** PDF's coordinate system is Y-up with the origin at the page's bottom-left;
 *  every other computation in this module (this app's own world space, this
 *  shim's transform stack, Viewport.worldToScreen()) stays Y-down throughout,
 *  matching how the real on-screen canvas renderer works -- this is the one
 *  place that difference gets reconciled, applied uniformly to every point
 *  right before it's written into the content stream. */
function flipY(p: Point): Point {
  return { x: p.x, y: pageHeightForFlip - p.y };
}

/**
 * Exports `document` to a single borderless A4 landscape vector PDF page.
 *
 * `windowRect`, when given, is a world-space [minX, minY, maxX, maxY] box
 * (picked interactively via commands/exportPdf.ts) -- only content inside it
 * is fit to the page, and anything outside is clipped away. Without one,
 * falls back to fitting the whole document's own bounding box. Returns null
 * if there's nothing to export (`windowRect` omitted and the document is
 * empty).
 *
 * `scaleMode`: "fit" (default) scales the window uniformly to fill the page
 * exactly (never stretched/distorted on either axis); "1:1" prints world
 * units as true millimeters, clipped to whatever actually fits on one A4
 * page -- `warning` is set (non-null) when a 1:1 export didn't fully fit.
 */
export function exportPdf(document: Document, windowRect: Bounds | null, scaleMode: PdfScaleMode = "fit"): PdfExportResult | null {
  let winMinX: number, winMinY: number, winMaxX: number, winMaxY: number;
  if (windowRect !== null) {
    [winMinX, winMinY, winMaxX, winMaxY] = windowRect;
  } else {
    const entities = document.getEntities();
    if (entities.length === 0) return null;
    [winMinX, winMinY, winMaxX, winMaxY] = document.getBounds();
  }

  let winW = winMaxX - winMinX;
  let winH = winMaxY - winMinY;
  if (winW <= 0.01) winW = 100.0;
  if (winMaxX <= winMinX) winMaxX = winMinX + winW;
  if (winH <= 0.01) winH = 100.0;
  if (winMaxY <= winMinY) winMaxY = winMinY + winH;

  const padding = Math.max(winW, winH) * 0.05;
  const paddedMinX = winMinX - padding;
  const paddedMinY = winMinY - padding;
  const paddedW = winW + padding * 2.0;
  const paddedH = winH + padding * 2.0;

  let warning: string | null = null;
  let scale: number;
  if (scaleMode === "1:1") {
    scale = POINTS_PER_MM;
    if (paddedW * scale > PAGE_WIDTH_PT || paddedH * scale > PAGE_HEIGHT_PT) {
      warning = "Drawing exceeds one A4 page at 1:1 scale -- content past the page edge was clipped";
    }
  } else {
    scale = Math.min(PAGE_WIDTH_PT / paddedW, PAGE_HEIGHT_PT / paddedH);
  }

  const offsetX = (PAGE_WIDTH_PT - paddedW * scale) / 2.0;
  const offsetY = (PAGE_HEIGHT_PT - paddedH * scale) / 2.0;

  const viewport = new Viewport(
    () => PAGE_WIDTH_PT,
    () => PAGE_HEIGHT_PT,
  );
  viewport.zoom = scale;
  viewport.panOffset = { x: offsetX - paddedMinX * scale, y: offsetY - paddedMinY * scale };

  const mmPerWorldUnit = scaleMode === "1:1" ? 1.0 : FIT_TEXT_HEIGHT_MM / TEXT_SCALE_ANCHOR_WORLD;
  const maxTextMm = scaleMode === "1:1" ? null : MAX_PRINT_TEXT_MM;
  const pdfCtx = new PdfCanvasContext(scale, mmPerWorldUnit, maxTextMm);

  pageHeightForFlip = PAGE_HEIGHT_PT;
  const winP0 = flipY(viewport.worldToScreen({ x: winMinX, y: winMinY }));
  const winP1 = flipY(viewport.worldToScreen({ x: winMaxX, y: winMaxY }));
  const clipX = Math.min(winP0.x, winP1.x);
  const clipY = Math.min(winP0.y, winP1.y);
  const clipW = Math.abs(winP1.x - winP0.x);
  const clipH = Math.abs(winP1.y - winP0.y);

  pdfCtx.ops.push("q");
  pdfCtx.ops.push(`0 0 ${num(PAGE_WIDTH_PT)} ${num(PAGE_HEIGHT_PT)} re W n`);
  pdfCtx.ops.push(`${num(clipX)} ${num(clipY)} ${num(clipW)} ${num(clipH)} re W n`);
  pdfCtx.ops.push("0 0 0 RG");
  pdfCtx.ops.push("0 0 0 rg");
  pdfCtx.ops.push(`${num(PRINT_LINE_WEIGHT_MM * POINTS_PER_MM)} w`);

  for (const entity of document.getEntities()) {
    entity.draw(pdfCtx as unknown as CanvasRenderingContext2D, viewport, false);
  }

  pdfCtx.ops.push("Q");

  const bytes = buildPdfFile(pdfCtx.ops.join("\n"));
  return { bytes, warning };
}

/**
 * A drawing sheet as a one-page vector PDF at TRUE SIZE: the page is the
 * paper (widthMm x heightMm) and world units are paper millimetres, with
 * the sheet's world laid out Y-down over x 0..W, y -H..0 (paper Y-up,
 * negated). `paint` draws the sheet's own graphics (border, title block,
 * views) and may set real line widths in page points; `entities` (the
 * annotations: dimensions, notes...) print at the fixed weight.
 */
export async function exportSheetPdf(
  widthMm: number,
  heightMm: number,
  paint: (ctx: CanvasRenderingContext2D, viewport: Viewport) => void,
  entities: readonly { draw(ctx: CanvasRenderingContext2D, viewport: Viewport, preview?: boolean): void }[],
): Promise<Uint8Array> {
  const pageW = widthMm * POINTS_PER_MM;
  const pageH = heightMm * POINTS_PER_MM;
  const viewport = new Viewport(
    () => pageW,
    () => pageH,
  );
  viewport.zoom = POINTS_PER_MM;
  viewport.panOffset = { x: 0, y: pageH };
  const pdfCtx = new PdfCanvasContext(POINTS_PER_MM, 1.0, null);
  pageHeightForFlip = pageH;
  pdfCtx.ops.push("q");
  pdfCtx.ops.push(`0 0 ${num(pageW)} ${num(pageH)} re W n`);
  pdfCtx.ops.push("0 0 0 RG");
  pdfCtx.ops.push("0 0 0 rg");
  pdfCtx.ops.push("1 J 1 j"); // round caps / joins: clean corners at any weight
  pdfCtx.honorLineWidth = true;
  paint(pdfCtx as unknown as CanvasRenderingContext2D, viewport);
  pdfCtx.honorLineWidth = false;
  pdfCtx.ops.push(`${num(PRINT_LINE_WEIGHT_MM * POINTS_PER_MM)} w`);
  for (const entity of entities) entity.draw(pdfCtx as unknown as CanvasRenderingContext2D, viewport, false);
  pdfCtx.ops.push("Q");
  pageHeightForFlip = PAGE_HEIGHT_PT;
  // Compressed (FlateDecode, the browser's own deflate): a sheet's page is
  // thousands of short, repetitive operators -- several times smaller to
  // send to the shop floor.
  const content = pdfCtx.ops.join("\n");
  const packed = await deflate(content);
  return packed === null ? buildPdfFile(content, pageW, pageH) : buildPdfFile(packed, pageW, pageH, " /Filter /FlateDecode");
}

/** zlib-deflates a byte string (one char = one byte), returned the same
 *  way; null where the platform has no CompressionStream. */
async function deflate(text: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return s;
}

// --- PDF file structure: header, objects, xref table, trailer. See this
// module's own header comment for why this is hand-written rather than
// pulled from a library. ---

function buildPdfFile(contentStream: string, pageW = PAGE_WIDTH_PT, pageH = PAGE_HEIGHT_PT, filter = ""): Uint8Array {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageW)} ${num(pageH)}] ` +
    "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  objects[4] = `<< /Length ${contentStream.length}${filter} >>\nstream\n${contentStream}\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  let file = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [0];

  for (let i = 1; i < objects.length; i++) {
    offsets[i] = file.length;
    file += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = file.length;
  file += `xref\n0 ${objects.length}\n`;
  file += "0000000000 65535 f \n";
  for (let i = 1; i < objects.length; i++) {
    file += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Uint8Array.from(file, (ch) => ch.charCodeAt(0) & 0xff);
}
