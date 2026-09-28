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

function drawFillet(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(3, 3, 14, 14, 8);
  } else {
    ctx.rect(3, 3, 14, 14);
  }
  ctx.stroke();
}

function drawChamfer(ctx: CanvasRenderingContext2D): void {
  const pts: [number, number][] = [
    [3, 8],
    [8, 3],
    [17, 3],
    [17, 17],
    [3, 17],
    [3, 8],
  ];
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
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

const drawUndo: Drawer = (ctx) => drawCurvedArrow(ctx, false);
const drawRedo: Drawer = (ctx) => drawCurvedArrow(ctx, true);

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
  planeOutline(ctx);
  line(ctx, 9, 12.5, 16, 2);
  line(ctx, 16, 2, 18, 3.5);
  line(ctx, 18, 3.5, 11, 13.5);
}

function drawFinishSketch(ctx: CanvasRenderingContext2D): void {
  planeOutline(ctx);
  ctx.strokeStyle = "#4caf50";
  ctx.lineWidth = 2;
  line(ctx, 6, 5, 9, 8);
  line(ctx, 9, 8, 16, 1);
}

function drawExtrude(ctx: CanvasRenderingContext2D): void {
  ctx.strokeRect(2, 8, 12, 9);
  line(ctx, 2, 8, 6, 5);
  line(ctx, 14, 8, 18, 5);
  line(ctx, 6, 5, 18, 5);
  line(ctx, 18, 5, 18, 14);
  line(ctx, 14, 17, 18, 14);
  line(ctx, 8, 13, 8, 1);
  arrowhead(ctx, 8, 1, -90);
}

function drawWorkPlane(ctx: CanvasRenderingContext2D): void {
  // tilted plane over a dashed base plane
  dashed(ctx, () => planeOutline(ctx));
  ctx.beginPath();
  ctx.moveTo(3, 11);
  ctx.lineTo(9, 3);
  ctx.lineTo(19, 5);
  ctx.lineTo(13, 13);
  ctx.closePath();
  ctx.stroke();
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

const DRAWERS: Record<string, Drawer> = {
  newsketch: drawNewSketch,
  finishsketch: drawFinishSketch,
  extrude: drawExtrude,
  workplane: drawWorkPlane,
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
