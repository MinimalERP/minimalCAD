import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { findProfiles } from "./profile";
import { meshVolume } from "./kernel/extrude";
import { extrudeShaped } from "./kernel/extrudeShaped";
import { planeFrame } from "./plane";
import { rebuild } from "./rebuild";
import { emptyPart, parsePart } from "./types";
import type { ExtrudeFeature, PartData } from "./types";
import type { Body } from "./kernel/types";

const rect = (x0: number, y0: number, x1: number, y1: number): Entity[] => [
  new Line({ x: x0, y: y0 }, { x: x1, y: y0 }),
  new Line({ x: x1, y: y0 }, { x: x1, y: y1 }),
  new Line({ x: x1, y: y1 }, { x: x0, y: y1 }),
  new Line({ x: x0, y: y1 }, { x: x0, y: y0 }),
];

function isWatertight(body: Body): boolean {
  const { positions, indices } = body.mesh;
  const key = (i: number): string => [0, 1, 2].map((k) => Math.round(positions[i * 3 + k]! * 1e4)).join(",");
  const directed = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(indices[t + e]!);
      const b = key(indices[t + ((e + 1) % 3)]!);
      if (a === b) continue;
      directed.set(`${a}|${b}`, (directed.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const [k, count] of directed) {
    const [a, b] = k.split("|");
    if (count !== 1 || directed.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
}

const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const XY = planeFrame({ base: "XY", offset: 0 });
const body = (r: Body | string): Body => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const NONE = { tanTaper: 0, shear: { x: 0, y: 0 }, square: false };
const tan = (deg: number): number => Math.tan((deg * Math.PI) / 180);
const bounds = (b: Body): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  b.mesh.positions.forEach((v, i) => {
    min[i % 3] = Math.min(min[i % 3]!, v);
    max[i % 3] = Math.max(max[i % 3]!, v);
  });
  return { min, max };
};

describe("extrudeShaped: taper", () => {
  it("a tapered block is a frustum: flat sloped sides, smaller top", () => {
    const regions = findProfiles(rect(0, 0, 40, -30)).regions;
    const b = body(extrudeShaped("E", regions, XY, 0, 10, { ...NONE, tanTaper: tan(10) }));
    expect(isWatertight(b)).toBe(true);
    // Integral of (40 - 2kz)(30 - 2kz) over the height, k = tan(taper).
    const k = tan(10);
    expect(volume(b)).toBeCloseTo(12000 - 7000 * k + (4000 / 3) * k * k, 6);
    expect(b.faces.every((f) => f.geom.kind === "plane")).toBe(true);
    // A side tips up by the taper angle.
    const side = b.faces.find((f) => f.ref.role === "side")!.geom;
    expect(side.kind === "plane" && side.normal.z).toBeCloseTo(Math.sin((10 * Math.PI) / 180));
    expect(b.edges).toHaveLength(12);
  });

  it("a tapered circle is an exact cone; a negative taper flares out", () => {
    const regions = findProfiles([new Circle({ x: 5, y: 5 }, 10)]).regions;
    const b = body(extrudeShaped("E", regions, XY, 0, 20, { ...NONE, tanTaper: tan(15) }));
    expect(isWatertight(b)).toBe(true);
    const cone = b.faces.find((f) => f.geom.kind === "cone")!.geom;
    expect(cone.kind === "cone" && cone.halfAngle).toBeCloseTo((15 * Math.PI) / 180);
    expect(cone.kind === "cone" && cone.apex.z).toBeCloseTo(10 / tan(15)); // where the radius runs out
    expect(cone.kind === "cone" && cone.axis.z).toBeCloseTo(-1); // wider toward the bottom
    const rim = b.edges.find((e) => e.ref.role === "end")!.geom;
    expect(rim.kind === "arc" && rim.radius).toBeCloseTo(10 - 20 * tan(15));
    const flared = body(extrudeShaped("E", regions, XY, 0, 20, { ...NONE, tanTaper: tan(-15) }));
    expect(isWatertight(flared)).toBe(true);
    expect(volume(flared)).toBeGreaterThan(volume(b) * 2);
  });

  it("both ways from the sketch plane it narrows each way, with a crease in the middle", () => {
    const regions = findProfiles(rect(0, 0, 40, -30)).regions;
    const b = body(extrudeShaped("E", regions, XY, -10, 10, { ...NONE, tanTaper: tan(10) }));
    expect(isWatertight(b)).toBe(true);
    const k = tan(10);
    expect(volume(b)).toBeCloseTo(2 * (12000 - 7000 * k + (4000 / 3) * k * k), 6);
    expect(b.faces.filter((f) => f.ref.role === "side")).toHaveLength(8);
  });

  it("a shape with a hole: material recedes on every wall; too steep is refused", () => {
    const regions = findProfiles([...rect(0, 0, 40, -30), new Circle({ x: 20, y: -15 }, 5)]).regions;
    const b = body(extrudeShaped("E", regions, XY, 0, 10, { ...NONE, tanTaper: tan(10) }));
    expect(isWatertight(b)).toBe(true);
    const rim = b.edges.filter((e) => e.ref.role === "end" && e.geom.kind === "arc")[0]!.geom;
    expect(rim.kind === "arc" && rim.radius).toBeCloseTo(5 + 10 * tan(10)); // the hole opens up
    expect(extrudeShaped("E", regions, XY, 0, 10, { ...NONE, tanTaper: tan(60) })).toMatch(/too steep/);
  });
});

describe("extrudeShaped: lean", () => {
  it("a leaning block keeps its volume and slides sideways with height", () => {
    const regions = findProfiles(rect(0, 0, 40, -30)).regions;
    const b = body(extrudeShaped("E", regions, XY, 0, 10, { ...NONE, shear: { x: tan(45), y: 0 } }));
    expect(isWatertight(b)).toBe(true);
    expect(volume(b)).toBeCloseTo(12000, 6);
    const { min, max } = bounds(b);
    expect(max[0]).toBeCloseTo(50); // top slid 10 toward +X
    expect(min[0]).toBeCloseTo(0);
    expect(max[1]! - min[1]!).toBeCloseTo(30);
    expect(b.faces.every((f) => f.geom.kind === "plane")).toBe(true);
  });

  it("footprint mode: a drawn circle stays a circle on the plane (free-form wall)", () => {
    const regions = findProfiles([new Circle({ x: 0, y: 0 }, 10)]).regions;
    const b = body(extrudeShaped("E", regions, XY, 0, 20, { ...NONE, shear: { x: tan(30), y: 0 } }));
    expect(isWatertight(b)).toBe(true);
    expect(b.faces.find((f) => f.ref.role === "side")!.geom.kind).toBe("freeform");
    const base = b.edges.find((e) => e.ref.role === "start")!.geom;
    expect(base.kind === "arc" && base.radius).toBeCloseTo(10);
    const { min, max } = bounds(b);
    expect(min[0]).toBeCloseTo(-10);
    expect(max[0]).toBeCloseTo(10 + 20 * tan(30));
  });

  it("section mode: a drawn circle makes a truly round, slanted cylinder", () => {
    const regions = findProfiles([new Circle({ x: 7, y: -3 }, 10)]).regions;
    const b = body(extrudeShaped("E", regions, XY, 0, 20, { tanTaper: 0, shear: { x: tan(45), y: 0 }, square: true }));
    expect(isWatertight(b)).toBe(true);
    const wall = b.faces.find((f) => f.ref.role === "side")!.geom;
    expect(wall).toMatchObject({ kind: "cylinder", radius: 10 });
    expect(wall.kind === "cylinder" && wall.axis.x).toBeCloseTo(Math.SQRT1_2);
    expect(wall.kind === "cylinder" && wall.axis.z).toBeCloseTo(Math.SQRT1_2);
    expect(wall.kind === "cylinder" && wall.axisOrigin.x).toBeCloseTo(7); // centred where it was drawn
    expect(wall.kind === "cylinder" && wall.axisOrigin.y).toBeCloseTo(3);
    // Every vertex is within 10 of the slanted axis (the wall's are exactly on it).
    const p = b.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const d = { x: p[i]! - 7, y: p[i + 1]! - 3, z: p[i + 2]! };
      const along = (d.x + d.z) * Math.SQRT1_2;
      const off = Math.hypot(d.x - along * Math.SQRT1_2, d.y, d.z - along * Math.SQRT1_2);
      expect(off).toBeLessThan(10 + 1e-9);
    }
    // Footprint: 10 across the lean, 10 / cos 45 along it.
    const { min, max } = bounds(b);
    expect(min[0]).toBeCloseTo(7 - 10 * Math.SQRT2);
    expect(max[1]! - min[1]!).toBeCloseTo(20);
  });
});

describe("Extrude feature with taper / lean", () => {
  const part = (f: Partial<ExtrudeFeature>): PartData => ({
    ...emptyPart(),
    features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "20", direction: "normal", operation: "new", ...f }],
  });
  const ents = [new Circle({ x: 0, y: 0 }, 10)].map((e) => e.serialize());

  it("rebuilds; leans toward the sketch's up for 90; bad angles are reported", () => {
    const plain = rebuild(part({}), ents);
    expect(plain.bodies[0]!.faces.some((f) => f.geom.kind === "cylinder")).toBe(true);
    const tapered = rebuild(part({ taper: "10" }), ents);
    expect(tapered.status.get("Extrude001")).toEqual({ ok: true });
    expect(tapered.bodies[0]!.faces.some((f) => f.geom.kind === "cone")).toBe(true);
    const leaning = rebuild(part({ lean: "45", leanToward: "90", section: "square" }), ents);
    expect(leaning.status.get("Extrude001")).toEqual({ ok: true });
    expect(bounds(leaning.bodies[0]!).max[1]).toBeGreaterThan(20); // toward +Y (up in the 2D drawing)
    expect(bounds(leaning.bodies[0]!).max[0]).toBeCloseTo(10, 6);
    expect(rebuild(part({ taper: "95" }), ents).status.get("Extrude001")?.ok).toBe(false);
    expect(rebuild(part({ lean: "88" }), ents).status.get("Extrude001")?.ok).toBe(false);
    expect(rebuild(part({ taper: "60" }), ents).status.get("Extrude001")?.error).toMatch(/too steep/);
  });

  it("a leaning round boss joins onto a block", () => {
    const block = rect(-30, 20, 30, -20).map((e) => e.serialize());
    const p: PartData = {
      ...emptyPart(),
      sketches: [{ id: "Sketch001", plane: { base: "XY", offset: 10 }, entities: ents, constraints: [] }],
      features: [
        { id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" },
        { id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "15", direction: "normal", operation: "join", lean: "30", leanToward: "0", section: "square" },
      ],
    };
    const r = rebuild(p, block);
    expect(r.status.get("Extrude002")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    expect(isWatertight(r.bodies[0]!)).toBe(true);
    expect(volume(r.bodies[0]!)).toBeGreaterThan(24000 + Math.PI * 100 * 15 * 0.98);
  });

  it("round-trips through parsePart; plain extrudes stay as they were", () => {
    const f: ExtrudeFeature = { id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "20", direction: "normal", operation: "new", taper: "5", lean: "30", leanToward: "90", section: "square" };
    expect(parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), features: [f] })))!.features[0]).toEqual({ ...f, suppressed: false });
    const plain = parsePart({ features: [{ id: "E", type: "extrude", sketch: "Drawing", distance: 5 }] })!.features[0]!;
    expect(Object.keys(plain).sort()).toEqual(["direction", "distance", "id", "operation", "profiles", "sketch", "suppressed", "type"]);
  });
});
