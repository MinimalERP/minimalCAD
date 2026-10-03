/**
 * MinimalCAD Web
 * part/sheetMetal.ts
 *
 * Simple sheet metal. The sketch is the FLAT PATTERN (the blank as cut);
 * straight lines across it are bend lines. Each bend folds one side Up or
 * Down by an angle. Material sets everything else: thickness T, inner bend
 * radius R, K-factor (DIN 6935), so the bend allowance
 *
 *     BA = angle * (R + K*T)
 *
 * -- the strip of blank, centred on the bend line, that the bend consumes.
 *
 * Built on our own solid kernel, all in the sketch's flat coordinates
 * (x, y in the plane, z = 0..T up its normal):
 *   blank slab -> for each bend: cut the piece it lies in into base side
 *   (x <= -BA/2), bend zone (an exact annular sector, inner R) and fold
 *   side (x >= +BA/2); the fold side is moved by  Rot(axis, angle) after
 *   Translate(-BA)  -- composed with its parent's move, so bends inside a
 *   flange fold with it. Pieces are then moved into place and joined.
 *
 * Every piece's faces get refs of their own ("b:", "f1:", "z1:" ...), so
 * holes, sketches and fillets placed on a flange find it again after edits.
 */

import type { Point } from "../core/types";
import type { Body } from "./kernel/types";
import { extrudeRegions } from "./kernel/extrude";
import { revolveRegions } from "./kernel/revolveRegion";
import { subtract, union } from "./kernel/csg";
import { bodyToPolygons, polygonsToBody } from "./kernel/brep";
import type { Frame } from "./plane";
import type { Region } from "./profile";
import { regionContains, regionFromSegments } from "./profile";
import type { Transform } from "./pattern";
import { rotation, transformBody, translation } from "./pattern";
import type { Vec3 } from "./vec3";
import { add, cross, dot, normalize, scale, sub } from "./vec3";

export interface SheetMaterial {
  key: string;
  name: string;
  /** g/cm^3 */
  density: number;
  /** Default inner bend radius, as a multiple of the thickness. */
  radiusFactor: number;
}

export const SHEET_MATERIALS: SheetMaterial[] = [
  { key: "crca", name: "Mild steel (CRCA)", density: 7.85, radiusFactor: 1 },
  { key: "gi", name: "Galvanised (GI)", density: 7.85, radiusFactor: 1 },
  { key: "ss304", name: "Stainless 304", density: 8.0, radiusFactor: 1.5 },
  { key: "al5052", name: "Aluminium 5052", density: 2.68, radiusFactor: 1 },
];

export function sheetMaterial(key: string): SheetMaterial {
  return SHEET_MATERIALS.find((m) => m.key === key) ?? SHEET_MATERIALS[0]!;
}

/** K-factor (neutral fibre position / T) from DIN 6935: k = 0.65 + 0.5 log10(R/T), at most 1; K = k/2. */
export function kFactor(radius: number, thickness: number): number {
  const ratio = radius / thickness;
  if (!(ratio > 0)) return 0.325;
  return Math.max(0.2, Math.min(1, 0.65 + 0.5 * Math.log10(ratio))) / 2;
}

/** Length of flat blank a bend of `angleDeg` uses up. */
export function bendAllowance(angleDeg: number, radius: number, thickness: number, k: number): number {
  return ((angleDeg * Math.PI) / 180) * (radius + k * thickness);
}

/** One bend, in plane-local coordinates. */
export interface SheetBend {
  a: Point;
  b: Point;
  /** +1: the side to the LEFT of a->b folds; -1: the right side. */
  side: 1 | -1;
  dir: "up" | "down";
  angle: number;
}

export interface SheetSpec {
  id: string;
  thickness: number;
  radius: number;
  k: number;
  /** Show it unfolded (the flat pattern). */
  flat: boolean;
}

/** A half-plane in flat (plane-local) coordinates: dot(p - o, n) >= 0. */
interface HalfPlane {
  o: Point;
  n: Point;
}

interface Piece {
  body: Body;
  tag: string;
  move: Transform;
  /** Where this piece is in the flat blank (besides being inside it). */
  keep: HalfPlane[];
}

const IDENTITY: Transform = { point: (p) => p, dir: (v) => v, mirror: false };
const compose = (outer: Transform, inner: Transform): Transform => ({
  point: (p) => outer.point(inner.point(p)),
  dir: (v) => outer.dir(inner.dir(v)),
  mirror: false,
});

const sub2 = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot2 = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;

/** Regions' bounding size (for "big enough" cutting boxes). */
function extentOf(regions: readonly Region[]): number {
  let m = 1;
  for (const r of regions) for (const p of r.outer.polygon) m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
  return m;
}

/** A box covering the half-plane dot(p - o, n) >= 0 (to `size`), through every z. */
function halfSpaceBox(id: string, frame: Frame, o: Point, n: Point, size: number): Body {
  const t = { x: -n.y, y: n.x };
  const c = (s: number, w: number): Point => ({ x: o.x + n.x * s + t.x * w, y: o.y + n.y * s + t.y * w });
  const pts = [c(0, -size), c(size, -size), c(size, size), c(0, size)];
  const region = regionFromSegments(pts.map((p, i) => ({ kind: "line" as const, a: p, b: pts[(i + 1) % 4]! })));
  return extrudeRegions(id, [region], frame, -size, size);
}

/** `body` minus `tool`, or null if nothing is left. */
function cut(body: Body, tool: Body): Body | null {
  const polys = subtract(bodyToPolygons(body, 0), bodyToPolygons(tool, body.faces.length));
  if (polys.length === 0) return null;
  const out = polygonsToBody(body.id, body.feature, polys, [...body.faces, ...tool.faces]);
  return out.mesh.indices.length === 0 ? null : out;
}

/** Joins bodies into one (they touch along the bend zones). */
function joinAll(bodies: readonly Body[]): Body {
  let faces = [...bodies[0]!.faces];
  let polys = bodyToPolygons(bodies[0]!, 0);
  for (const b of bodies.slice(1)) {
    const offset = faces.length;
    faces = [...faces, ...b.faces];
    polys = union(polys, bodyToPolygons(b, offset));
  }
  return polygonsToBody(bodies[0]!.id, bodies[0]!.feature, polys, faces);
}

/**
 * The folded (or flat) part from the blank `regions` (plane-local, holes
 * included) on `frame`, or why it can't be made.
 */
export function sheetBody(spec: SheetSpec, regions: readonly Region[], frame: Frame, bends: readonly SheetBend[]): Body | string {
  const { id, thickness: T, radius: R, k } = spec;
  if (!(T > 0)) return "Thickness must be more than 0";
  if (!(R >= 0)) return "Bend radius can't be negative";
  if (regions.length === 0) return "No closed blank shape in the sketch";
  const size = extentOf(regions) * 4 + 10 * (T + R) + 10;
  const blank = extrudeRegions(id, regions, frame, 0, T);
  if (spec.flat) return transformBody(blank, IDENTITY, id, id, "flat");

  const to3 = (p: Point, z = 0): Vec3 => add(add(add(frame.origin, scale(frame.u, p.x)), scale(frame.v, p.y)), scale(frame.n, z));
  const inside = (p: Point, keep: readonly HalfPlane[], margin: number): boolean => keep.every((h) => dot2(sub2(p, h.o), h.n) >= margin);
  const inBlank = (p: Point): boolean => regions.some((r) => regionContains(r, p));

  let pieces: Piece[] = [{ body: blank, tag: "b", move: IDENTITY, keep: [] }];
  const zones: { body: Body; move: Transform; tag: string }[] = [];

  for (let i = 0; i < bends.length; i++) {
    const bend = bends[i]!;
    const n = i + 1;
    if (!(bend.angle > 0) || bend.angle > 180) return `Bend ${n}: angle must be more than 0, up to 180`;
    const len = Math.hypot(bend.b.x - bend.a.x, bend.b.y - bend.a.y);
    if (!(len > 0)) return `Bend ${n}: the bend line has no length`;
    const d = { x: (bend.b.x - bend.a.x) / len, y: (bend.b.y - bend.a.y) / len };
    // Fold side: left of a->b (+1) or right (-1).
    const f = { x: -d.y * bend.side, y: d.x * bend.side };
    const mid = { x: (bend.a.x + bend.b.x) / 2, y: (bend.a.y + bend.b.y) / 2 };
    if (!inBlank(mid)) return `Bend ${n}: the bend line isn't across the blank`;
    const ba = bendAllowance(bend.angle, R, T, k);
    const half = ba / 2;

    const host = pieces.find((p) => inside(mid, p.keep, half));
    if (host === undefined) return `Bend ${n}: too close to another bend (or crosses it)`;

    // Base side: x <= -half; fold side: x >= +half (x along f from the bend line).
    const at = (s: number): Point => ({ x: mid.x + f.x * s, y: mid.y + f.y * s });
    const base = cut(host.body, halfSpaceBox(`${id}~${n}a`, frame, at(-half), f, size));
    const fold = cut(host.body, halfSpaceBox(`${id}~${n}b`, frame, at(half), { x: -f.x, y: -f.y }, size));
    if (base === null || fold === null) return `Bend ${n}: a flange is too short to bend (needs more than ${+half.toFixed(2)} mm past the line)`;

    // The bend zone and the fold's move, in this piece's flat coordinates.
    const f3 = normalize(add(scale(frame.u, f.x), scale(frame.v, f.y)));
    const up = bend.dir === "up";
    const axisPoint = to3(at(-half), up ? T + R : -R);
    const k3 = up ? cross(f3, frame.n) : cross(frame.n, f3);
    const theta = (bend.angle * Math.PI) / 180;
    const foldMove = compose(rotation(axisPoint, k3, theta), translation(scale(f3, -ba)));

    // Zone: the cross-section (along the axis over the bend line, radially R..R+T) turned by the angle.
    const radial0 = up ? scale(frame.n, -1) : frame.n;
    const zf: Frame = { origin: axisPoint, u: k3, v: radial0, n: cross(k3, radial0) };
    const s0 = dot(sub(to3(bend.a), axisPoint), k3);
    const s1 = dot(sub(to3(bend.b), axisPoint), k3);
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    const rect = [
      { x: lo, y: R },
      { x: hi, y: R },
      { x: hi, y: R + T },
      { x: lo, y: R + T },
    ];
    const zoneRegion = regionFromSegments(rect.map((p, j) => ({ kind: "line" as const, a: p, b: rect[(j + 1) % 4]! })));
    const zone = revolveRegions(`${id}~z${n}`, [zoneRegion], zf, { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }, 0, theta);
    if (typeof zone === "string") return `Bend ${n}: ${zone}`;
    zones.push({ body: zone, move: host.move, tag: `z${n}` });

    const without = pieces.filter((p) => p !== host);
    pieces = [
      ...without,
      { body: base, tag: host.tag, move: host.move, keep: [...host.keep, { o: at(-half), n: { x: -f.x, y: -f.y } }] },
      { body: fold, tag: `f${n}`, move: compose(host.move, foldMove), keep: [...host.keep, { o: at(half), n: f }] },
    ];
  }

  const placed = [
    ...pieces.map((p) => transformBody(p.body, p.move, `${id}.${p.tag}`, id, p.tag)),
    ...zones.map((z) => transformBody(z.body, z.move, `${id}.${z.tag}`, id, z.tag)),
  ];
  const joined = joinAll(placed);
  return { ...joined, id, feature: id };
}

/** Weight in kg of a body of `volume` mm^3. */
export function sheetWeightKg(volumeMm3: number, density: number): number {
  return (Math.abs(volumeMm3) / 1000) * density / 1000;
}

/** True if a point lies on the segment a-b (within tol). */
export function onSegment(p: Point, a: Point, b: Point, tol: number): boolean {
  const ab = sub2(b, a);
  const l2 = dot2(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / l2));
  return Math.hypot(p.x - (a.x + ab.x * t), p.y - (a.y + ab.y * t)) <= tol;
}

