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

export type FeatureData = ExtrudeFeature;

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

function parseFeature(raw: unknown): FeatureData | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
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
