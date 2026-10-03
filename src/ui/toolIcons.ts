/**
 * MinimalCAD Web
 * ui/toolIcons.ts
 *
 * Small procedurally-drawn line-art icons for ui/toolbar.ts -- ported from
 * the desktop app's ui/tool_icons.py 1:1 where the geometry translates
 * directly (line/rect/arrow primitives in a local 0..20 square); a few
 * Qt-angle-convention-dependent arcs (arc/rotate/angular) are redrawn as
 * visually equivalent Canvas2D arcs rather than transliterated, since
 * Canvas2D's native angle convention already differs from Qt's (see
 * entities/arc.ts's own header comment on this exact mismatch) and these
 * are decorative glyphs, not world-space geometry -- pixel-exact parity
 * isn't the goal, "reads the same" is. No image assets, same as the
 * desktop app: each icon is a few canvas strokes, built lazily on first
 * use and cached per name.
 *
 * Utility-button icons (undo/redo/zoom/save/open/DXF/cloud) have no
 * desktop-app equivalent in tool_icons.py (Qt used its own toolbar icons
 * for window-level actions there) -- these are new, but drawn in the same
 * stroke style/weight so the whole toolbar reads as one consistent set.
 */

const SIZE = 20;
const STROKE_COLOR = "#d4d4d4";
const STROKE_WIDTH = 1.4;

type Drawer = (ctx: CanvasRenderingContext2D) => void;

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function dashed(ctx: CanvasRenderingContext2D, fn: () => void): void {
  ctx.setLineDash([3, 2]);
  fn();
  ctx.setLineDash([]);
}

/** Small open V arrowhead, tip at (tipX, tipY), pointing along angleDeg. */
function arrowhead(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, angleDeg: number, size = 3.5): void {
  const rad = (angleDeg * Math.PI) / 180;
  const backX = tipX - size * Math.cos(rad);
  const backY = tipY - size * Math.sin(rad);
  const nx = -Math.sin(rad);
  const ny = Math.cos(rad);
  const half = size * 0.6;
  line(ctx, tipX, tipY, backX + nx * half, backY + ny * half);
  line(ctx, tipX, tipY, backX - nx * half, backY - ny * half);
}

function glyph(char: string): Drawer {
  return (ctx) => {
    ctx.font = `bold ${SIZE * 0.62}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = STROKE_COLOR;
    ctx.fillText(char, SIZE / 2, SIZE / 2 + 0.5);
  };
}

// --- Draw ---

function drawLine(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 18, 18, 2);
}

function drawArc(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.arc(4, 16, 14, -Math.PI / 2, 0);
  ctx.stroke();
}

function drawRectangle(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(2, 4, 16, 12);
}

function drawCircle(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.arc(10, 10, 8, 0, 2 * Math.PI);
  ctx.stroke();
}

function drawEllipse(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.ellipse(10, 10, 9, 6, 0, 0, 2 * Math.PI);
  ctx.stroke();
}

const drawText: Drawer = glyph("A");

// --- Dimension ---

function drawLinear(ctx: CanvasRenderingContext2D): void {
  const y = 10;
  const x0 = 2;
  const x1 = 18;
  line(ctx, x0, 3, x0, 17);
  line(ctx, x1, 3, x1, 17);
  line(ctx, x0, y, x1, y);
  arrowhead(ctx, x0, y, 180);
  arrowhead(ctx, x1, y, 0);
}

function drawAligned(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 18, 18, 2);
  arrowhead(ctx, 2, 18, 135);
  arrowhead(ctx, 18, 2, -45);
}

function drawAngular(ctx: CanvasRenderingContext2D): void {
  const vx = 2;
  const vy = 18;
  line(ctx, vx, vy, 18, vy);
  line(ctx, vx, vy, vx, 2);
  ctx.beginPath();
  ctx.arc(vx, vy, 7, 0, -Math.PI / 3, true);
  ctx.stroke();
}

const drawDiameter = glyph("Ø");
const drawRadius = glyph("R");

function drawLeader(ctx: CanvasRenderingContext2D): void {
  const tipX = 2;
  const tipY = 18;
  const kneeX = 10;
  const kneeY = 4;
  line(ctx, tipX, tipY, kneeX, kneeY);
  line(ctx, kneeX, kneeY, 18, kneeY);
  arrowhead(ctx, tipX, tipY, (Math.atan2(tipY - kneeY, tipX - kneeX) * 180) / Math.PI);
}

// --- Modify ---

function drawMove(ctx: CanvasRenderingContext2D): void {
  const cx = 10;
  const cy = 10;
  for (const ang of [0, 90, 180, 270]) {
    const rad = (ang * Math.PI) / 180;
    const tipX = cx + Math.cos(rad) * 8;
    const tipY = cy + Math.sin(rad) * 8;
    line(ctx, cx, cy, tipX, tipY);
    arrowhead(ctx, tipX, tipY, ang);
  }
}

function drawCopy(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(1, 4, 12, 12);
  ctx.strokeRect(7, 8, 12, 12);
}

function drawRotate(ctx: CanvasRenderingContext2D): void {
  const cx = 10;
  const cy = 10;
  const radius = 7;
  const start = (20 * Math.PI) / 180;
  const end = start + (300 * Math.PI) / 180;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end, false);
  ctx.stroke();
  const tipX = cx + radius * Math.cos(end);
  const tipY = cy + radius * Math.sin(end);
  arrowhead(ctx, tipX, tipY, (end * 180) / Math.PI + 90);
}

function drawPolarArray(ctx: CanvasRenderingContext2D): void {
  const cx = 10;
  const cy = 10;
  const radius = 6.8;
  for (let i = 0; i < 5; i++) {
    const ang = ((90 + i * 72) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(cx + radius * Math.cos(ang), cy + radius * Math.sin(ang), 1.4, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function drawTrim(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 10, 18, 10);
  line(ctx, 7, 6, 13, 14);
  line(ctx, 13, 6, 7, 14);
}

function drawOffset(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 17, 15, 3);
  dashed(ctx, () => line(ctx, 5, 19, 18, 6));
}

function drawMirror(ctx: CanvasRenderingContext2D): void {
  dashed(ctx, () => line(ctx, 10, 1, 10, 19));
  line(ctx, 7, 17, 7, 3);
  line(ctx, 7, 17, 2, 17);
  line(ctx, 13, 17, 13, 3);
  line(ctx, 13, 17, 18, 17);
}

/** The sharp corner two lines would have made, dashed -- shared by Fillet
 *  and Chamfer so they read as "this corner, changed". */
function sharpCorner(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  dashed(ctx, () => {
    line(ctx, 3, 10, 3, 17);
    line(ctx, 3, 17, 10, 17);
  });
  ctx.restore();
}

function drawFillet(ctx: CanvasRenderingContext2D): void {
  // two lines meeting in a rounded corner
  sharpCorner(ctx);
  ctx.beginPath();
  ctx.moveTo(3, 2);
  ctx.lineTo(3, 10);
  ctx.arcTo(3, 17, 10, 17, 7);
  ctx.lineTo(18, 17);
  ctx.stroke();
}

function drawChamfer(ctx: CanvasRenderingContext2D): void {
  // two lines meeting in a bevelled corner
  sharpCorner(ctx);
  ctx.beginPath();
  ctx.moveTo(3, 2);
  ctx.lineTo(3, 10);
  ctx.lineTo(10, 17);
  ctx.lineTo(18, 17);
  ctx.stroke();
}

function drawJoin(ctx: CanvasRenderingContext2D): void {
  // Two separate segments with a gap, bridged by a small dot -- the
  // opposite visual idea of trim's icon (a perpendicular cut mark).
  const y = 10;
  line(ctx, 2, y, 7, y);
  line(ctx, 13, y, 18, y);
  ctx.beginPath();
  ctx.arc(10, y, 1.8, 0, 2 * Math.PI);
  ctx.fill();
}

function drawExplode(ctx: CanvasRenderingContext2D): void {
  // Three short fragments pulled apart from a common center.
  const cx = 10;
  const cy = 10;
  for (const ang of [200, 340, 90]) {
    const rad = (ang * Math.PI) / 180;
    line(ctx, cx + Math.cos(rad) * 2, cy + Math.sin(rad) * 2, cx + Math.cos(rad) * 8, cy + Math.sin(rad) * 8);
  }
}

function drawScale(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(2, 12, 6, 6);
  ctx.strokeRect(8, 2, 10, 10);
  line(ctx, 4, 14, 17, 3);
  arrowhead(ctx, 17, 3, -45);
}

// --- Utility (no desktop tool_icons.py equivalent -- see header comment) ---

function drawCurvedArrow(ctx: CanvasRenderingContext2D, mirrored: boolean): void {
  ctx.save();
  if (mirrored) {
    ctx.translate(SIZE, 0);
    ctx.scale(-1, 1);
  }
  const cx = 10;
  const cy = 11;
  const radius = 7;
  const start = (-200 * Math.PI) / 180;
  const end = (20 * Math.PI) / 180;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end, false);
  ctx.stroke();
  const tipX = cx + radius * Math.cos(end);
  const tipY = cy + radius * Math.sin(end);
  arrowhead(ctx, tipX, tipY, (end * 180) / Math.PI + 90);
  ctx.restore();
}

// Undo turns BACK: anticlockwise, its head at the left. Redo is its mirror.
const drawUndo: Drawer = (ctx) => drawCurvedArrow(ctx, true);
const drawRedo: Drawer = (ctx) => drawCurvedArrow(ctx, false);

function drawZoomExtents(ctx: CanvasRenderingContext2D): void {
  const bracket = (x: number, y: number, dx: number, dy: number) => {
    line(ctx, x, y, x + dx, y);
    line(ctx, x, y, x, y + dy);
  };
  bracket(2, 2, 5, 5);
  bracket(18, 2, -5, 5);
  bracket(2, 18, 5, -5);
  bracket(18, 18, -5, -5);
}

function drawSave(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(3, 3, 14, 14);
  ctx.strokeRect(6, 3, 8, 5);
  ctx.strokeRect(6, 12, 8, 5);
}

function drawOpen(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(2, 6);
  ctx.lineTo(2, 16);
  ctx.lineTo(18, 16);
  ctx.lineTo(16, 8);
  ctx.lineTo(7, 8);
  ctx.lineTo(6, 6);
  ctx.closePath();
  ctx.stroke();
}

function drawDocumentArrow(ctx: CanvasRenderingContext2D, downward: boolean): void {
  ctx.strokeRect(4, 2, 12, 16);
  const x = 10;
  const top = 6;
  const bottom = 15;
  if (downward) {
    line(ctx, x, top, x, bottom);
    arrowhead(ctx, x, bottom, 90);
  } else {
    line(ctx, x, bottom, x, top);
    arrowhead(ctx, x, top, -90);
  }
}

const drawExportDxf: Drawer = (ctx) => drawDocumentArrow(ctx, true);
const drawImportDxf: Drawer = (ctx) => drawDocumentArrow(ctx, false);

/** Page outline with a folded top-right corner (classic "file" glyph) plus
 *  a lettered "PDF" label -- deliberately distinct from Export/Import DXF's
 *  plain document+arrow glyph (drawDocumentArrow) so the two read as
 *  different actions at a glance despite both being document exports. */
function drawExportPdf(ctx: CanvasRenderingContext2D): void {
  const left = 3;
  const top = 2;
  const right = 17;
  const bottom = 18;
  const fold = 5;

  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(right - fold, top);
  ctx.lineTo(right, top + fold);
  ctx.lineTo(right, bottom);
  ctx.lineTo(left, bottom);
  ctx.closePath();
  ctx.stroke();
  line(ctx, right - fold, top, right - fold, top + fold);
  line(ctx, right - fold, top + fold, right, top + fold);

  ctx.font = "bold 6px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = STROKE_COLOR;
  ctx.fillText("PDF", (left + right) / 2, bottom - 4);
}

function drawInsertDrawing(ctx: CanvasRenderingContext2D): void {
  // Two overlapping page rectangles (the current drawing + the one being
  // merged in), plus a small "+" -- distinguishes this from Copy's plain
  // two-overlapping-squares glyph above.
  ctx.strokeRect(1, 6, 11, 11);
  ctx.strokeRect(7, 2, 11, 11);
  line(ctx, 14, 4, 14, 8);
  line(ctx, 12, 6, 16, 6);
}

/** A shelf/tray baseline with an arrow either going down into it (saving to
 *  the library) or up out of it (inserting from the library) -- ported
 *  directly from ui/tool_icons.py's _draw_folder(). */
function drawFolder(ctx: CanvasRenderingContext2D, arrowInto: boolean): void {
  const x = 10;
  const top = 2;
  const bottom = 14;
  if (arrowInto) {
    line(ctx, x, top, x, bottom);
    arrowhead(ctx, x, bottom, 90);
  } else {
    line(ctx, x, bottom, x, top);
    arrowhead(ctx, x, top, -90);
  }
  line(ctx, 3, 18, 17, 18);
}

const drawInsertLib: Drawer = (ctx) => drawFolder(ctx, true);
const drawSaveLib: Drawer = (ctx) => drawFolder(ctx, false);

/** A circle held a fixed distance from a reference wall -- ported from
 *  ui/tool_icons.py's _draw_constrain(). */
function drawConstrain(ctx: CanvasRenderingContext2D): void {
  line(ctx, 3, 3, 3, 17); // reference wall
  ctx.beginPath();
  ctx.arc(15, 10, 3, 0, Math.PI * 2); // driven point
  ctx.stroke();
  dashed(ctx, () => line(ctx, 5, 10, 11, 10));
  arrowhead(ctx, 5, 10, 180);
  arrowhead(ctx, 11, 10, 0);
}

// --- Geometric constraints: the line(s) involved, with a small amber tie mark ---

const CONSTRAINT_MARK = "#f5b942";

function tieMark(ctx: CanvasRenderingContext2D, draw: () => void): void {
  ctx.save();
  ctx.strokeStyle = CONSTRAINT_MARK;
  ctx.fillStyle = CONSTRAINT_MARK;
  ctx.lineWidth = 1.6;
  draw();
  ctx.restore();
}

function drawHorizontal(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 12, 18, 12);
  tieMark(ctx, () => {
    line(ctx, 7, 6, 13, 6);
  });
  dashed(ctx, () => line(ctx, 2, 17, 18, 17));
}

function drawVertical(ctx: CanvasRenderingContext2D): void {
  line(ctx, 8, 2, 8, 18);
  tieMark(ctx, () => {
    line(ctx, 14, 7, 14, 13);
  });
  dashed(ctx, () => line(ctx, 3, 2, 3, 18));
}

function drawParallel(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 15, 12, 3);
  line(ctx, 8, 17, 18, 5);
  tieMark(ctx, () => {
    line(ctx, 3, 5, 6, 8);
    line(ctx, 14, 12, 17, 15);
  });
}

function drawPerpendicular(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 17, 18, 17);
  line(ctx, 10, 17, 10, 3);
  tieMark(ctx, () => {
    line(ctx, 10, 13, 14, 13);
    line(ctx, 14, 13, 14, 17);
  });
}

function drawEqual(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 4, 18, 4);
  line(ctx, 2, 16, 18, 16);
  tieMark(ctx, () => {
    line(ctx, 7, 8.5, 13, 8.5);
    line(ctx, 7, 11.5, 13, 11.5);
  });
}

function drawCoincident(ctx: CanvasRenderingContext2D): void {
  line(ctx, 2, 17, 10, 10);
  line(ctx, 10, 10, 18, 4);
  tieMark(ctx, () => {
    ctx.beginPath();
    ctx.arc(10, 10, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawCloud(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.arc(7, 12, 4, Math.PI * 0.5, Math.PI * 1.6);
  ctx.arc(11, 8, 5, Math.PI * 1.1, Math.PI * 2.05);
  ctx.arc(14.5, 12, 3.5, Math.PI * 1.4, Math.PI * 0.55);
  ctx.lineTo(7, 16);
  ctx.closePath();
  ctx.stroke();
}

// --- 3D / sketch workspace ---
//
// 3D feature icons are small SHADED solids (Inventor-style) rather than
// line art: blue for the part, amber for what the feature adds or changes,
// so each reads as what it does even at 20 px.

const SOLID_TOP = "#9dbdf0";
const SOLID_FRONT = "#5f88cc";
const SOLID_SIDE = "#3d63a6";
const ACCENT = "#f5b942";
const ACCENT_DARK = "#c78a1c";
const OUTLINE = "#10141c";
const HOLE_DARK = "#161a22";

/** Fills (and thinly outlines) a polygon. */
function facet(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
}

/** A shaded block seen from the front-right-top: front face at (x, y) size
 *  w x h, receding by d. `top` recolours its top face. */
function block(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, d: number, top = SOLID_TOP): void {
  facet(ctx, [[x, y], [x + d, y - d], [x + w + d, y - d], [x + w, y]], top);
  facet(ctx, [[x + w, y], [x + w + d, y - d], [x + w + d, y + h - d], [x + w, y + h]], SOLID_SIDE);
  facet(ctx, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], SOLID_FRONT);
}

/** A solid arrow (shaft + filled head) from (x1, y1) to (x2, y2). */
function solidArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string): void {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = 4;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8;
  line(ctx, x1, y1, x2 - Math.cos(a) * head * 0.6, y2 - Math.sin(a) * head * 0.6);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(a - 0.5) * head, y2 - Math.sin(a - 0.5) * head);
  ctx.lineTo(x2 - Math.cos(a + 0.5) * head, y2 - Math.sin(a + 0.5) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Parallelogram "plane" seen at an angle -- shared by the sketch icons. */
function planeOutline(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(1, 15);
  ctx.lineTo(6, 10);
  ctx.lineTo(19, 10);
  ctx.lineTo(14, 15);
  ctx.closePath();
  ctx.stroke();
}

function drawNewSketch(ctx: CanvasRenderingContext2D): void {
  // a plane with a pencil drawing on it
  facet(ctx, [[1, 16], [6, 10], [19, 10], [14, 16]], "rgba(245, 185, 66, 0.45)");
  ctx.save();
  ctx.lineWidth = 1;
  line(ctx, 5, 14, 9, 14);
  line(ctx, 9, 14, 11, 12);
  ctx.restore();
  facet(ctx, [[10, 12.5], [16, 3], [18.5, 4.6], [12.5, 14]], "#e8e8e8");
  facet(ctx, [[10, 12.5], [12.5, 14], [9.6, 15]], ACCENT_DARK);
}

function drawFinishSketch(ctx: CanvasRenderingContext2D): void {
  planeOutline(ctx);
  ctx.strokeStyle = "#4caf50";
  ctx.lineWidth = 2;
  line(ctx, 6, 5, 9, 8);
  line(ctx, 9, 8, 16, 1);
}

function drawExtrude(ctx: CanvasRenderingContext2D): void {
  // a block pushed up out of its (amber) profile
  block(ctx, 2, 10, 11, 8, 5, ACCENT);
  solidArrow(ctx, 10, 8.5, 10, 0.5, "#ffffff");
}

function drawRevolve(ctx: CanvasRenderingContext2D): void {
  // a turned solid about its axis, with the turn arrow
  const g = ctx.createLinearGradient(4, 0, 16, 0);
  g.addColorStop(0, SOLID_SIDE);
  g.addColorStop(0.45, SOLID_TOP);
  g.addColorStop(1, SOLID_SIDE);
  ctx.beginPath();
  ctx.moveTo(4, 7);
  ctx.lineTo(4, 15);
  ctx.ellipse(10, 15, 6, 2.2, 0, Math.PI, 0, true);
  ctx.lineTo(16, 7);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(10, 7, 6, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.1;
  ctx.setLineDash([3, 1.5, 0.8, 1.5]);
  line(ctx, 10, 0.5, 10, 19.5);
  ctx.setLineDash([]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.ellipse(10, 3, 5, 1.8, 0, Math.PI * 0.15, Math.PI * 0.95);
  ctx.stroke();
  ctx.restore();
  solidArrow(ctx, 6.4, 4.4, 4.2, 2.2, "#ffffff");
}

function drawHole(ctx: CanvasRenderingContext2D): void {
  // a block with a hole drilled in its FRONT face (a full round circle,
  // not a thin ellipse on top), and its centre mark
  block(ctx, 1, 6, 14, 13, 4);
  ctx.beginPath();
  ctx.arc(8, 12.5, 4, 0, Math.PI * 2);
  ctx.fillStyle = HOLE_DARK;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineWidth = 0.9;
  line(ctx, 8, 7, 8, 18);
  line(ctx, 2.5, 12.5, 13.5, 12.5);
  ctx.restore();
}

/** The block both edge features are shown on: its top-front-right edge is
 *  rounded (fillet) or bevelled (chamfer), that new face in amber. */
function edgeBlock(ctx: CanvasRenderingContext2D, round: boolean): void {
  facet(ctx, [[2, 6], [5, 3], [12, 3], [9, 6]], SOLID_TOP);
  facet(ctx, [[15, 12], [18, 9], [18, 15], [15, 18]], SOLID_SIDE);
  // the changed edge, as a band running back
  ctx.beginPath();
  ctx.moveTo(9, 6);
  if (round) ctx.arc(9, 12, 6, -Math.PI / 2, 0);
  else ctx.lineTo(15, 12);
  ctx.lineTo(18, 9);
  if (round) ctx.arc(12, 9, 6, 0, -Math.PI / 2, true);
  else ctx.lineTo(12, 3);
  ctx.closePath();
  ctx.fillStyle = ACCENT;
  ctx.fill();
  // front face
  ctx.beginPath();
  ctx.moveTo(2, 18);
  ctx.lineTo(2, 6);
  ctx.lineTo(9, 6);
  if (round) ctx.arc(9, 12, 6, -Math.PI / 2, 0);
  else ctx.lineTo(15, 12);
  ctx.lineTo(15, 18);
  ctx.closePath();
  ctx.fillStyle = SOLID_FRONT;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
}

const drawFillet3d: Drawer = (ctx) => edgeBlock(ctx, true);
const drawChamfer3d: Drawer = (ctx) => edgeBlock(ctx, false);

function drawPattern3d(ctx: CanvasRenderingContext2D): void {
  // the same small block repeated in a grid; the original in amber
  const cell = (x: number, y: number, top: string): void => block(ctx, x, y, 4.5, 4, 2, top);
  cell(11, 5, SOLID_TOP);
  cell(2, 5, SOLID_TOP);
  cell(11, 14, SOLID_TOP);
  cell(2, 14, ACCENT);
}

function drawCircPattern(ctx: CanvasRenderingContext2D): void {
  // holes spaced round a disc
  ctx.beginPath();
  ctx.arc(10, 10, 8.5, 0, Math.PI * 2);
  ctx.fillStyle = SOLID_FRONT;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(10 + 5.4 * Math.cos(a), 10 + 5.4 * Math.sin(a), 1.7, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? ACCENT : HOLE_DARK;
    ctx.fill();
  }
}

function drawMirror3d(ctx: CanvasRenderingContext2D): void {
  // a shape and its reflection either side of a dashed plane
  facet(ctx, [[2, 16], [2, 8], [7, 4], [7, 16]], ACCENT);
  facet(ctx, [[18, 16], [18, 8], [13, 4], [13, 16]], SOLID_FRONT);
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.1;
  ctx.setLineDash([2.5, 1.5]);
  line(ctx, 10, 1, 10, 19);
  ctx.restore();
}

function drawWorkPlane(ctx: CanvasRenderingContext2D): void {
  // an amber plane tilted up off a (dashed) base plane
  dashed(ctx, () => planeOutline(ctx));
  facet(ctx, [[3, 12], [9, 3], [19, 5], [13, 14]], "rgba(245, 185, 66, 0.6)");
}

/** Cube in one of the standard orientations, `face` highlighted. */
function viewCube(face: "front" | "top" | "right" | "iso"): Drawer {
  return (ctx) => {
    const front: [number, number][] = [[3, 8], [13, 8], [13, 18], [3, 18]];
    const top: [number, number][] = [[3, 8], [8, 3], [18, 3], [13, 8]];
    const right: [number, number][] = [[13, 8], [18, 3], [18, 13], [13, 18]];
    const path = (pts: [number, number][]): void => {
      ctx.beginPath();
      ctx.moveTo(pts[0]![0], pts[0]![1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
    };
    ctx.fillStyle = "rgba(90,160,255,0.75)";
    for (const [name, pts] of [["front", front], ["top", top], ["right", right]] as const) {
      path(pts);
      if (face === name || face === "iso") ctx.fill();
      ctx.stroke();
    }
  };
}

// --- Drawing sheet tools: a sheet with its title block, and views on it ---

function sheetOutline(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(1.5, 3.5, 17, 13);
  ctx.strokeRect(11, 13, 7.5, 3.5);
}

function drawSheet(ctx: CanvasRenderingContext2D): void {
  sheetOutline(ctx);
  line(ctx, 11, 14.8, 18.5, 14.8);
}

function drawBaseView(ctx: CanvasRenderingContext2D): void {
  sheetOutline(ctx);
  ctx.strokeRect(4, 6, 5, 4);
  ctx.beginPath();
  ctx.arc(6.5, 8, 1, 0, Math.PI * 2);
  ctx.stroke();
}

function drawProjectedView(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(1.5, 2, 7, 6);
  dashed(ctx, () => ctx.strokeRect(12, 2, 6.5, 6));
  ctx.strokeRect(1.5, 12, 7, 6);
  line(ctx, 9.5, 5, 11, 5);
  line(ctx, 5, 9, 5, 11);
}

function drawSectionView(ctx: CanvasRenderingContext2D): void {
  // a view with its cutting line and arrows, and the hatched section beside it
  ctx.strokeRect(1.5, 5, 7, 10);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 1, 1, 1]);
  line(ctx, 5, 2, 5, 18);
  ctx.restore();
  arrowhead(ctx, 8, 2.5, 0, 2.5);
  arrowhead(ctx, 8, 17.5, 0, 2.5);
  ctx.strokeRect(12, 5, 6.5, 10);
  ctx.save();
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.rect(12, 5, 6.5, 10);
  ctx.clip();
  for (let k = -10; k < 10; k += 2.5) line(ctx, 12 + k, 15, 12 + k + 10, 5);
  ctx.restore();
}

function drawMoveView(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(5, 6, 10, 8);
  line(ctx, 10, 1, 10, 19);
  line(ctx, 1, 10, 19, 10);
  arrowhead(ctx, 10, 1, -90);
  arrowhead(ctx, 19, 10, 0);
}

function drawEditView(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(1.5, 5, 11, 9);
  line(ctx, 9, 17, 18, 8);
  line(ctx, 18, 8, 16, 6);
  line(ctx, 16, 6, 7, 15);
  line(ctx, 7, 15, 9, 17);
}

function drawDeleteView(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(1.5, 3, 12, 10);
  line(ctx, 12, 11, 19, 18);
  line(ctx, 19, 11, 12, 18);
}

function drawLine3d(ctx: CanvasRenderingContext2D): void {
  // a slanted closed loop drawn point to point off a block corner
  block(ctx, 2, 10, 8, 7, 3);
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(18, 3);
  ctx.lineTo(18, 12);
  ctx.lineTo(10, 17);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  for (const [x, y] of [[10, 10], [18, 3], [18, 12], [10, 17]] as const) ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
  ctx.restore();
}

function drawRotate3d(ctx: CanvasRenderingContext2D): void {
  // a block with a turning arrow round it
  block(ctx, 5, 8, 8, 7, 3);
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(10, 10, 8, Math.PI * 0.95, Math.PI * 1.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(18.6, 5.2);
  ctx.lineTo(17.6, 9.4);
  ctx.lineTo(14.2, 6.6);
  ctx.closePath();
  ctx.fillStyle = ACCENT;
  ctx.fill();
  ctx.restore();
}

const DRAWERS: Record<string, Drawer> = {
  sheet: drawSheet,
  baseview: drawBaseView,
  projview: drawProjectedView,
  sectionview: drawSectionView,
  moveview: drawMoveView,
  editview: drawEditView,
  deleteview: drawDeleteView,
  newsketch: drawNewSketch,
  finishsketch: drawFinishSketch,
  extrude: drawExtrude,
  revolve: drawRevolve,
  workplane: drawWorkPlane,
  hole: drawHole,
  pattern: drawPattern3d,
  circpattern: drawCircPattern,
  mirror3d: drawMirror3d,
  rotate3d: drawRotate3d,
  line3d: drawLine3d,
  fillet3d: drawFillet3d,
  chamfer3d: drawChamfer3d,
  viewfront: viewCube("front"),
  viewtop: viewCube("top"),
  viewright: viewCube("right"),
  viewiso: viewCube("iso"),
  line: drawLine,
  arc: drawArc,
  rectangle: drawRectangle,
  circle: drawCircle,
  ellipse: drawEllipse,
  text: drawText,
  linear: drawLinear,
  aligned: drawAligned,
  angular: drawAngular,
  diameter: drawDiameter,
  radius: drawRadius,
  leader: drawLeader,
  move: drawMove,
  copy: drawCopy,
  rotate: drawRotate,
  polararray: drawPolarArray,
  trim: drawTrim,
  offset: drawOffset,
  mirror: drawMirror,
  fillet: drawFillet,
  chamfer: drawChamfer,
  join: drawJoin,
  explode: drawExplode,
  scale: drawScale,
  undo: drawUndo,
  redo: drawRedo,
  zoomextents: drawZoomExtents,
  save: drawSave,
  open: drawOpen,
  exportdxf: drawExportDxf,
  importdxf: drawImportDxf,
  insertdrawing: drawInsertDrawing,
  insertlib: drawInsertLib,
  savelib: drawSaveLib,
  constrain: drawConstrain,
  horizontal: drawHorizontal,
  vertical: drawVertical,
  parallel: drawParallel,
  perpendicular: drawPerpendicular,
  equal: drawEqual,
  coincident: drawCoincident,
  pdfexport: drawExportPdf,
  cloud: drawCloud,
};

/** Renders `name`'s icon into `canvas`, sized crisply for the current
 *  device pixel ratio (this app runs heavily on tablets, see
 *  ui/canvasView.ts's own touch handling -- a plain 20x20 canvas would
 *  render blurry on a high-DPI screen once scaled up by CSS). No-op
 *  (blank icon) for an unrecognized name, matching tool_icons.py's own
 *  build_icon() falling through silently rather than throwing.
 *
 *  `color`, when given, overrides the normal stroke/fill color -- used by
 *  ui/cloudPanelImpl.ts to recolor the Cloud icon to the same cyan as the
 *  command bar's own status text (#00ffff) while signed in, an
 *  at-a-glance "this session is logged in" indicator with no separate
 *  badge/text needed. */
export function drawIcon(name: string, canvas: HTMLCanvasElement, color: string = STROKE_COLOR): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${SIZE}px`;

  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  DRAWERS[name.toLowerCase()]?.(ctx);
}
