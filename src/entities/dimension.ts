/**
 * MinimalCAD Web
 * entities/dimension.ts
 *
 * Ported from entities/dimension.py: a unified Dimension primitive covering
 * linear/aligned/angular/diameter/radius/leader via a loose `data` dict
 * (like Python's own `self.data`, keyed by role -- "p1"/"p2"/"center"/etc --
 * not a per-variant typed shape) and per-type private draw dispatch.
 *
 * Architecture note (the one real deviation from the Python source): Python
 * draws directly against a QPainter whose world->screen transform is already
 * active, so every point it hands to drawLine/drawArc/drawText is in WORLD
 * space, and the QPainterPath it accumulates for hit-testing comes for free
 * in that same space. This port's canvas entities pre-transform every point
 * to screen space in JS instead (see engine/viewport.ts). So every draw
 * method below computes its geometry in WORLD space first -- identical math
 * to the Python source, including the `scale`-multiplied world-unit
 * constants -- caches THAT (in cachedSegments/cachedRects/cachedArcs, this
 * port's analogue of _cached_path) for hitTest()/getBounds(), and only
 * projects to screen space at the final stroke/fill call.
 */

import type { Bounds, Point } from "../core/types";
import { pointAdd, pointSub } from "../core/types";
import type { Entity, Viewport } from "./entity";
import { COLOR_SELECTED, COLOR_GRIP, gripScreenSize, rotatePoint } from "./style";
import { FONT_FAMILY, measureText } from "./textMetrics";
import { Viewport as ViewportClass } from "../engine/viewport";
import { Line } from "./line";
import { Arc } from "./arc";
import { Text } from "./text";

export type DimType = "linear" | "aligned" | "angular" | "diameter" | "radius" | "leader";

const TEXT_HEIGHT = 3.5;
const ARROW_SIZE = 2.0;
const EXTENSION_GAP = 1.0;
const TEXT_GAP = 1.0;
const LINE_OFFSET = 8.0;
const COLOR_NORMAL = "#ffffff";

type DimValue = Point | number | string;
export type DimData = Record<string, DimValue>;

/** "12.500" -> "12.5", "25.000" -> "25" (only after a decimal point). */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function isPoint(v: DimValue | undefined): v is Point {
  return typeof v === "object" && v !== null && "x" in v && "y" in v;
}

interface Segment {
  p1: Point;
  p2: Point;
}

/** Axis-aligned world-space rect, [x0, y0, x1, y1] (x0<=x1, y0<=y1). */
type RectW = [number, number, number, number];

interface ArcW {
  center: Point;
  radius: number;
  start: number; // radians, our own atan2(dy,dx) convention (Y-down world)
  end: number; // > start, may exceed 2*PI
}

/** Liang-Barsky clipping, inverted: returns the 0-2 sub-segments of p1->p2
 *  that lie OUTSIDE `rect` -- ported from entities/dimension.py's
 *  _clip_line_outside_rect. Used to carve a gap out of a dimension/leader
 *  line exactly where its text sits. */
function clipLineOutsideRect(p1: Point, p2: Point, rect: RectW): Segment[] {
  const [left, top, right, bottom] = rect;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  let tEnter = 0.0;
  let tExit = 1.0;
  const edges: [number, number][] = [
    [-dx, p1.x - left],
    [dx, right - p1.x],
    [-dy, p1.y - top],
    [dy, bottom - p1.y],
  ];
  for (const [pCoef, q] of edges) {
    if (pCoef === 0.0) {
      if (q < 0.0) return [{ p1, p2 }]; // parallel to this edge, entirely outside it
      continue;
    }
    const t = q / pCoef;
    if (pCoef < 0.0) tEnter = Math.max(tEnter, t);
    else tExit = Math.min(tExit, t);
  }

  if (tEnter > tExit) return [{ p1, p2 }]; // segment never enters rect at all

  const segments: Segment[] = [];
  if (tEnter > 0.0) {
    segments.push({ p1, p2: { x: p1.x + tEnter * dx, y: p1.y + tEnter * dy } });
  }
  if (tExit < 1.0) {
    segments.push({ p1: { x: p1.x + tExit * dx, y: p1.y + tExit * dy }, p2 });
  }
  return segments;
}

export class Dimension implements Entity {
  dimType: DimType;
  data: DimData;

  private scale = 1.0;
  private lastText = "";
  private cachedSegments: Segment[] = [];
  private cachedRects: RectW[] = [];
  private cachedArcs: ArcW[] = [];

  constructor(dimType: DimType, data: DimData) {
    this.dimType = dimType.toLowerCase() as DimType;
    this.data = data;
  }

  private p(key: string): Point {
    return this.data[key] as Point;
  }

  private num(key: string, fallback = 0): number {
    const v = this.data[key];
    return typeof v === "number" ? v : fallback;
  }

  /** A value as dimension text: `precision` = fixed decimals (0-4, like
   *  AutoCAD's DIMDEC); else `trim_zeros` = up to 3 decimals without
   *  trailing zeros (25, 12.5, 7.25); else the classic 2 decimals. */
  private fmt(v: number): string {
    const prec = this.data.precision;
    if (typeof prec === "number") return v.toFixed(Math.max(0, Math.min(4, Math.round(prec))));
    if (this.num("trim_zeros", 0) === 1) return trimZeros(v.toFixed(3));
    return v.toFixed(2);
  }

  /** A measured length as text. On a drawing sheet the dimension carries
   *  `measure_scale` (1 / the view scale: paper mm -> part mm). */
  private len(paper: number): string {
    return this.fmt(paper * this.num("measure_scale", 1));
  }

  private str(key: string): string | undefined {
    const v = this.data[key];
    return typeof v === "string" ? v : undefined;
  }

  // --- Draw dispatch ---

  draw(ctx: CanvasRenderingContext2D, viewport: Viewport, preview = false): void {
    this.cachedSegments = [];
    this.cachedRects = [];
    this.cachedArcs = [];
    this.scale = this.num("scale", 1.0);

    ctx.save();
    ctx.strokeStyle = COLOR_NORMAL;
    ctx.fillStyle = COLOR_NORMAL;
    ctx.lineWidth = 1;
    ctx.setLineDash(preview ? [6, 4] : []);

    switch (this.dimType) {
      case "linear":
        this.drawLinear(ctx, viewport);
        break;
      case "aligned":
        this.drawAligned(ctx, viewport);
        break;
      case "angular":
        this.drawAngular(ctx, viewport);
        break;
      case "diameter":
        this.drawRadialLeader(ctx, viewport, true);
        break;
      case "radius":
        this.drawRadialLeader(ctx, viewport, false);
        break;
      case "leader":
        this.drawLeader(ctx, viewport);
        break;
    }

    ctx.restore();
  }

  drawSelected(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    ctx.save();
    ctx.strokeStyle = COLOR_SELECTED;
    ctx.fillStyle = COLOR_SELECTED;
    this.draw(ctx, viewport, false);
    ctx.restore();

    const grip = gripScreenSize();
    ctx.save();
    ctx.strokeStyle = COLOR_SELECTED;
    ctx.fillStyle = COLOR_GRIP;
    for (const pt of this.getGripPoints()) {
      const s = viewport.worldToScreen(pt);
      ctx.fillRect(s.x - grip / 2, s.y - grip / 2, grip, grip);
      ctx.strokeRect(s.x - grip / 2, s.y - grip / 2, grip, grip);
    }
    ctx.restore();
  }

  // --- World-space drawing primitives (cache + project + stroke/fill) ---

  private line(ctx: CanvasRenderingContext2D, viewport: Viewport, p1: Point, p2: Point): void {
    this.cachedSegments.push({ p1, p2 });
    const s1 = viewport.worldToScreen(p1);
    const s2 = viewport.worldToScreen(p2);
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
  }

  private lineWithGap(ctx: CanvasRenderingContext2D, viewport: Viewport, p1: Point, p2: Point, gapRect: RectW): void {
    for (const seg of clipLineOutsideRect(p1, p2, gapRect)) {
      this.line(ctx, viewport, seg.p1, seg.p2);
    }
  }

  private arrowhead(ctx: CanvasRenderingContext2D, viewport: Viewport, tip: Point, angleDeg: number): void {
    const rad = (angleDeg * Math.PI) / 180;
    const arrow = ARROW_SIZE * this.scale;
    const pBase = { x: tip.x - arrow * Math.cos(rad), y: tip.y - arrow * Math.sin(rad) };
    const nx = -Math.sin(rad);
    const ny = Math.cos(rad);
    const halfW = arrow / 2.0;
    const pt1 = { x: pBase.x + nx * halfW, y: pBase.y + ny * halfW };
    const pt2 = { x: pBase.x - nx * halfW, y: pBase.y - ny * halfW };
    this.line(ctx, viewport, tip, pt1);
    this.line(ctx, viewport, tip, pt2);
  }

  private textRectFor(basePt: Point, text: string): RectW {
    const { width, ascent, descent } = measureText(text, TEXT_HEIGHT * this.scale);
    const tw = width + TEXT_GAP * this.scale * 2.0;
    const th = ascent + descent;
    return [basePt.x - tw / 2.0, basePt.y - th / 2.0, basePt.x + tw / 2.0, basePt.y + th / 2.0];
  }

  private centeredText(ctx: CanvasRenderingContext2D, viewport: Viewport, basePt: Point, text: string): void {
    const rect = this.textRectFor(basePt, text);
    this.cachedRects.push(rect);
    const centerWorld = { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2 };
    const s = viewport.worldToScreen(centerWorld);
    const fontPx = TEXT_HEIGHT * this.scale * viewport.zoom;
    ctx.save();
    ctx.font = `${fontPx}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, s.x, s.y);
    ctx.restore();
  }

  private leaderText(ctx: CanvasRenderingContext2D, viewport: Viewport, tp: Point, text: string, away: number): void {
    const gap = TEXT_GAP * this.scale;
    const { width, ascent, descent } = measureText(text, TEXT_HEIGHT * this.scale);
    const th = ascent + descent;
    const left = away >= 0 ? tp.x + gap : tp.x - gap - width;
    const rect: RectW = [left, tp.y - th / 2, left + width, tp.y + th / 2];
    this.cachedRects.push(rect);

    const anchorWorld = { x: away >= 0 ? left : left + width, y: tp.y };
    const s = viewport.worldToScreen(anchorWorld);
    const fontPx = TEXT_HEIGHT * this.scale * viewport.zoom;
    ctx.save();
    ctx.font = `${fontPx}px ${FONT_FAMILY}`;
    ctx.textAlign = away >= 0 ? "left" : "right";
    ctx.textBaseline = "middle";
    ctx.fillText(text, s.x, s.y);
    ctx.restore();
  }

  private arc(ctx: CanvasRenderingContext2D, viewport: Viewport, center: Point, radius: number, start: number, end: number): void {
    if (end - start <= 0) return;
    this.cachedArcs.push({ center, radius, start, end });
    const s = viewport.worldToScreen(center);
    ctx.beginPath();
    // Canvas 2D's arc() sweeps clockwise (anticlockwise=false) from startAngle
    // to endAngle under a Y-down coordinate system -- exactly our atan2(dy,dx)
    // convention already, so unlike the Python source (which negates its own
    // angles to satisfy Qt's always-CCW-positive drawArc()), no conversion
    // is needed here.
    ctx.arc(s.x, s.y, radius * viewport.zoom, start, end);
    ctx.stroke();
  }

  // --- Per-type draw methods ---

  /** Linear dims measure along X or Y -- whichever way the dimension line
   *  was pulled out; once the text has been moved by hand the direction is
   *  pinned (\`orient\`), so sliding the text along never flips it. */
  private linearHorizontal(): boolean {
    const o = this.str("orient");
    if (o === "h") return true;
    if (o === "v") return false;
    const p1 = this.p("p1");
    const p2 = this.p("p2");
    const tp = this.p("text_position");
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return Math.abs(tp.y - mid.y) >= Math.abs(tp.x - mid.x);
  }

  private drawLinear(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const u = this.linearHorizontal() ? { x: 1, y: 0 } : { x: 0, y: 1 };
    this.drawAlongLine(ctx, viewport, this.p("p1"), this.p("p2"), this.p("text_position"), u);
  }

  private drawAligned(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const p1 = this.p("p1");
    const p2 = this.p("p2");
    const val = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (val === 0) {
      this.lastText = this.str("text_override") || this.len(0);
      return;
    }
    const u = { x: (p2.x - p1.x) / val, y: (p2.y - p1.y) / val };
    this.drawAlongLine(ctx, viewport, p1, p2, this.p("text_position"), u);
  }

  /** Where the text of a linear / aligned dimension was last drawn (its
   *  grip sits there, so dragging it moves the text). */
  private textAt: Point | null = null;

  /**
   * Linear and aligned: extension lines from p1 / p2 to a dimension line
   * through text_position, measuring along \`u\`.
   *
   * The text sits in the middle -- or, once dragged (\`text_moved\`), where
   * it was dragged along the line, even outside the extension lines (the
   * dimension line then runs out to it). When the text or the arrows don't
   * fit between the extension lines (a small dimension) the text goes
   * outside past the second one and the arrows flip outside, pointing in,
   * like AutoCAD.
   */
  private drawAlongLine(ctx: CanvasRenderingContext2D, viewport: Viewport, p1: Point, p2: Point, tp: Point, u: Point): void {
    const n = { x: -u.y, y: u.x };
    const dotp = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
    const off1 = dotp({ x: tp.x - p1.x, y: tp.y - p1.y }, n);
    const off2 = dotp({ x: tp.x - p2.x, y: tp.y - p2.y }, n);
    const d1 = { x: p1.x + n.x * off1, y: p1.y + n.y * off1 };
    const d2 = { x: p2.x + n.x * off2, y: p2.y + n.y * off2 };
    // Run d1 -> d2 along +e.
    let e = u;
    let L = dotp({ x: d2.x - d1.x, y: d2.y - d1.y }, u);
    if (L < 0) {
      e = { x: -u.x, y: -u.y };
      L = -L;
    }
    const txt = this.str("text_override") || this.len(L);
    this.lastText = txt;

    const extGap = EXTENSION_GAP * this.scale;
    const arrow = ARROW_SIZE * this.scale;
    for (const [p, d, off] of [
      [p1, d1, off1],
      [p2, d2, off2],
    ] as const) {
      const sgn = off >= 0 ? 1 : -1;
      if (Math.abs(off) <= extGap) continue; // measured right on the dimension line
      this.line(ctx, viewport, { x: p.x + n.x * sgn * extGap, y: p.y + n.y * sgn * extGap }, { x: d.x + n.x * sgn * arrow, y: d.y + n.y * sgn * arrow });
    }

    const tw = measureText(txt, TEXT_HEIGHT * this.scale).width + TEXT_GAP * this.scale * 2.0;
    const fitsText = L >= tw + arrow * 2.5;
    let s: number; // text centre, along e from d1
    if (this.num("text_moved", 0) === 1) s = dotp({ x: tp.x - d1.x, y: tp.y - d1.y }, e);
    else s = fitsText ? L / 2 : L + arrow * 2 + tw / 2;
    const textInside = s - tw / 2 >= 0 && s + tw / 2 <= L;
    const arrowsInside = L >= arrow * 3 + (textInside ? tw : 0);
    const at = (t: number): Point => ({ x: d1.x + e.x * t, y: d1.y + e.y * t });

    const center = at(s);
    const textRect = this.textRectFor(center, txt);
    let from = arrowsInside ? 0 : -arrow * 2;
    let to = arrowsInside ? L : L + arrow * 2;
    from = Math.min(from, s - tw / 2);
    to = Math.max(to, s + tw / 2);
    this.lineWithGap(ctx, viewport, at(from), at(to), textRect);

    const ang = (Math.atan2(e.y, e.x) * 180) / Math.PI;
    if (arrowsInside) {
      this.arrowhead(ctx, viewport, d1, ang + 180.0);
      this.arrowhead(ctx, viewport, d2, ang);
    } else {
      this.arrowhead(ctx, viewport, d1, ang);
      this.arrowhead(ctx, viewport, d2, ang + 180.0);
    }
    this.centeredText(ctx, viewport, center, txt);
    this.textAt = center;
  }

  /** Called when the text grip is dragged: the text now stays where it's
   *  put (and a linear dim keeps measuring the way it did). */
  pinText(): void {
    if (this.dimType !== "linear" && this.dimType !== "aligned") return;
    if (this.dimType === "linear" && this.str("orient") === undefined) this.data.orient = this.linearHorizontal() ? "h" : "v";
    this.data.text_moved = 1;
  }

  private drawAngular(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const l1p1 = this.p("line1_p1");
    const l1p2 = this.p("line1_p2");
    const l2p1 = this.p("line2_p1");
    const l2p2 = this.p("line2_p2");
    const tp = this.p("text_position");

    const v = lineIntersection(l1p1, l1p2, l2p1, l2p2);
    if (v === null) return; // parallel lines

    const far1 = dist(v, l1p1) >= dist(v, l1p2) ? l1p1 : l1p2;
    const far2 = dist(v, l2p1) >= dist(v, l2p2) ? l2p1 : l2p2;

    let a1 = normalizeAngle(Math.atan2(far1.y - v.y, far1.x - v.x));
    let a2 = normalizeAngle(Math.atan2(far2.y - v.y, far2.x - v.x));

    const radius = dist(v, tp);
    if (radius === 0) return;

    let sweep = normalizeAngle(a2 - a1);
    if (sweep > Math.PI) {
      [a1, a2] = [a2, a1];
      sweep = normalizeAngle(a2 - a1);
    }
    a2 = a1 + sweep;

    const degVal = (sweep * 180) / Math.PI;
    const txt = this.str("text_override") || `${this.fmt(degVal)}°`;
    this.lastText = txt;

    const midAng = a1 + sweep / 2.0;
    const textCenter = { x: v.x + radius * Math.cos(midAng), y: v.y + radius * Math.sin(midAng) };
    const textRect = this.textRectFor(textCenter, txt);
    const textWidth = textRect[2] - textRect[0];

    const halfGap = Math.min(textWidth / 2.0 / radius, (sweep / 2.0) * 0.9);
    const gapStart = midAng - halfGap;
    const gapEnd = midAng + halfGap;

    for (const [segStart, segEnd] of [
      [a1, gapStart],
      [gapEnd, a2],
    ] as [number, number][]) {
      this.arc(ctx, viewport, v, radius, segStart, segEnd);
    }

    const t1 = { x: v.x + radius * Math.cos(a1), y: v.y + radius * Math.sin(a1) };
    const t2 = { x: v.x + radius * Math.cos(a2), y: v.y + radius * Math.sin(a2) };
    this.arrowhead(ctx, viewport, t1, (a1 * 180) / Math.PI - 90.0);
    this.arrowhead(ctx, viewport, t2, (a2 * 180) / Math.PI + 90.0);

    this.centeredText(ctx, viewport, textCenter, txt);
  }

  private drawRadialLeader(ctx: CanvasRenderingContext2D, viewport: Viewport, isDiameter: boolean): void {
    const center = this.p("center");
    const edgePt = this.p("radius_point");
    const tp = this.p("text_position");

    const radius = dist(center, edgePt);
    if (radius === 0) return;

    const computed = isDiameter ? `Ø${this.len(radius * 2)}` : `R${this.len(radius)}`;
    const txt = this.str("text_override") || computed;
    this.lastText = txt;

    this.drawLeaderShaft(ctx, viewport, edgePt, tp, txt);
  }

  private drawLeader(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    const pt = this.p("point");
    const tp = this.p("text_position");
    const txt = this.str("text") ?? "";
    this.lastText = txt;

    this.drawLeaderShaft(ctx, viewport, pt, tp, txt);
  }

  private drawLeaderShaft(ctx: CanvasRenderingContext2D, viewport: Viewport, pt: Point, tp: Point, txt: string): void {
    if (dist(pt, tp) === 0) return;

    const lineOffset = LINE_OFFSET * this.scale;
    const away = tp.x >= pt.x ? 1.0 : -1.0;
    const landingStart = { x: tp.x - away * lineOffset, y: tp.y };

    const leaderVec = pointSub(pt, landingStart);
    let angDeg: number;
    if (leaderVec.x === 0 && leaderVec.y === 0) {
      angDeg = (Math.atan2(pt.y - tp.y, pt.x - tp.x) * 180) / Math.PI;
    } else {
      angDeg = (Math.atan2(leaderVec.y, leaderVec.x) * 180) / Math.PI;
    }
    this.arrowhead(ctx, viewport, pt, angDeg);

    this.line(ctx, viewport, pt, landingStart);
    this.line(ctx, viewport, landingStart, tp);

    this.leaderText(ctx, viewport, tp, txt, away);
  }

  // --- Interaction (move/rotate/copy/hitTest/bounds/grips) ---

  move(dx: number, dy: number): void {
    const delta = { x: dx, y: dy };
    for (const key of this.pointKeysFor(this.dimType)) {
      this.data[key] = pointAdd(this.p(key), delta);
    }
  }

  rotate(cx: number, cy: number, angleRad: number): void {
    for (const key of this.pointKeysFor(this.dimType)) {
      this.data[key] = rotatePoint(this.p(key), cx, cy, angleRad);
    }
  }

  private pointKeysFor(dimType: DimType): string[] {
    switch (dimType) {
      case "linear":
      case "aligned":
        return ["p1", "p2", "text_position"];
      case "angular":
        return ["line1_p1", "line1_p2", "line2_p1", "line2_p2", "text_position"];
      case "diameter":
      case "radius":
        return ["center", "radius_point", "text_position"];
      case "leader":
        return ["point", "text_position"];
    }
  }

  copy(): Dimension {
    const copied: DimData = {};
    for (const [k, v] of Object.entries(this.data)) {
      copied[k] = isPoint(v) ? { ...v } : v;
    }
    return new Dimension(this.dimType, copied);
  }

  hitTest(pt: Point, tolerance = 6.0): boolean {
    for (const { p1, p2 } of this.cachedSegments) {
      if (distanceToSegment(pt, p1, p2) <= tolerance) return true;
    }
    for (const [x0, y0, x1, y1] of this.cachedRects) {
      if (pt.x >= x0 - tolerance && pt.x <= x1 + tolerance && pt.y >= y0 - tolerance && pt.y <= y1 + tolerance) {
        return true;
      }
    }
    for (const { center, radius, start, end } of this.cachedArcs) {
      const d = dist(pt, center);
      if (Math.abs(d - radius) > tolerance) continue;
      let angle = Math.atan2(pt.y - center.y, pt.x - center.x);
      while (angle < start) angle += 2 * Math.PI;
      if (angle <= end) return true;
    }
    return false;
  }

  getBounds(): Bounds {
    // Grips plus everything last drawn: text or arrows placed outside the
    // extension lines count (zoom extents, window selection).
    const points = [...this.getGripPoints()];
    for (const s of this.cachedSegments) points.push(s.p1, s.p2);
    for (const [x0, y0, x1, y1] of this.cachedRects) points.push({ x: x0, y: y0 }, { x: x1, y: y1 });
    if (points.length === 0) return [0, 0, 0, 0];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = { type: this.dimType };
    for (const [k, v] of Object.entries(this.data)) {
      out[k] = isPoint(v) ? { x: v.x, y: v.y } : v;
    }
    return out;
  }

  static fromDict(data: Record<string, unknown>): Dimension {
    const dimType = data.type as DimType;
    const parsed: DimData = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === "type") continue;
      if (typeof v === "object" && v !== null && "x" in v && "y" in v) {
        const p = v as { x: number; y: number };
        parsed[k] = { x: p.x, y: p.y };
      } else {
        parsed[k] = v as number | string;
      }
    }
    return new Dimension(dimType, parsed);
  }

  /** (data-key, point) pairs for this dimension's draggable grips -- ported
   *  from entities/dimension.py's grip_items(); see commands/dimensionGrip.ts's
   *  constrainGrip() for why linear's p1/p2 get special treatment. */
  gripItems(): [string, Point][] {
    switch (this.dimType) {
      case "linear":
      case "aligned":
        return [
          ["p1", this.p("p1")],
          ["p2", this.p("p2")],
          ["text_position", this.textAt ?? this.p("text_position")],
        ];
      case "angular":
        return [
          ["line1_p2", this.p("line1_p2")],
          ["line2_p2", this.p("line2_p2")],
          ["text_position", this.p("text_position")],
        ];
      case "diameter":
      case "radius":
        return [
          ["center", this.p("center")],
          ["radius_point", this.p("radius_point")],
          ["text_position", this.p("text_position")],
        ];
      case "leader":
        return [
          ["point", this.p("point")],
          ["text_position", this.p("text_position")],
        ];
    }
  }

  getGripPoints(): Point[] {
    return this.gripItems().map(([, pt]) => pt);
  }

  /** Constrains a proposed new position for grip `key` -- see
   *  entities/dimension.py's constrain_grip() for the full rationale:
   *  linear's p1/p2 may only move perpendicular to the measured axis, so a
   *  grip drag can never silently change the measured value. */
  constrainGrip(key: string, point: Point): Point {
    if (this.dimType !== "linear" || (key !== "p1" && key !== "p2")) return point;

    const original = this.p(key);
    return this.linearHorizontal() ? { x: original.x, y: point.y } : { x: point.x, y: original.y };
  }

  getDisplayText(): string {
    return this.lastText;
  }

  setTextOverride(text: string): void {
    if (this.dimType === "leader") {
      this.data.text = text;
    } else {
      this.data.text_override = text;
    }
  }

  /**
   * Decomposes this dimension into its constituent Line/Arc/Text primitives,
   * in this app's own Y-down world space -- used by DXF export (a Dimension
   * has no native DXF representation, matching entities/dimension.py having
   * no dxf_layer/dxf_color of its own either). Mirrors file_io/dxf.py's
   * explode_entity() mock-painter approach, but simpler: this port's draw()
   * already caches its computed world-space geometry as a side effect (for
   * hitTest()/getBounds(), see cachedSegments/cachedRects/cachedArcs above),
   * so explode() just runs draw() once against a no-op context + identity
   * viewport and reads that cache back, instead of intercepting painter
   * calls through a mock.
   */
  explode(): Entity[] {
    const noop = () => {};
    const ctx = {
      save: noop,
      restore: noop,
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      stroke: noop,
      arc: noop,
      fillText: noop,
      setLineDash: noop,
    } as unknown as CanvasRenderingContext2D;
    const viewport = new ViewportClass(() => 1, () => 1);
    this.draw(ctx, viewport, false);

    const entities: Entity[] = [];
    for (const { p1, p2 } of this.cachedSegments) entities.push(new Line(p1, p2));
    for (const { center, radius, start, end } of this.cachedArcs) entities.push(new Arc(center, radius, start, end));
    const rect = this.cachedRects[0];
    if (rect !== undefined && this.lastText !== "") {
      entities.push(new Text({ x: rect[0], y: rect[3] }, this.lastText, TEXT_HEIGHT));
    }
    return entities;
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeAngle(rad: number): number {
  const twoPi = 2 * Math.PI;
  return ((rad % twoPi) + twoPi) % twoPi;
}

function distanceToSegment(pt: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq === 0) return dist(pt, a);
  let t = ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return dist(pt, { x: a.x + t * abx, y: a.y + t * aby });
}

/** Line-line intersection of infinite lines through (p1,p2) and (p3,p4), or
 *  null if parallel -- ported from entities/dimension.py's use of QLineF's
 *  own intersects(). */
function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}
