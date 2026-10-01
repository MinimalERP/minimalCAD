/**
 * MinimalCAD Web
 * part/types.ts
 *
 * The parametric 3D part as it is stored in .jcad (Document.part) -- intent
 * only (sketches, feature history, parameters), never meshes: geometry is
 * always regenerated from this by part/rebuild.ts.
 *
 * A sketch's `entities`/`constraints` are exactly a 2D DocumentSnapshot, so
 * a sketch is edited by the ordinary 2D Engine with every existing command.
 */

import type { Point } from "../core/types";
import type { TopoRef } from "./kernel/types";

export const PART_SCHEMA = 1;

/** Sketch id features use to reference the tab's own 2D drafting drawing,
 *  which IS the part's XY base sketch (AutoCAD-style: what you draw in 2D
 *  lies on the XY plane of the 3D model). Its entities live in the
 *  Document's top-level `entities`, not in part.sketches. */
export const DRAWING_SKETCH = "Drawing";

/** A chosen profile: a point inside the region (sketch coordinates), plus
 *  the region's area when picked -- used to re-find the region if a 2D edit
 *  moved it off the point (see rebuild.ts's selectRegions). */
export interface ProfileSeed extends Point {
  area?: number;
}
export type BasePlane = "XY" | "XZ" | "YZ";

/** Where a sketch lives: an origin plane (XY/XZ/YZ), a work plane id, or
 *  -- base "face" -- a flat face of an earlier feature's solid. */
export interface PlaneRef {
  base: BasePlane | string;
  /** Extra distance along the plane's normal (0 for work planes, which carry their own). */
  offset: number;
  /** For base "face": which face, by stable topological reference. */
  face?: TopoRef;
}

export const FACE_PLANE = "face";

/** Inventor-style work plane: an origin plane, rotated by `angle` degrees
 *  about one of its own in-plane axes (u = its horizontal, v = its vertical,
 *  through the origin), then offset along the resulting normal. Values are
 *  expressions, so planes are parametric like every other feature. */
export interface WorkPlane {
  id: string;
  base: BasePlane;
  offset: string;
  angle: string;
  axis: "u" | "v";
}

export interface SketchData {
  id: string;
  plane: PlaneRef;
  entities: Record<string, unknown>[];
  constraints: unknown[];
}

export type ExtrudeDirection = "normal" | "reverse" | "symmetric";

/** New solid, merge into the solids it touches, or remove material. */
export type FeatureOperation = "new" | "join" | "cut";

/** A fixed distance, or all the way through the existing model. */
export type ExtrudeExtent = "distance" | "through";

export interface ExtrudeFeature {
  id: string;
  type: "extrude";
  sketch: string;
  /** "all" closed regions, or one seed point (sketch coordinates) per chosen
   *  region -- a point stays inside "its" region across sketch edits, unlike
   *  a region index, which reorders whenever loops are added or removed. */
  profiles: "all" | ProfileSeed[];
  /** Expression: a number or parameter arithmetic, e.g. "d1*2". */
  distance: string;
  direction: ExtrudeDirection;
  operation: FeatureOperation;
  /** Absent = "distance" (older files). */
  extent?: ExtrudeExtent;
  suppressed?: boolean;
}

/** What a Revolve turns about, in its sketch's own coordinates (Y-down, as
 *  stored): the sketch's horizontal ("u") or vertical ("v") axis through
 *  its origin, or a straight line of the sketch (kept as its two ends --
 *  rebuild.ts re-finds the line if a 2D edit moved it). */
export type RevolveAxis = { kind: "u" } | { kind: "v" } | { kind: "line"; a: Point; b: Point };

export interface RevolveFeature {
  id: string;
  type: "revolve";
  sketch: string;
  /** As ExtrudeFeature.profiles. */
  profiles: "all" | ProfileSeed[];
  axis: RevolveAxis;
  /** Absent = a full turn. */
  extent?: "angle";
  /** Expression, degrees (used when extent is "angle"). */
  angle: string;
  /** Which way a partial turn goes from the sketch plane. */
  direction: ExtrudeDirection;
  operation: FeatureOperation;
  suppressed?: boolean;
}

export type HoleStyle = "plain" | "counterbore" | "countersink";

/** What a hole centre is dimensioned from (all in face plane coordinates):
 *  - "edge": a straight edge of the face (stored as a segment);
 *  - "hole": an EARLIER centre of the same feature (by index) -- a chain,
 *    so moving that hole moves this one;
 *  - "point": a fixed point, e.g. the centre of a circle already on the face.
 *  From a point, the distance runs along the face's horizontal ("u") or
 *  vertical ("v") direction.
 *  On a round face (radial) the same kinds work in its (along-axis mm,
 *  angle deg) coordinates: an end-face rim is an "edge" x = const, an
 *  angle reference (a plane / flat / seam) an "edge" y = const, and "u" /
 *  "v" from a hole mean along the axis / around it. */
export type HoleRef =
  | { kind: "edge"; seg: [Point, Point] }
  | { kind: "hole"; index: number; axis: "u" | "v" }
  | { kind: "point"; p: Point; axis: "u" | "v" };

/** "`d` mm from `ref`", on side `side` (+1/-1 along the ref's normal). */
export interface HoleDim {
  ref: HoleRef;
  d: string;
  side: 1 | -1;
}

/** A hole centre in face coordinates. With `dims` (up to 2) it is
 *  parametric: x/y are then just the last solved position. */
export interface HoleCenter extends Point {
  dims?: HoleDim[];
}

/** A drilled hole (or several), Inventor-style: placed on a flat face, or
 *  (placement "radial") on a round face, aimed at its axis. */
export interface HoleFeature {
  id: string;
  type: "hole";
  /** The face it's drilled into. */
  face: TopoRef;
  /** Absent = on a flat face. "radial" = on a round face (cylFrame.ts). */
  placement?: "radial";
  /** Hole centres in face coordinates: on a flat face its plane coords
   *  (u right, v up); radial: x = mm along the axis, y = angle (deg). */
  centers: HoleCenter[];
  /** Expressions (mm). */
  diameter: string;
  depth: string;
  /** Absent = blind hole of `depth` with a 118 degree drill point.
   *  "toAxis" (radial only) = blind, down to the round face's axis. */
  extent?: "through" | "toAxis";
  style: HoleStyle;
  cbDiameter?: string;
  cbDepth?: string;
  csDiameter?: string;
  /** Included countersink angle, degrees (default 90). */
  csAngle?: string;
  suppressed?: boolean;
}

/** An edge, named the way that survives rebuilds: the two faces it runs
 *  between (stable face refs), and a point near it -- in case those two
 *  faces meet along more than one edge. */
export interface EdgeRef {
  faces: [TopoRef, TopoRef];
  at: { x: number; y: number; z: number };
}

export type ChamferMode = "equal" | "two" | "angle";

/** Fillet (round) or chamfer (bevel) on picked edges: straight edges
 *  between two flat faces, or circle rims where a round face meets a flat
 *  one. Outside edges lose material, inside edges gain it. */
export interface EdgeFeature {
  id: string;
  type: "fillet" | "chamfer";
  edges: EdgeRef[];
  /** Fillet radius / chamfer distance (mm expression). */
  size: string;
  /** Chamfer only: equal distances, two distances, or distance + angle. */
  mode?: ChamferMode;
  /** Chamfer "two": the distance on the second face. */
  size2?: string;
  /** Chamfer "angle": degrees from the first face. */
  angle?: string;
  suppressed?: boolean;
}

export type FeatureData = ExtrudeFeature | RevolveFeature | HoleFeature | EdgeFeature;

/** Features built from a sketch's closed shapes. */
export type SketchFeature = ExtrudeFeature | RevolveFeature;

export const usesSketch = (f: FeatureData): f is SketchFeature => f.type === "extrude" || f.type === "revolve";

export const isEdgeFeature = (f: FeatureData): f is EdgeFeature => f.type === "fillet" || f.type === "chamfer";

export const isExtrude = (f: FeatureData): f is ExtrudeFeature => f.type === "extrude";

export interface Parameter {
  name: string;
  expr: string;
}

export interface PartData {
  schema: number;
  units: "mm";
  parameters: Parameter[];
  planes: WorkPlane[];
  sketches: SketchData[];
  features: FeatureData[];
}

export function emptyPart(): PartData {
  return { schema: PART_SCHEMA, units: "mm", parameters: [], planes: [], sketches: [], features: [] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const BASES: readonly BasePlane[] = ["XY", "XZ", "YZ"];

function parseSketch(raw: unknown): SketchData | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const plane = isObject(raw.plane) ? raw.plane : {};
  const base = typeof plane.base === "string" && plane.base !== "" ? plane.base : "XY";
  const offset = typeof plane.offset === "number" && Number.isFinite(plane.offset) ? plane.offset : 0;
  const f = isObject(plane.face) ? plane.face : null;
  const face =
    f !== null && typeof f.feature === "string" && typeof f.index === "string" && typeof f.role === "string"
      ? { feature: f.feature, role: f.role as TopoRef["role"], index: f.index }
      : undefined;
  return {
    id: raw.id,
    plane: face !== undefined ? { base, offset, face } : { base, offset },
    entities: Array.isArray(raw.entities) ? (raw.entities as Record<string, unknown>[]) : [],
    constraints: Array.isArray(raw.constraints) ? raw.constraints : [],
  };
}

function parseSeed(raw: unknown): ProfileSeed | null {
  if (!isObject(raw) || typeof raw.x !== "number" || typeof raw.y !== "number") return null;
  return typeof raw.area === "number" ? { x: raw.x, y: raw.y, area: raw.area } : { x: raw.x, y: raw.y };
}

function parseSegment(raw: unknown): [Point, Point] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = parseSeed(raw[0]);
  const b = parseSeed(raw[1]);
  return a === null || b === null ? null : [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

function parseHoleRef(raw: unknown): HoleRef | null {
  if (!isObject(raw)) return null;
  const axis = raw.axis === "v" ? "v" : "u";
  if (raw.kind === "edge") {
    const seg = parseSegment(raw.seg);
    return seg === null ? null : { kind: "edge", seg };
  }
  if (raw.kind === "hole" && typeof raw.index === "number") return { kind: "hole", index: raw.index, axis };
  if (raw.kind === "point") {
    const p = parseSeed(raw.p);
    return p === null ? null : { kind: "point", p: { x: p.x, y: p.y }, axis };
  }
  return null;
}

function parseHoleCenter(raw: unknown): HoleCenter | null {
  const p = parseSeed(raw);
  if (p === null || !isObject(raw)) return null;
  const c: HoleCenter = { x: p.x, y: p.y };
  if (Array.isArray(raw.dims)) {
    const dims: HoleDim[] = [];
    for (const d of raw.dims.slice(0, 2)) {
      if (!isObject(d)) continue;
      const ref = parseHoleRef(d.ref);
      if (ref === null) continue;
      dims.push({ ref, d: typeof d.d === "number" ? String(d.d) : String(d.d ?? "0"), side: d.side === -1 ? -1 : 1 });
    }
    if (dims.length > 0) c.dims = dims;
  }
  return c;
}

function parseTopoRef(raw: unknown): TopoRef | null {
  if (!isObject(raw) || typeof raw.feature !== "string" || typeof raw.index !== "string") return null;
  if (raw.role !== "start" && raw.role !== "end" && raw.role !== "side") return null;
  return { feature: raw.feature, role: raw.role, index: raw.index };
}

function parseEdgeRef(raw: unknown): EdgeRef | null {
  if (!isObject(raw) || !Array.isArray(raw.faces) || !isObject(raw.at)) return null;
  const a = parseTopoRef(raw.faces[0]);
  const b = parseTopoRef(raw.faces[1]);
  const { x, y, z } = raw.at;
  if (a === null || b === null || typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  return { faces: [a, b], at: { x, y, z } };
}

function parseFeature(raw: unknown): FeatureData | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  if ((raw.type === "fillet" || raw.type === "chamfer") && Array.isArray(raw.edges)) {
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
    const f: EdgeFeature = {
      id: raw.id,
      type: raw.type,
      edges: raw.edges.map(parseEdgeRef).filter((e): e is EdgeRef => e !== null),
      size: str(raw.size) ?? "2",
      suppressed: raw.suppressed === true,
    };
    if (raw.type === "chamfer") {
      f.mode = raw.mode === "two" || raw.mode === "angle" ? raw.mode : "equal";
      const size2 = str(raw.size2);
      const angle = str(raw.angle);
      if (size2 !== undefined) f.size2 = size2;
      if (angle !== undefined) f.angle = angle;
    }
    return f;
  }
  if (raw.type === "hole" && isObject(raw.face)) {
    const f = raw.face;
    if (typeof f.feature !== "string" || typeof f.index !== "string" || typeof f.role !== "string") return null;
    const str = (v: unknown, dflt: string): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : dflt);
    const opt = (v: unknown): string | undefined => (v === undefined ? undefined : str(v, ""));
    const style: HoleStyle = raw.style === "counterbore" || raw.style === "countersink" ? raw.style : "plain";
    const hole: HoleFeature = {
      id: raw.id,
      type: "hole",
      face: { feature: f.feature, role: f.role as TopoRef["role"], index: f.index },
      centers: Array.isArray(raw.centers) ? raw.centers.map(parseHoleCenter).filter((p): p is HoleCenter => p !== null) : [],
      diameter: str(raw.diameter, "10"),
      depth: str(raw.depth, "10"),
      style,
      suppressed: raw.suppressed === true,
    };
    if (raw.extent === "through" || raw.extent === "toAxis") hole.extent = raw.extent;
    if (raw.placement === "radial") hole.placement = "radial";
    for (const key of ["cbDiameter", "cbDepth", "csDiameter", "csAngle"] as const) {
      const v = opt(raw[key]);
      if (v !== undefined) hole[key] = v;
    }
    return hole;
  }
  if (raw.type === "revolve" && typeof raw.sketch === "string") {
    const ax = isObject(raw.axis) ? raw.axis : {};
    const seg = ax.kind === "line" ? parseSegment([ax.a, ax.b]) : null;
    const axis: RevolveAxis = seg !== null ? { kind: "line", a: seg[0], b: seg[1] } : ax.kind === "v" ? { kind: "v" } : { kind: "u" };
    return {
      id: raw.id,
      type: "revolve",
      sketch: raw.sketch,
      profiles: Array.isArray(raw.profiles) ? raw.profiles.map(parseSeed).filter((p): p is ProfileSeed => p !== null) : "all",
      axis,
      ...(raw.extent === "angle" ? { extent: "angle" as const } : {}),
      angle: typeof raw.angle === "number" ? String(raw.angle) : String(raw.angle ?? "90"),
      direction: raw.direction === "reverse" || raw.direction === "symmetric" ? raw.direction : "normal",
      operation: raw.operation === "join" || raw.operation === "cut" ? raw.operation : "new",
      suppressed: raw.suppressed === true,
    };
  }
  if (raw.type === "extrude" && typeof raw.sketch === "string") {
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.map(parseSeed).filter((p): p is ProfileSeed => p !== null)
      : "all";
    const direction =
      raw.direction === "reverse" || raw.direction === "symmetric" ? raw.direction : ("normal" as const);
    return {
      id: raw.id,
      type: "extrude",
      sketch: raw.sketch,
      profiles,
      distance: typeof raw.distance === "number" ? String(raw.distance) : String(raw.distance ?? "10"),
      direction,
      operation: raw.operation === "join" || raw.operation === "cut" ? raw.operation : "new",
      ...(raw.extent === "through" ? { extent: "through" as const } : {}),
      suppressed: raw.suppressed === true,
    };
  }
  return null;
}

function parseWorkPlane(raw: unknown): WorkPlane | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const expr = (v: unknown, dflt: string): string =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : dflt;
  return {
    id: raw.id,
    base: BASES.includes(raw.base as BasePlane) ? (raw.base as BasePlane) : "XY",
    offset: expr(raw.offset, "0"),
    angle: expr(raw.angle, "0"),
    axis: raw.axis === "v" ? "v" : "u",
  };
}

export function isBasePlane(base: string): base is BasePlane {
  return (BASES as readonly string[]).includes(base);
}

/** Validates Document.part (opaque JSON) into a PartData, dropping entries
 *  it doesn't understand rather than failing the whole part. */
export function parsePart(raw: unknown): PartData | null {
  if (!isObject(raw)) return null;
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters.filter(
        (p): p is Parameter => isObject(p) && typeof p.name === "string" && typeof p.expr === "string",
      )
    : [];
  const planes = Array.isArray(raw.planes)
    ? raw.planes.map(parseWorkPlane).filter((p): p is WorkPlane => p !== null)
    : [];
  const sketches = Array.isArray(raw.sketches)
    ? raw.sketches.map(parseSketch).filter((s): s is SketchData => s !== null)
    : [];
  const features = Array.isArray(raw.features)
    ? raw.features.map(parseFeature).filter((f): f is FeatureData => f !== null)
    : [];
  return { schema: PART_SCHEMA, units: "mm", parameters, planes, sketches, features };
}

/** Next free "Sketch001"-style id for `prefix`. Ids double as the names shown
 *  in the model browser, matching Inventor's own Sketch1/Extrusion1 habit. */
export function nextId(part: PartData, prefix: string): string {
  const used = new Set<string>([
    DRAWING_SKETCH,
    ...part.planes.map((p) => p.id),
    ...part.sketches.map((s) => s.id),
    ...part.features.map((f) => f.id),
  ]);
  for (let i = 1; ; i++) {
    const id = `${prefix}${String(i).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
}
