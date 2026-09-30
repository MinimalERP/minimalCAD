/**
 * MinimalCAD Web
 * drawing/sheet.ts
 *
 * Drawing sheets: the data a sheet is saved as (Document.sheets), and the
 * graphics it turns into -- paper border, a simple title block, and the
 * part's views (drawing/hlr.ts) at their scales.
 *
 * Coordinates: a sheet is laid out on paper in mm with the origin at the
 * paper's bottom-left, Y up (`x`, `y` of a view). The 2D engine that edits
 * a sheet works Y-down like every drawing in this app, so graphics come out
 * in WORLD coords = (paper x, -paper y); annotations (dimensions, notes)
 * the user adds live in that same world.
 */

import type { Bounds, Point } from "../core/types";
import type { Entity } from "../entities/entity";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { Circle } from "../entities/circle";
import { Polyline } from "../entities/polyline";
import type { Body } from "../part/kernel/types";
import type { Vec3 } from "../part/vec3";
import { cross, dot, normalize, scale as vscale } from "../part/vec3";
import type { ViewAxes, ViewCurve, ViewResult } from "./hlr";
import { viewBodies } from "./hlr";

export type Paper = "A4" | "A2";
/** Landscape sizes, mm. */
export const PAPER_SIZE: Record<Paper, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A2: { w: 594, h: 420 },
};
export type Projection = "first" | "third";

export interface SheetTitle {
  company: string;
  title: string;
  drawingNo: string;
  material: string;
  drawnBy: string;
  date: string;
  revision: string;
}

export interface SheetView {
  id: string;
  /** Towards the viewer, and the paper's up direction (model coords). */
  dir: Vec3;
  up: Vec3;
  /** Paper mm per model mm (0.5 = 1:2). */
  scale: number;
  /** Paper position of the view's centre (mm, Y up). */
  x: number;
  y: number;
  /** A projected view follows its parent: same scale, kept in line. */
  parent?: string;
  /** An iso projected view: placed and scaled on its own (not in line). */
  free?: boolean;
  hiddenLines: boolean;
  label: string;
  /** "shaded": the part's faces filled with light and shade (hidden lines
   *  are then never drawn). Default: lines only. */
  style?: ViewStyle;
}

export type ViewStyle = "lines" | "shaded";

export interface SheetData {
  id: string;
  name: string;
  paper: Paper;
  projection: Projection;
  title: SheetTitle;
  views: SheetView[];
  /** Annotations (dimensions, notes, lines) as serialized 2D entities. */
  entities: Record<string, unknown>[];
  constraints: unknown[];
  /** Dimension decimals on this sheet: "auto" = no trailing zeros (25,
   *  12.5), or a fixed 0-3. */
  dimPrecision?: "auto" | number;
  /** The model the views show (a copy, refreshed from the linked model tab
   *  whenever the drawing tab opens) -- so a saved drawing stands alone. */
  model?: { name: string; part: unknown; entities: Record<string, unknown>[] };
}

export function newSheet(id = "Sheet1"): SheetData {
  return {
    id,
    name: id,
    paper: "A4",
    projection: "first",
    title: { company: "", title: "", drawingNo: "", material: "", drawnBy: "", date: new Date().toISOString().slice(0, 10), revision: "0" },
    views: [],
    entities: [],
    constraints: [],
  };
}

/** Lenient read of Document.sheets: drops anything malformed. */
export function parseSheets(raw: unknown): SheetData[] {
  if (!Array.isArray(raw)) return [];
  const out: SheetData[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue;
    const o = s as Partial<SheetData>;
    if (typeof o.id !== "string" || !Array.isArray(o.views)) continue;
    const base = newSheet(o.id);
    out.push({
      ...base,
      name: typeof o.name === "string" ? o.name : o.id,
      paper: o.paper === "A2" ? "A2" : "A4",
      projection: o.projection === "third" ? "third" : "first",
      title: { ...base.title, ...(typeof o.title === "object" && o.title !== null ? o.title : {}) },
      views: o.views.filter((v): v is SheetView => typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.scale === "number"),
      entities: Array.isArray(o.entities) ? o.entities : [],
      constraints: Array.isArray(o.constraints) ? o.constraints : [],
      ...(typeof o.dimPrecision === "number" ? { dimPrecision: Math.max(0, Math.min(4, Math.round(o.dimPrecision))) } : {}),
      ...(typeof o.model === "object" && o.model !== null && Array.isArray(o.model.entities) ? { model: o.model } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orientations

const Z: Vec3 = { x: 0, y: 0, z: 1 };
const ISO = 1 / Math.sqrt(3);

/** Standard views of the model (Z up; Front looks along +Y). */
export const ORIENTATIONS = {
  front: { dir: { x: 0, y: -1, z: 0 }, up: Z, label: "Front" },
  back: { dir: { x: 0, y: 1, z: 0 }, up: Z, label: "Back" },
  top: { dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, label: "Top" },
  bottom: { dir: { x: 0, y: 0, z: -1 }, up: { x: 0, y: -1, z: 0 }, label: "Bottom" },
  right: { dir: { x: 1, y: 0, z: 0 }, up: Z, label: "Right" },
  left: { dir: { x: -1, y: 0, z: 0 }, up: Z, label: "Left" },
  iso: { dir: { x: ISO, y: -ISO, z: ISO }, up: Z, label: "Iso" },
} as const;
export type Orientation = keyof typeof ORIENTATIONS;

export function axesOf(v: Pick<SheetView, "dir" | "up">): ViewAxes {
  const dir = normalize(v.dir);
  const right = normalize(cross(v.up, dir));
  return { dir, right, up: cross(dir, right) };
}

export type Side = "left" | "right" | "up" | "down";

/** The view seen when projecting from `parent` towards `side` of it on the
 *  paper. Third angle: the view placed on a side is the one seen FROM that
 *  side (right view on the right). First angle: the opposite (left view on
 *  the right, top view below). */
export function projectedAxes(parent: Pick<SheetView, "dir" | "up">, side: Side, projection: Projection): { dir: Vec3; up: Vec3 } {
  const a = axesOf(parent);
  const s = side === "right" ? a.right : side === "left" ? vscale(a.right, -1) : side === "up" ? a.up : vscale(a.up, -1);
  const dir = projection === "third" ? s : vscale(s, -1);
  if (side === "left" || side === "right") return { dir, up: a.up };
  return { dir, up: cross(dir, a.right) };
}

/** Iso view projected from `parent` towards a corner of it (h, v = +-1:
 *  right / left, up / down): seen from that front corner, equally from
 *  the three sides -- a true isometric from any standard view. */
export function isoAxes(parent: Pick<SheetView, "dir" | "up">, h: 1 | -1, v: 1 | -1): { dir: Vec3; up: Vec3 } {
  const a = axesOf(parent);
  const d = normalize({
    x: a.dir.x + h * a.right.x + v * a.up.x,
    y: a.dir.y + h * a.right.y + v * a.up.y,
    z: a.dir.z + h * a.right.z + v * a.up.z,
  });
  return { dir: d, up: a.up };
}

/** A view's name relative to the drawing's MAIN (base) view -- whatever
 *  way the part was turned for it, the base view is the Front. */
export function relativeName(v: Pick<SheetView, "dir">, root: Pick<SheetView, "dir" | "up">): string {
  const a = axesOf(root);
  const d = normalize(v.dir);
  const names: [Vec3, string][] = [
    [a.dir, "FRONT"],
    [vscale(a.dir, -1), "BACK"],
    [a.up, "TOP"],
    [vscale(a.up, -1), "BOTTOM"],
    [a.right, "RIGHT"],
    [vscale(a.right, -1), "LEFT"],
  ];
  for (const [n, name] of names) if (dot(n, d) > 1 - 1e-9) return `${name} VIEW`;
  return "ISO VIEW";
}

/** The base view a view is (eventually) projected from. */
export function rootOf(v: SheetView, views: readonly SheetView[]): SheetView {
  let cur = v;
  for (let guard = 0; cur.parent !== undefined && guard < 100; guard++) {
    const p = views.find((x) => x.id === cur.parent);
    if (p === undefined) break;
    cur = p;
  }
  return cur;
}

const AUTO_LABEL = /^(FRONT|BACK|TOP|BOTTOM|LEFT|RIGHT|ISO) VIEW$/;

/** Re-derives every projected view from its parent and where it sits on
 *  the paper (after the base view was re-oriented, or the sheet switched
 *  1st / 3rd angle): same places, the views that belong there. */
export function reproject(views: readonly SheetView[], projection: Projection): SheetView[] {
  const byId = new Map(views.map((v) => [v.id, v]));
  const done = new Map<string, SheetView>();
  const resolve = (v: SheetView, depth = 0): SheetView => {
    const have = done.get(v.id);
    if (have !== undefined) return have;
    const raw = v.parent === undefined ? undefined : byId.get(v.parent);
    let out: SheetView;
    if (raw === undefined || depth > 100) out = { ...v, parent: undefined };
    else {
      const p = resolve(raw, depth + 1);
      let axes: { dir: Vec3; up: Vec3 };
      if (v.free === true) axes = isoAxes(p, v.x >= p.x ? 1 : -1, v.y >= p.y ? 1 : -1);
      else if (Math.abs(v.y - p.y) < 1e-6) axes = projectedAxes(p, v.x >= p.x ? "right" : "left", projection);
      else axes = projectedAxes(p, v.y >= p.y ? "up" : "down", projection);
      out = { ...v, ...axes };
    }
    done.set(v.id, out);
    return out;
  };
  const next = views.map((v) => resolve(v));
  // Auto labels follow; a label the user typed stays.
  return next.map((v) => {
    if (!AUTO_LABEL.test(v.label)) return v;
    return { ...v, label: v.parent === undefined ? "FRONT VIEW" : relativeName(v, rootOf(v, next)) };
  });
}

/** Name of a standard orientation matching these axes, if any. */
export function orientationName(v: Pick<SheetView, "dir" | "up">): string {
  for (const o of Object.values(ORIENTATIONS)) {
    if (dot(normalize(o.dir), normalize(v.dir)) > 1 - 1e-9 && dot(normalize(o.up), normalize(v.up)) > 1 - 1e-9) return o.label;
  }
  return "View";
}

export function formatScale(s: number): string {
  if (s >= 1) return `${+s.toFixed(3)}:1`;
  return `1:${+(1 / s).toFixed(3)}`;
}

export function parseScale(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 0 && b > 0 ? a / b : null;
  }
  const n = Number(text);
  return n > 0 && Number.isFinite(n) ? n : null;
}

export const STANDARD_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50];

/** A standard scale at which three views of the part fit the sheet. */
export function suggestScale(bodies: readonly Body[], paper: Paper): number {
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of bodies) {
    const p = b.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      min = { x: Math.min(min.x, p[i]!), y: Math.min(min.y, p[i + 1]!), z: Math.min(min.z, p[i + 2]!) };
      max = { x: Math.max(max.x, p[i]!), y: Math.max(max.y, p[i + 1]!), z: Math.max(max.z, p[i + 2]!) };
    }
  }
  if (!Number.isFinite(min.x)) return 1;
  const w = max.x - min.x;
  const d = max.y - min.y;
  const h = max.z - min.z;
  const { w: pw, h: ph } = PAPER_SIZE[paper];
  // Front + side across, front + top down; room for the title block.
  const usableW = pw - 20 - 30;
  const usableH = ph - 20 - 32 - 30;
  for (const s of STANDARD_SCALES) if ((w + d) * s <= usableW && (h + d) * s <= usableH) return s;
  return STANDARD_SCALES[STANDARD_SCALES.length - 1]!;
}

// ---------------------------------------------------------------------------
// Graphics

export type Pen = "visible" | "hidden" | "center" | "border" | "frame" | "thin";

/** Line weights (mm) and dash patterns (mm) per pen, after ISO 128. */
export const PENS: Record<Pen, { w: number; dash: number[] }> = {
  visible: { w: 0.5, dash: [] },
  hidden: { w: 0.25, dash: [3, 1.5] },
  center: { w: 0.18, dash: [8, 1.5, 1, 1.5] },
  border: { w: 0.7, dash: [] },
  frame: { w: 0.35, dash: [] },
  thin: { w: 0.25, dash: [] },
};

export type Prim =
  | { kind: "line"; a: Point; b: Point; pen: Pen }
  | { kind: "arc"; center: Point; r: number; start: number; end: number; pen: Pen } // world (Y-down) angles, increasing
  | { kind: "poly"; pts: Point[]; pen: Pen }
  | { kind: "text"; at: Point; text: string; h: number; align: "left" | "center"; bold?: boolean }
  /** A shaded view's face patch (outline + holes, even-odd); `shade` 0 (dark) .. 1 (lit). */
  | { kind: "shade"; loops: Point[][]; shade: number };

export interface SheetGraphics {
  prims: Prim[];
  /** Snappable copies of the view geometry, for dimensioning. */
  snap: Entity[];
  /** Each view's extent (world, Y-down) and scale, for picking. */
  views: { id: string; box: Bounds; scale: number }[];
}

/** A shaded view's faces: front-facing triangles in view 2D (model units),
 *  far to near, each with its shade. */
export type ShadedPatch = { loops: Point[][]; shade: number };

/** Caches each orientation's hidden-line result (and shading) for one set
 *  of bodies. */
export class ViewCache {
  private bodies: readonly Body[] | null = null;
  private map = new Map<string, ViewResult>();
  private shadeMap = new Map<string, ShadedPatch[]>();
  private sync(bodies: readonly Body[]): void {
    if (bodies === this.bodies) return;
    this.bodies = bodies;
    this.map.clear();
    this.shadeMap.clear();
  }
  private key(axes: ViewAxes): string {
    const r = (v: Vec3): string => [v.x, v.y, v.z].map((n) => n.toFixed(9)).join(",");
    return `${r(axes.dir)}|${r(axes.up)}`;
  }
  get(bodies: readonly Body[], axes: ViewAxes): ViewResult {
    this.sync(bodies);
    const key = this.key(axes);
    let res = this.map.get(key);
    if (res === undefined) {
      res = viewBodies(bodies, axes);
      this.map.set(key, res);
    }
    return res;
  }
  shaded(bodies: readonly Body[], axes: ViewAxes): ShadedPatch[] {
    this.sync(bodies);
    const key = this.key(axes);
    let res = this.shadeMap.get(key);
    if (res === undefined) {
      res = shadeBodies(bodies, axes);
      this.shadeMap.set(key, res);
    }
    return res;
  }
}

/** Painter's-algorithm shading, lit from the viewer's upper left. Each
 *  flat patch facing the viewer (a cap, one facet strip of a cylinder...)
 *  is ONE outline (holes cut out, even-odd), not its triangles: a fraction
 *  of the size in a PDF, and no seams inside a face. Far to near. */
export function shadeBodies(bodies: readonly Body[], axes: ViewAxes): ShadedPatch[] {
  const light = normalize({
    x: axes.dir.x * 0.8 + axes.up.x * 0.5 - axes.right.x * 0.35,
    y: axes.dir.y * 0.8 + axes.up.y * 0.5 - axes.right.y * 0.35,
    z: axes.dir.z * 0.8 + axes.up.z * 0.5 - axes.right.z * 0.35,
  });
  const out: (ShadedPatch & { z: number })[] = [];
  const P = (q: Vec3): Point => ({ x: dot(q, axes.right), y: dot(q, axes.up) });
  for (const body of bodies) {
    const { positions: p, indices, faceIds } = body.mesh;
    let size = 1;
    for (const v of p) size = Math.max(size, Math.abs(v));
    const q = size * 1e-7;
    const at = (i: number): Vec3 => ({ x: p[i * 3]!, y: p[i * 3 + 1]!, z: p[i * 3 + 2]! });
    const vkey = (v: Vec3): string => `${Math.round(v.x / q)},${Math.round(v.y / q)},${Math.round(v.z / q)}`;
    // Group front-facing triangles by face + plane.
    // Patches = per face, the triangles lying in one plane. Membership is by
    // the corners lying on the plane (not by each triangle's own normal):
    // the slivers booleans leave have no reliable normal, but they must
    // join their patch or its outline won't close.
    type Patch = { u: Vec3; d: number; tris: Vec3[][] };
    const byFace = new Map<number, Patch[]>();
    const slivers: { fid: number; tri: Vec3[] }[] = [];
    const tolD = size * 1e-6;
    const on = (pl: Patch, tri: Vec3[]): boolean => tri.every((v) => Math.abs(dot(pl.u, v) - pl.d) <= tolD);
    for (let t = 0; t < indices.length; t += 3) {
      const a = at(indices[t]!);
      const b = at(indices[t + 1]!);
      const c = at(indices[t + 2]!);
      const tri = [a, b, c];
      const fid = faceIds[t / 3]!;
      const list = byFace.get(fid) ?? [];
      byFace.set(fid, list);
      const found = list.find((pl) => on(pl, tri));
      if (found !== undefined) {
        found.tris.push(tri);
        continue;
      }
      const n = cross({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z });
      const ln = Math.hypot(n.x, n.y, n.z);
      if (ln <= size * size * 1e-10) {
        slivers.push({ fid, tri });
        continue;
      }
      const u = { x: n.x / ln, y: n.y / ln, z: n.z / ln };
      list.push({ u, d: dot(u, a), tris: [tri] });
    }
    for (const { fid, tri } of slivers) byFace.get(fid)?.find((pl) => on(pl, tri))?.tris.push(tri);
    const groups = [...byFace.values()].flat().filter((pl) => dot(pl.u, axes.dir) > 1e-9); // facing the viewer
    for (const { tris, u } of groups) {
      const shade = 0.2 + 0.8 * Math.max(0, dot(u, light));
      let z = 0;
      let w = 0;
      for (const [a, b, c] of tris) {
        const area = Math.hypot(...Object.values(cross({ x: b!.x - a!.x, y: b!.y - a!.y, z: b!.z - a!.z }, { x: c!.x - a!.x, y: c!.y - a!.y, z: c!.z - a!.z })));
        z += ((dot(a!, axes.dir) + dot(b!, axes.dir) + dot(c!, axes.dir)) / 3) * area;
        w += area;
      }
      const loops = outlineLoops(tris, vkey);
      const pieces = loops === null ? tris.map((t) => [t.map(P)]) : [loops.map((l) => l.map(P))];
      for (const pl of pieces) out.push({ loops: pl, shade, z: w > 0 ? z / w : 0 });
    }
  }
  out.sort((x, y) => x.z - y.z);
  return out.map(({ loops, shade }) => ({ loops, shade }));
}

/** Boundary loops of a set of triangles: the directed edges not shared
 *  back, chained into closed loops. Where an outline touches itself (a
 *  patch pinched at a point) any way of chaining the edges is right for an
 *  even-odd fill -- the same edges, the same area. Null if the edges don't
 *  close up (every point must have as many edges out as in). */
function outlineLoops(tris: Vec3[][], key: (v: Vec3) => string): Vec3[][] | null {
  const directed = new Map<string, number>();
  const edge = (p: string, q: string): string => `${p}|${q}`;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const e = edge(key(t[k]!), key(t[(k + 1) % 3]!));
      directed.set(e, (directed.get(e) ?? 0) + 1);
    }
  }
  const out = new Map<string, Vec3[]>();
  const pos = new Map<string, Vec3>();
  const balance = new Map<string, number>();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = t[k]!;
      const b = t[(k + 1) % 3]!;
      const ka = key(a);
      const kb = key(b);
      if (ka === kb || directed.has(edge(kb, ka))) continue;
      pos.set(ka, a);
      pos.set(kb, b);
      const l = out.get(ka);
      if (l === undefined) out.set(ka, [b]);
      else l.push(b);
      balance.set(ka, (balance.get(ka) ?? 0) + 1);
      balance.set(kb, (balance.get(kb) ?? 0) - 1);
    }
  }
  for (const v of balance.values()) if (v !== 0) return null;
  const loops: Vec3[][] = [];
  for (const start of [...out.keys()]) {
    for (;;) {
      const first = out.get(start);
      if (first === undefined || first.length === 0) break;
      const loop: Vec3[] = [pos.get(start)!];
      let k = start;
      for (let guard = 0; guard < 1e6; guard++) {
        const l = out.get(k);
        const nv = l?.pop();
        if (nv === undefined) return null;
        k = key(nv);
        if (k === start) break;
        loop.push(nv);
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

const MARGIN = 10;
export const TITLE_W = 180;
export const TITLE_H = 32;
/** Centre lines / marks run this far (paper mm) past the feature. */
const CENTER_OVERRUN = 3;

/** The view's 2D extent in model units (lines and centre lines). */
function extentOf(res: ViewResult): { min: Point; max: Point } | null {
  let min = { x: Infinity, y: Infinity };
  let max = { x: -Infinity, y: -Infinity };
  const add = (p: Point): void => {
    min = { x: Math.min(min.x, p.x), y: Math.min(min.y, p.y) };
    max = { x: Math.max(max.x, p.x), y: Math.max(max.y, p.y) };
  };
  for (const l of res.lines) {
    const c = l.curve;
    if (c.kind === "line") {
      add(c.a);
      add(c.b);
    } else if (c.kind === "polyline") c.pts.forEach(add);
    else {
      // Arc: its ends plus any quadrant point it sweeps through.
      add({ x: c.center.x + c.r * Math.cos(c.a0), y: c.center.y + c.r * Math.sin(c.a0) });
      add({ x: c.center.x + c.r * Math.cos(c.a1), y: c.center.y + c.r * Math.sin(c.a1) });
      for (let q = Math.ceil(c.a0 / (Math.PI / 2)); q * (Math.PI / 2) <= c.a1; q++) {
        add({ x: c.center.x + c.r * Math.cos(q * (Math.PI / 2)), y: c.center.y + c.r * Math.sin(q * (Math.PI / 2)) });
      }
    }
  }
  return Number.isFinite(min.x) ? { min, max } : null;
}

/** Where a view's model-space 2D point lands in world coords. */
export interface ViewPlacement {
  toWorld(p: Point): Point;
  box: Bounds;
}

export function placeView(res: ViewResult, view: Pick<SheetView, "scale" | "x" | "y">): ViewPlacement | null {
  const ext = extentOf(res);
  if (ext === null) return null;
  const cx = (ext.min.x + ext.max.x) / 2;
  const cy = (ext.min.y + ext.max.y) / 2;
  const s = view.scale;
  const toWorld = (p: Point): Point => ({ x: view.x + (p.x - cx) * s, y: -(view.y + (p.y - cy) * s) });
  const a = toWorld(ext.min);
  const b = toWorld(ext.max);
  return { toWorld, box: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)] };
}

function viewPrims(res: ViewResult, view: SheetView, at: ViewPlacement, prims: Prim[], snap: Entity[], shaded: ShadedPatch[] | null): void {
  const s = view.scale;
  const T = at.toWorld;
  if (shaded !== null) for (const t of shaded) prims.push({ kind: "shade", loops: t.loops.map((l) => l.map(T)), shade: t.shade });
  const emit = (c: ViewCurve, pen: Pen): void => {
    if (c.kind === "line") {
      const a = T(c.a);
      const b = T(c.b);
      prims.push({ kind: "line", a, b, pen });
      snap.push(new Line(a, b));
    } else if (c.kind === "polyline") {
      const pts = c.pts.map(T);
      prims.push({ kind: "poly", pts, pen });
      snap.push(new Polyline(pts.map((point) => ({ point, bulge: 0 })), false));
    } else {
      const center = T(c.center);
      const r = c.r * s;
      // Y flips: a CCW sweep a0..a1 (Y up) is -a1..-a0 increasing (Y down).
      prims.push({ kind: "arc", center, r, start: -c.a1, end: -c.a0, pen });
      snap.push(c.a1 - c.a0 >= Math.PI * 2 - 1e-9 ? new Circle(center, r) : new Arc(center, r, -c.a1, -c.a0));
    }
  };
  for (const l of res.lines) {
    if (l.hidden && (!view.hiddenLines || view.style === "shaded")) continue;
    emit(l.curve, l.hidden ? "hidden" : "visible");
  }
  for (const cl of res.centerLines) {
    const a = T(cl.a);
    const b = T(cl.b);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const p = { x: a.x - ux * CENTER_OVERRUN, y: a.y - uy * CENTER_OVERRUN };
    const q = { x: b.x + ux * CENTER_OVERRUN, y: b.y + uy * CENTER_OVERRUN };
    prims.push({ kind: "line", a: p, b: q, pen: "center" });
    snap.push(new Line(p, q));
  }
  for (const m of res.centerMarks) {
    const c = T(m.center);
    const arm = m.r * s + CENTER_OVERRUN;
    prims.push({ kind: "line", a: { x: c.x - arm, y: c.y }, b: { x: c.x + arm, y: c.y }, pen: "center" });
    prims.push({ kind: "line", a: { x: c.x, y: c.y - arm }, b: { x: c.x, y: c.y + arm }, pen: "center" });
  }
}

/** Border + title block (world coords). */
function framePrims(sheet: SheetData, prims: Prim[]): void {
  const { w, h } = PAPER_SIZE[sheet.paper];
  const W = (x: number, y: number): Point => ({ x, y: -y });
  const rect = (x0: number, y0: number, x1: number, y1: number, pen: Pen): void => {
    prims.push({ kind: "poly", pts: [W(x0, y0), W(x1, y0), W(x1, y1), W(x0, y1), W(x0, y0)], pen });
  };
  rect(MARGIN, MARGIN, w - MARGIN, h - MARGIN, "border");

  // Title block, bottom right: two bands.
  const x0 = w - MARGIN - TITLE_W;
  const y0 = MARGIN;
  const yMid = y0 + 12;
  const y1 = y0 + TITLE_H;
  rect(x0, y0, w - MARGIN, y1, "frame");
  prims.push({ kind: "line", a: W(x0, yMid), b: W(w - MARGIN, yMid), pen: "frame" });

  const t = sheet.title;
  const baseScale = sheet.views.find((v) => v.parent === undefined)?.scale;
  const cell = (cx0: number, cy0: number, cw: number, ch: number, label: string, value: string, vh: number, divider = true): void => {
    if (divider && cx0 > x0) prims.push({ kind: "line", a: W(cx0, cy0), b: W(cx0, cy0 + ch), pen: "thin" });
    prims.push({ kind: "text", at: W(cx0 + 1.2, cy0 + ch - 2.6), text: label, h: 1.8, align: "left" });
    if (value !== "") prims.push({ kind: "text", at: W(cx0 + cw / 2, cy0 + (ch - 2.4) / 2 - vh * 0.35), text: value, h: vh, align: "center" });
  };
  // Top band: company | title | drawing no.
  cell(x0, yMid, 55, 20, "COMPANY", t.company, 4);
  cell(x0 + 55, yMid, 90, 20, "TITLE", t.title, 5);
  cell(x0 + 145, yMid, 35, 20, "DRAWING NO.", t.drawingNo, 3.5);
  // Bottom band: drawn | date | material | scale | projection | rev | sheet.
  let x = x0;
  const cols: [number, string, string][] = [
    [30, "DRAWN", t.drawnBy],
    [25, "DATE", t.date],
    [45, "MATERIAL", t.material],
    [20, "SCALE", baseScale === undefined ? "" : formatScale(baseScale)],
    [25, sheet.projection === "first" ? "1ST ANGLE" : "3RD ANGLE", ""],
    [15, "REV", t.revision],
    [20, "SHEET", "1 / 1"],
  ];
  for (const [cw, label, value] of cols) {
    cell(x, y0, cw, 12, label, value, 3);
    if (label.endsWith("ANGLE")) projectionSymbol({ x: x + cw / 2, y: y0 + 4.8 }, sheet.projection, prims, W);
    x += cw;
  }
}

/** ISO projection symbol: a truncated cone's side view + its end view.
 *  First angle: the small end points AWAY from the circles; third: towards. */
function projectionSymbol(c: Point, projection: Projection, prims: Prim[], W: (x: number, y: number) => Point): void {
  const R = 2.8;
  const r = 1.5;
  const len = 5.2;
  const gap = 2.2;
  const cone = { x: c.x - gap / 2 - len / 2, y: c.y };
  const circ = { x: c.x + gap / 2 + R, y: c.y };
  const bigLeft = projection === "third"; // third: big end away from the circles (left), small end towards them
  const xl = cone.x - len / 2;
  const xr = cone.x + len / 2;
  const [hl, hr] = bigLeft ? [R, r] : [r, R];
  prims.push({ kind: "poly", pts: [W(xl, c.y - hl), W(xr, c.y - hr), W(xr, c.y + hr), W(xl, c.y + hl), W(xl, c.y - hl)], pen: "thin" });
  const wc = W(circ.x, circ.y);
  prims.push({ kind: "arc", center: wc, r: R, start: 0, end: Math.PI * 2, pen: "thin" });
  prims.push({ kind: "arc", center: wc, r, start: 0, end: Math.PI * 2, pen: "thin" });
  prims.push({ kind: "line", a: W(xl - 1, c.y), b: W(circ.x + R + 1, c.y), pen: "center" });
}

export function sheetGraphics(sheet: SheetData, bodies: readonly Body[], cache: ViewCache): SheetGraphics {
  const prims: Prim[] = [];
  const snap: Entity[] = [];
  const views: SheetGraphics["views"] = [];
  framePrims(sheet, prims);
  for (const view of sheet.views) {
    const res = cache.get(bodies, axesOf(view));
    const at = placeView(res, view);
    if (at === null) continue;
    viewPrims(res, view, at, prims, snap, view.style === "shaded" ? cache.shaded(bodies, axesOf(view)) : null);
    views.push({ id: view.id, box: at.box, scale: view.scale });
    const [bx0, , bx1, by1] = at.box;
    prims.push({ kind: "text", at: { x: (bx0 + bx1) / 2, y: by1 + 6 }, text: view.label, h: 2.5, align: "center" });
  }
  return { prims, snap, views };
}

// ---------------------------------------------------------------------------
// Painting (screen and PDF)

export interface PaintStyle {
  /** Screen: fill the paper and use light ink on it; print: ink only. */
  paper: string | null;
  ink: string;
  /** Minimum drawn width (screen px) so thin pens stay visible zoomed out. */
  minWidth: number;
  /** Fill colour of a shaded view's face at shade 0..1. */
  shade(s: number): string;
}

/** Shaded faces: a cool light grey, darker away from the light. */
export function shadeColor(base: [number, number, number], s: number): string {
  const k = 0.45 + 0.55 * s;
  const [r, g, b] = base.map((v) => Math.round(v * k)) as [number, number, number];
  return `rgb(${r}, ${g}, ${b})`;
}

export function paintSheet(
  ctx: CanvasRenderingContext2D,
  viewport: { zoom: number; worldToScreen(p: Point): Point },
  sheet: SheetData,
  g: SheetGraphics,
  style: PaintStyle,
): void {
  const z = viewport.zoom;
  const S = (p: Point): Point => viewport.worldToScreen(p);
  ctx.save();
  if (style.paper !== null) {
    const { w, h } = PAPER_SIZE[sheet.paper];
    const a = S({ x: 0, y: -h });
    ctx.fillStyle = style.paper;
    ctx.fillRect(a.x, a.y, w * z, h * z);
  }
  ctx.strokeStyle = style.ink;
  ctx.fillStyle = style.ink;
  let lastPen: Pen | null = null;
  const pen = (p: Pen): void => {
    if (p === lastPen) return;
    lastPen = p;
    ctx.lineWidth = Math.max(style.minWidth, PENS[p].w * z);
    ctx.setLineDash(PENS[p].dash.map((d) => d * z));
  };
  for (const p of g.prims) {
    if (p.kind === "shade") {
      // Fill + a hairline stroke of the same colour: no seams between patches.
      const c = style.shade(p.shade);
      ctx.fillStyle = c;
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(0.5, 0.05 * z);
      ctx.setLineDash([]);
      lastPen = null;
      ctx.beginPath();
      for (const loop of p.loops) {
        loop.forEach((q, i) => {
          const s = S(q);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      }
      const both = (ctx as unknown as { fillStrokeEvenOdd?: () => void }).fillStrokeEvenOdd;
      if (both !== undefined) both.call(ctx); // PDF: one path, one operator
      else {
        ctx.fill("evenodd");
        ctx.stroke();
      }
      ctx.strokeStyle = style.ink;
      ctx.fillStyle = style.ink;
      continue;
    }
    if (p.kind === "text") {
      ctx.font = `${p.bold === true ? "bold " : ""}${p.h * z}px sans-serif`;
      ctx.textAlign = p.align;
      ctx.textBaseline = "alphabetic";
      const s = S(p.at);
      ctx.fillText(p.text, s.x, s.y);
      continue;
    }
    pen(p.pen);
    ctx.beginPath();
    if (p.kind === "line") {
      const a = S(p.a);
      const b = S(p.b);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    } else if (p.kind === "poly") {
      p.pts.forEach((q, i) => {
        const s = S(q);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
    } else {
      const c = S(p.center);
      ctx.arc(c.x, c.y, p.r * z, p.start, p.end);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/** Which view (if any) a world point is on -- its box, slightly padded. */
export function viewAt(g: SheetGraphics, p: Point, pad = 2): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const v of g.views) {
    const [x0, y0, x1, y1] = v.box;
    if (p.x < x0 - pad || p.x > x1 + pad || p.y < y0 - pad || p.y > y1 + pad) continue;
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      bestArea = area;
      best = v.id;
    }
  }
  return best;
}

