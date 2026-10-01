import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import type { Entity } from "../entities/entity";
import { findProfiles } from "./profile";
import { meshVolume } from "./kernel/extrude";
import { revolveRegions } from "./kernel/revolveRegion";
import { planeFrame } from "./plane";
import { rebuild, resolveRevolveAxis, sketchLines } from "./rebuild";
import { emptyPart, emptyPart as blank, parsePart } from "./types";
import type { PartData, RevolveFeature } from "./types";
import type { Body } from "./kernel/types";

/** Sketch (Y-down) rectangle x0..x1, y0..y1 as four lines. */
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
const X_AXIS = { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
const Y_AXIS = { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } };
const body = (r: Body | string): Body => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
/** 72 flat segments per turn: a circle's area comes out this much short. */
const FACET = Math.sin((2 * Math.PI) / 72) / ((2 * Math.PI) / 72);

describe("revolveRegions", () => {
  it("a rectangle off the axis makes a ring: 2 cylinders + 2 flat ends, closed, outward", () => {
    const regions = findProfiles(rect(10, 0, 20, -30)).regions; // r 10..20, 30 long (drawn upward)
    const b = body(revolveRegions("R", regions, XY, Y_AXIS, 0, 2 * Math.PI));
    expect(isWatertight(b)).toBe(true);
    expect(volume(b)).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 30 * FACET, 3);
    expect(b.faces.map((f) => f.geom.kind).sort()).toEqual(["cylinder", "cylinder", "plane", "plane"]);
    const radii = b.faces.flatMap((f) => (f.geom.kind === "cylinder" ? [f.geom.radius] : [])).sort((x, y) => x - y);
    expect(radii[0]).toBeCloseTo(10);
    expect(radii[1]).toBeCloseTo(20);
    // Four corners -> four exact full circles.
    expect(b.edges).toHaveLength(4);
    expect(b.edges.every((e) => e.geom.kind === "arc" && Math.abs(e.geom.sweep - 2 * Math.PI) < 1e-12)).toBe(true);
  });

  it("a rectangle touching the axis makes a solid cylinder (no face on the axis)", () => {
    const regions = findProfiles(rect(0, 0, 8, -25)).regions;
    const b = body(revolveRegions("R", regions, XY, Y_AXIS, 0, 2 * Math.PI));
    expect(isWatertight(b)).toBe(true);
    expect(volume(b)).toBeCloseTo(Math.PI * 64 * 25 * FACET, 3);
    expect(b.faces.map((f) => f.geom.kind).sort()).toEqual(["cylinder", "plane", "plane"]);
    expect(b.edges).toHaveLength(2);
  });

  it("works on either side of the axis, and for either axis direction", () => {
    const want = Math.PI * (20 * 20 - 10 * 10) * 30 * FACET;
    const left = findProfiles(rect(-20, 0, -10, -30)).regions;
    for (const axis of [Y_AXIS, { a: { x: 0, y: 5 }, b: { x: 0, y: -3 } }]) {
      const b = body(revolveRegions("R", left, XY, axis, 0, 2 * Math.PI));
      expect(isWatertight(b)).toBe(true);
      expect(volume(b)).toBeCloseTo(want, 3);
    }
  });

  it("a slanted line makes a cone, a circle a torus, a half disc on the axis a sphere", () => {
    const tri = findProfiles([
      new Line({ x: 0, y: 0 }, { x: 10, y: 0 }),
      new Line({ x: 10, y: 0 }, { x: 0, y: -20 }),
      new Line({ x: 0, y: -20 }, { x: 0, y: 0 }),
    ]).regions;
    const cone = body(revolveRegions("R", tri, XY, Y_AXIS, 0, 2 * Math.PI));
    expect(isWatertight(cone)).toBe(true);
    expect(volume(cone)).toBeCloseTo(((Math.PI * 100 * 20) / 3) * FACET, 3);
    const k = cone.faces.find((f) => f.geom.kind === "cone")!.geom;
    expect(k.kind === "cone" && k.halfAngle).toBeCloseTo(Math.atan(10 / 20));
    expect(k.kind === "cone" && k.apex.y).toBeCloseTo(20);

    const ring = findProfiles([new Circle({ x: 30, y: 0 }, 5)]).regions;
    const torus = body(revolveRegions("R", ring, XY, Y_AXIS, 0, 2 * Math.PI));
    expect(isWatertight(torus)).toBe(true);
    expect(torus.faces).toHaveLength(1);
    expect(torus.faces[0]!.geom).toMatchObject({ kind: "torus", major: 30, minor: 5 });
    expect(torus.edges).toHaveLength(0); // smooth all over
    // Pappus: area x path of the centroid (both tessellated, so ~1% short).
    expect(volume(torus) / (Math.PI * 25 * 2 * Math.PI * 30)).toBeGreaterThan(0.985);
    expect(volume(torus) / (Math.PI * 25 * 2 * Math.PI * 30)).toBeLessThan(1);

    const half = findProfiles([new Arc({ x: 0, y: 0 }, 10, -Math.PI / 2, Math.PI / 2), new Line({ x: 0, y: -10 }, { x: 0, y: 10 })]).regions;
    expect(half).toHaveLength(1);
    const ball = body(revolveRegions("R", half, XY, Y_AXIS, 0, 2 * Math.PI));
    expect(isWatertight(ball)).toBe(true);
    expect(ball.faces).toHaveLength(1);
    expect(ball.faces[0]!.geom).toMatchObject({ kind: "torus", major: 0, minor: 10 });
    expect(volume(ball) / ((4 / 3) * Math.PI * 1000)).toBeGreaterThan(0.985);
    expect(volume(ball) / ((4 / 3) * Math.PI * 1000)).toBeLessThan(1);
  });

  it("a partial turn is closed by two flat caps, toward +normal for a positive angle", () => {
    const regions = findProfiles(rect(10, 0, 20, -30)).regions;
    const b = body(revolveRegions("R", regions, XY, Y_AXIS, 0, Math.PI / 2));
    expect(isWatertight(b)).toBe(true);
    expect(volume(b)).toBeCloseTo((Math.PI * 300 * 30 * FACET) / 4, 3);
    expect(b.faces.filter((f) => f.ref.role === "start" || f.ref.role === "end")).toHaveLength(2);
    // Profile at +X turns toward +Z (the XY plane's normal): nothing below it or at -X.
    const p = b.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      expect(p[i]!).toBeGreaterThan(-1e-9);
      expect(p[i + 2]!).toBeGreaterThan(-1e-9);
    }
    const end = b.faces.find((f) => f.ref.role === "end")!.geom;
    expect(end.kind === "plane" && end.normal.x).toBeCloseTo(-1);
    // 4 corner arcs + 4 cap edges at each end.
    expect(b.edges).toHaveLength(12);
  });

  it("a profile with a hole revolves into a hollow ring", () => {
    const regions = findProfiles([...rect(10, 0, 30, -20), new Circle({ x: 20, y: -10 }, 4)]).regions;
    expect(regions).toHaveLength(1);
    const b = body(revolveRegions("R", regions, XY, Y_AXIS, 0, 2 * Math.PI));
    expect(isWatertight(b)).toBe(true);
    const solid = Math.PI * (900 - 100) * 20 * FACET;
    expect(volume(b)).toBeLessThan(solid);
    expect(volume(b)).toBeGreaterThan(solid - Math.PI * 16 * 2 * Math.PI * 20);
    for (const angle of [Math.PI / 3, Math.PI]) expect(isWatertight(body(revolveRegions("R", regions, XY, Y_AXIS, -angle / 2, angle / 2)))).toBe(true);
  });

  it("refuses a profile that crosses the axis, or lies on it", () => {
    const regions = findProfiles(rect(-5, 0, 20, -30)).regions;
    expect(revolveRegions("R", regions, XY, Y_AXIS, 0, 2 * Math.PI)).toMatch(/crosses the axis/);
    expect(revolveRegions("R", regions, XY, { a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }, 0, 1)).toMatch(/no length/);
    expect(typeof revolveRegions("R", regions, XY, X_AXIS, 0, 2 * Math.PI)).toBe("object"); // its bottom edge is on X
  });
});

describe("Revolve feature", () => {
  const part = (f: Partial<RevolveFeature>): PartData => ({
    ...emptyPart(),
    features: [{ id: "Revolve001", type: "revolve", sketch: "Drawing", profiles: "all", axis: { kind: "v" }, angle: "90", direction: "normal", operation: "new", ...f }],
  });
  const drawing = (entities: Entity[]): Record<string, unknown>[] => entities.map((e) => e.serialize());

  it("rebuilds about the sketch's vertical axis; angle and direction apply", () => {
    const ents = drawing(rect(10, 0, 20, -30));
    const full = rebuild(part({}), ents);
    expect(full.status.get("Revolve001")).toEqual({ ok: true });
    expect(volume(full.bodies[0]!)).toBeCloseTo(Math.PI * 300 * 30 * FACET, 3);

    const quarter = rebuild(part({ extent: "angle", angle: "90" }), ents);
    expect(volume(quarter.bodies[0]!)).toBeCloseTo((Math.PI * 300 * 30 * FACET) / 4, 3);
    const zs = (b: Body): number[] => [...b.mesh.positions].filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs(quarter.bodies[0]!))).toBeGreaterThan(-1e-9);
    const flipped = rebuild(part({ extent: "angle", angle: "90", direction: "reverse" }), ents);
    expect(Math.max(...zs(flipped.bodies[0]!))).toBeLessThan(1e-9);
    const both = rebuild(part({ extent: "angle", angle: "90", direction: "symmetric" }), ents);
    expect(Math.max(...zs(both.bodies[0]!))).toBeCloseTo(-Math.min(...zs(both.bodies[0]!)));

    expect(rebuild(part({ extent: "angle", angle: "0" }), ents).status.get("Revolve001")?.ok).toBe(false);
    expect(rebuild(part({ extent: "angle", angle: "400" }), ents).status.get("Revolve001")?.ok).toBe(false);
  });

  it("reports a profile crossing the axis instead of building rubbish", () => {
    const r = rebuild(part({}), drawing(rect(-5, 0, 20, -30)));
    expect(r.status.get("Revolve001")?.ok).toBe(false);
    expect(r.status.get("Revolve001")?.error).toMatch(/crosses the axis/);
    expect(r.bodies).toHaveLength(0);
  });

  it("cuts a groove round a shaft, and joins a flange onto it", () => {
    const shaft: RevolveFeature = { id: "Revolve001", type: "revolve", sketch: "Drawing", profiles: [{ x: 5, y: -20 }], axis: { kind: "v" }, angle: "90", direction: "normal", operation: "new" };
    const groove: RevolveFeature = { ...shaft, id: "Revolve002", sketch: "Sketch001", profiles: "all", operation: "cut" };
    const flange: RevolveFeature = { ...shaft, id: "Revolve003", sketch: "Sketch002", profiles: "all", operation: "join" };
    const ents = drawing(rect(0, 0, 10, -40));
    const sketch = (id: string, e: Entity[]): PartData["sketches"][number] => ({ id, plane: { base: "XY", offset: 0 }, entities: drawing(e), constraints: [] });
    const emptyPart = (): PartData => ({ ...blank(), sketches: [sketch("Sketch001", rect(8, -18, 12, -22)), sketch("Sketch002", rect(10, 0, 20, -4))] });
    const base = rebuild({ ...emptyPart(), features: [shaft] }, ents);
    const v0 = volume(base.bodies[0]!);
    const cut = rebuild({ ...emptyPart(), features: [shaft, groove] }, ents);
    expect(cut.status.get("Revolve002")).toEqual({ ok: true });
    expect(cut.bodies).toHaveLength(1);
    expect(volume(cut.bodies[0]!)).toBeCloseTo(v0 - Math.PI * (100 - 64) * 4 * FACET, 2);
    const joined = rebuild({ ...emptyPart(), features: [shaft, groove, flange] }, ents);
    expect(joined.status.get("Revolve003")).toEqual({ ok: true });
    expect(joined.bodies).toHaveLength(1);
    expect(volume(joined.bodies[0]!)).toBeCloseTo(volume(cut.bodies[0]!) + Math.PI * (400 - 100) * 4 * FACET, 2);
    expect(isWatertight(joined.bodies[0]!)).toBe(true);
  });

  it("a picked axis line follows the line when the sketch is moved", () => {
    const axis = { kind: "line", a: { x: 0, y: 0 }, b: { x: 0, y: -50 } } as const;
    const still = sketchLines([new Line({ x: 0, y: 0 }, { x: 0, y: -50 }), ...rect(10, 0, 20, -30)]);
    expect(resolveRevolveAxis(axis, still)).toEqual({ a: { x: 0, y: -0 }, b: { x: 0, y: 50 } });
    // Everything moved 100 right: the axis is the moved line, not the old place.
    const moved = sketchLines([new Line({ x: 100, y: 0 }, { x: 100, y: -50 }), ...rect(110, 0, 120, -30)]);
    const got = resolveRevolveAxis(axis, moved);
    expect(got.a.x).toBe(100);
    expect(got.b.x).toBe(100);
    // The line was deleted: the stored axis still stands.
    expect(resolveRevolveAxis(axis, sketchLines(rect(10, 0, 20, -30))).a.x).toBe(0);
  });

  it("round-trips through parsePart; unknown axis data falls back safely", () => {
    const f: RevolveFeature = { id: "Revolve001", type: "revolve", sketch: "Sketch001", profiles: [{ x: 1, y: 2, area: 3 }], axis: { kind: "line", a: { x: 0, y: 0 }, b: { x: 0, y: 9 } }, extent: "angle", angle: "d1*2", direction: "symmetric", operation: "cut" };
    const back = parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), features: [f] })))!.features[0];
    expect(back).toEqual({ ...f, suppressed: false });
    const odd = parsePart({ features: [{ id: "R", type: "revolve", sketch: "S", axis: { kind: "line" } }] })!.features[0] as RevolveFeature;
    expect(odd.axis).toEqual({ kind: "u" });
    expect(odd.extent).toBeUndefined();
  });
});
