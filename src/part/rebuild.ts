/**
 * MinimalCAD Web
 * part/rebuild.ts
 *
 * Parametric Model -> Geometry: replays the feature history top to bottom.
 * A failing feature is reported (status) and skipped -- it never throws, so
 * one bad edit can't make the rest of the model disappear.
 */

import { parseEntities } from "../core/document";
import { extrudeRegions } from "./kernel/extrude";
import { subtract, union } from "./kernel/csg";
import { bodyBounds, bodyToPolygons, boundsOverlap, polygonsToBody } from "./kernel/brep";
import type { Body, TopoRef } from "./kernel/types";
import type { Surface } from "./cylFrame";
import { cylFrame, isCyl } from "./cylFrame";
import { dot, length, scale, sub } from "./vec3";
import { faceHasRef } from "./kernel/types";
import { resolveParameters, evalExpression } from "./params";
import { faceFrame, offsetFrame, planeFrame, toLocal, workPlaneFrame } from "./plane";
import type { Frame } from "./plane";
import { findProfiles, regionContains } from "./profile";
import type { ProfileResult, Region } from "./profile";
import type { ExtrudeFeature, HoleFeature, PartData, PlaneRef, SketchData } from "./types";
import { holeTools } from "./hole";
import { DRAWING_SKETCH, FACE_PLANE, isBasePlane } from "./types";

export interface FeatureStatus {
  ok: boolean;
  error?: string;
}

export interface WorkPlaneGeometry {
  id: string;
  frame: Frame | null;
  error?: string;
}

export interface SketchGeometry {
  sketch: SketchData;
  frame: Frame;
  profiles: ProfileResult;
}

export interface RebuildResult {
  bodies: Body[];
  status: Map<string, FeatureStatus>;
  sketches: Map<string, SketchGeometry>;
  planes: Map<string, WorkPlaneGeometry>;
  params: Map<string, number>;
}

export function sketchGeometry(sketch: SketchData, frame: Frame): SketchGeometry {
  const { entities } = parseEntities(sketch.entities);
  return { sketch, frame, profiles: findProfiles(entities) };
}

export function resolveWorkPlanes(part: PartData, params: ReadonlyMap<string, number>): Map<string, WorkPlaneGeometry> {
  const planes = new Map<string, WorkPlaneGeometry>();
  for (const wp of part.planes) {
    const offset = evalExpression(wp.offset, params);
    const angle = evalExpression(wp.angle, params);
    planes.set(
      wp.id,
      offset === null || angle === null
        ? { id: wp.id, frame: null, error: `Invalid ${offset === null ? "offset" : "angle"}` }
        : { id: wp.id, frame: workPlaneFrame(wp, offset, angle) },
    );
  }
  return planes;
}

/** Frame of a flat face (by topological ref) among `bodies`, or null. */
export function faceFrameOf(bodies: readonly Body[], ref: NonNullable<PlaneRef["face"]>): Frame | null {
  // Any body: after a join/cut a feature's faces live in another feature's body.
  for (const body of bodies) {
    // The full ref, feature included: every extrude has an "end 0" face (a
    // cube's top and a boss's top must never be confused).
    const face = body.faces.find((f) => faceHasRef(f, ref));
    if (face?.geom.kind === "plane") return faceFrame(face.geom.origin, face.geom.normal);
  }
  return null;
}

/** A hole's face among `bodies`: a flat face's Frame, or a round face's
 *  CylFrame; null if it's gone. */
export function faceSurfaceOf(bodies: readonly Body[], ref: TopoRef): Surface | null {
  for (const body of bodies) {
    const face = body.faces.find((f) => faceHasRef(f, ref));
    if (face?.geom.kind === "plane") return faceFrame(face.geom.origin, face.geom.normal);
    if (face?.geom.kind === "cylinder") return cylFrame(face.geom);
  }
  return null;
}

/** Through-all length for holes on `s`: from the face to just past the far
 *  side of every solid (for a round face: across the axis and beyond). */
export function surfaceThroughLength(bodies: readonly Body[], s: Surface): number {
  if (!isCyl(s)) return throughLength(bodies, s);
  let reach = 0;
  for (const b of bodies) {
    const { min, max } = bodyBounds(b);
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          const d = sub({ x, y, z }, s.origin);
          reach = Math.max(reach, length(sub(d, scale(s.axis, dot(d, s.axis)))));
        }
      }
    }
  }
  const len = s.radius + reach;
  return len + Math.max(1, len * 0.02);
}

/** Frame for a sketch's plane reference, or null if its work plane / face
 *  is missing or broken. Face refs need the bodies built so far. */
export function resolvePlane(
  ref: PlaneRef,
  planes: ReadonlyMap<string, WorkPlaneGeometry>,
  bodies: readonly Body[] = [],
): Frame | null {
  if (isBasePlane(ref.base)) return planeFrame({ base: ref.base, offset: ref.offset });
  if (ref.base === FACE_PLANE) {
    const frame = ref.face === undefined ? null : faceFrameOf(bodies, ref.face);
    return frame === null ? null : offsetFrame(frame, ref.offset);
  }
  const frame = planes.get(ref.base)?.frame ?? null;
  return frame === null ? null : offsetFrame(frame, ref.offset);
}

function regionCentroid(r: Region): { x: number; y: number } {
  const pts = r.outer.polygon;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/** Regions chosen by an extrude: all of them, or the one containing each
 *  seed point (sketch coordinates). If a 2D edit moved a shape off its seed
 *  (e.g. the rectangle was moved), the seed re-attaches to the nearest
 *  still-unclaimed region of about the same area -- so the solid follows. */
export function selectRegions(regions: readonly Region[], profiles: ExtrudeFeature["profiles"]): Region[] {
  if (profiles === "all") return regions.slice();
  const chosen = new Set<Region>();
  const missed: typeof profiles = [];
  for (const seed of profiles) {
    const local = toLocal(seed);
    // Smallest region containing the seed (a region inside another's hole).
    const hit = regions.filter((r) => regionContains(r, local)).sort((a, b) => a.area - b.area)[0];
    if (hit !== undefined) chosen.add(hit);
    else missed.push(seed);
  }
  for (const seed of missed) {
    if (seed.area === undefined) continue;
    const local = toLocal(seed);
    const area = seed.area;
    const match = regions
      .filter((r) => !chosen.has(r) && Math.abs(r.area - area) <= area * 0.02)
      .map((r) => {
        const c = regionCentroid(r);
        return { r, d: Math.hypot(c.x - local.x, c.y - local.y) };
      })
      .sort((a, b) => a.d - b.d)[0];
    if (match !== undefined) chosen.add(match.r);
  }
  return [...chosen];
}

export function extrudeExtent(direction: ExtrudeFeature["direction"], distance: number): [number, number] {
  if (direction === "reverse") return [-distance, 0];
  if (direction === "symmetric") return [-distance / 2, distance / 2];
  return [0, distance];
}

/** The tab's 2D drafting drawing as the part's XY base sketch. */
export function drawingSketch(entities: Record<string, unknown>[]): SketchData {
  return { id: DRAWING_SKETCH, plane: { base: "XY", offset: 0 }, entities, constraints: [] };
}

/** `drawingEntities`: the Document's own 2D entities (serialized), which
 *  form the XY base sketch that features may reference as DRAWING_SKETCH. */
/** Long enough to pass through every body from anywhere on `frame`'s plane. */
export function throughLength(bodies: readonly Body[], frame: Frame): number {
  if (bodies.length === 0) return 0;
  // Farthest any solid reaches from the plane, measured along its normal
  // (either side) -- just past the far side of the model, so a through cut
  // clears everything without a tool that hangs far out into space.
  let reach = 0;
  for (const b of bodies) {
    const { min, max } = bodyBounds(b);
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          const d = (x - frame.origin.x) * frame.n.x + (y - frame.origin.y) * frame.n.y + (z - frame.origin.z) * frame.n.z;
          reach = Math.max(reach, Math.abs(d));
        }
      }
    }
  }
  return reach + Math.max(1, reach * 0.02);
}

/**
 * Applies a feature's tool body to the model (in place) -- the solid
 * booleans are our own (kernel/csg.ts + kernel/brep.ts).
 *  - new:  the tool becomes a separate body;
 *  - join: merged with every body it touches (all into one); alone if none;
 *  - cut:  removed from every body it touches.
 */
export function applyOperation(bodies: Body[], tool: Body, operation: ExtrudeFeature["operation"]): FeatureStatus {
  if (operation === "new") {
    bodies.push(tool);
    return { ok: true };
  }
  const hit = bodies.filter((b) => boundsOverlap(b, tool));
  if (operation === "join") {
    if (hit.length === 0) {
      bodies.push(tool);
      return { ok: true };
    }
    let faces = [...hit[0]!.faces];
    let polys = bodyToPolygons(hit[0]!, 0);
    for (const other of [...hit.slice(1), tool]) {
      const offset = faces.length;
      faces = [...faces, ...other.faces];
      polys = union(polys, bodyToPolygons(other, offset));
    }
    const merged = polygonsToBody(hit[0]!.id, hit[0]!.feature, polys, faces);
    const at = bodies.indexOf(hit[0]!);
    for (const b of hit) bodies.splice(bodies.indexOf(b), 1);
    bodies.splice(at, 0, merged);
    return { ok: true };
  }
  // cut
  if (hit.length === 0) return { ok: false, error: "Cut removed nothing - the shape doesn't reach the solid" };
  let removed = false;
  for (const b of hit) {
    const faces = [...b.faces, ...tool.faces];
    const polys = subtract(bodyToPolygons(b, 0), bodyToPolygons(tool, b.faces.length));
    // The tool never actually touched this body (only its bounding box did).
    if (polys.length > 0 && !polys.some((p) => p.faceId >= b.faces.length)) continue;
    const result = polygonsToBody(b.id, b.feature, polys, faces);
    removed = true;
    const at = bodies.indexOf(b);
    if (result.mesh.indices.length === 0) bodies.splice(at, 1);
    else bodies[at] = result;
  }
  return removed ? { ok: true } : { ok: false, error: "Cut removed nothing - the shape doesn't reach the solid" };
}

/** Drills a Hole feature into the bodies (in place). */
function applyHole(feature: HoleFeature, bodies: Body[], params: ReadonlyMap<string, number>): FeatureStatus {
  const surface = faceSurfaceOf(bodies, feature.face);
  if (surface === null || isCyl(surface) !== (feature.placement === "radial")) {
    return { ok: false, error: "The face this hole is on no longer exists" };
  }
  if (feature.centers.length === 0) return { ok: false, error: "No hole centres" };
  const tools = holeTools(feature, surface, params, surfaceThroughLength(bodies, surface));
  if (typeof tools === "string") return { ok: false, error: tools };
  let removedAny = false;
  for (const tool of tools) {
    if (applyOperation(bodies, tool, "cut").ok) removedAny = true;
  }
  return removedAny ? { ok: true } : { ok: false, error: "Hole misses the solid" };
}

export function rebuild(part: PartData, drawingEntities: Record<string, unknown>[] = []): RebuildResult {
  const params = resolveParameters(part.parameters);
  const planes = resolveWorkPlanes(part, params);
  const sketches = new Map<string, SketchGeometry>();
  sketches.set(DRAWING_SKETCH, sketchGeometry(drawingSketch(drawingEntities), planeFrame({ base: "XY", offset: 0 })));
  const bodies: Body[] = [];
  // Sketches resolve lazily, in history order: a sketch on a face needs the
  // bodies of the features before the one that uses it.
  const resolveSketch = (id: string): SketchGeometry | undefined => {
    const cached = sketches.get(id);
    if (cached !== undefined) return cached;
    const sketch = part.sketches.find((s) => s.id === id);
    if (sketch === undefined) return undefined;
    const frame = resolvePlane(sketch.plane, planes, bodies);
    if (frame === null) return undefined;
    const geo = sketchGeometry(sketch, frame);
    sketches.set(id, geo);
    return geo;
  };

  const status = new Map<string, FeatureStatus>();
  for (const feature of part.features) {
    if (feature.suppressed === true) {
      status.set(feature.id, { ok: true });
      continue;
    }
    if (feature.type === "hole") {
      status.set(feature.id, applyHole(feature, bodies, params));
      continue;
    }
    const geo = resolveSketch(feature.sketch);
    if (geo === undefined) {
      status.set(feature.id, { ok: false, error: `Sketch ${feature.sketch} is missing or its plane is broken` });
      continue;
    }
    const through = feature.extent === "through";
    const distance = through ? throughLength(bodies, geo.frame) : evalExpression(feature.distance, params);
    if (distance === null || !(distance > 0)) {
      status.set(feature.id, { ok: false, error: `Invalid distance "${feature.distance}"` });
      continue;
    }
    const regions = selectRegions(geo.profiles.regions, feature.profiles);
    if (regions.length === 0) {
      status.set(feature.id, {
        ok: false,
        error:
          feature.profiles === "all" || feature.profiles.length === 0
            ? "No closed profile to extrude"
            : "Profile not found - the shape was deleted or opened up",
      });
      continue;
    }
    // Through all: the tool reaches past the model in the chosen direction(s).
    const [h0, h1] = through && feature.direction === "symmetric" ? [-distance, distance] : extrudeExtent(feature.direction, distance);
    const tool = extrudeRegions(feature.id, regions, geo.frame, h0, h1);
    status.set(feature.id, applyOperation(bodies, tool, feature.operation));
  }
  for (const sketch of part.sketches) resolveSketch(sketch.id);
  return { bodies, status, sketches, planes, params };
}

