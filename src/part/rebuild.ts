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
import type { Body } from "./kernel/types";
import { resolveParameters, evalExpression } from "./params";
import { faceFrame, offsetFrame, planeFrame, toLocal, workPlaneFrame } from "./plane";
import type { Frame } from "./plane";
import { findProfiles, regionContains } from "./profile";
import type { ProfileResult, Region } from "./profile";
import type { ExtrudeFeature, PartData, PlaneRef, SketchData } from "./types";
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
  for (const body of bodies) {
    if (body.feature !== ref.feature) continue;
    const face = body.faces.find((f) => f.ref.role === ref.role && f.ref.index === ref.index);
    if (face?.geom.kind === "plane") return faceFrame(face.geom.origin, face.geom.normal);
  }
  return null;
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
    const geo = resolveSketch(feature.sketch);
    if (geo === undefined) {
      status.set(feature.id, { ok: false, error: `Sketch ${feature.sketch} is missing or its plane is broken` });
      continue;
    }
    const distance = evalExpression(feature.distance, params);
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
    const [h0, h1] = extrudeExtent(feature.direction, distance);
    bodies.push(extrudeRegions(feature.id, regions, geo.frame, h0, h1));
    status.set(feature.id, { ok: true });
  }
  for (const sketch of part.sketches) resolveSketch(sketch.id);
  return { bodies, status, sketches, planes, params };
}

