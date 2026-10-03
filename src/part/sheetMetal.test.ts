import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { bodyBounds } from "./kernel/brep";
import type { Body } from "./kernel/types";
import { rebuild } from "./rebuild";
import { bendAllowance, chordAt, kFactor } from "./sheetMetal";
import { findProfiles } from "./profile";
import { parseEntities } from "../core/document";
import { emptyPart, parsePart } from "./types";
import type { HoleFeature, PartData, SheetBendData, SheetFeature } from "./types";

const L = (a: [number, number], b: [number, number]): Line => new Line({ x: a[0], y: a[1] }, { x: b[0], y: b[1] });
/** A 100 x 50 blank (sketch coords, Y-down: y 0..-50) plus extra entities. */
const blank = (extra: Entity[] = []): Record<string, unknown>[] =>
  [L([0, 0], [100, 0]), L([100, 0], [100, -50]), L([100, -50], [0, -50]), L([0, -50], [0, 0]), ...extra].map((e) => e.serialize());
const bendAt = (x: number, opts: Partial<SheetBendData> = {}): SheetBendData => ({ line: [{ x, y: 0 }, { x, y: -50 }], side: 1, dir: "up", angle: "90", ...opts });
const sheetPart = (bends: SheetBendData[], extra: Partial<SheetFeature> = {}, entities: Record<string, unknown>[] = blank(bends.map((b) => L([b.line[0].x, b.line[0].y], [b.line[1].x, b.line[1].y])))): PartData => ({
  ...emptyPart(),
  sketches: [{ id: "S1", plane: { base: "XY", offset: 0 }, entities, constraints: [] }],
  features: [{ id: "Sheet001", type: "sheet", sketch: "S1", profiles: "all", material: "crca", thickness: "2", radius: "2", bends, ...extra }],
});
const vol = (b: Body): number => Math.abs(meshVolume(b.mesh.positions, b.mesh.indices));

describe("sheet metal basics", () => {
  it("K-factor (DIN 6935) and bend allowance", () => {
    expect(kFactor(2, 2)).toBeCloseTo(0.325);
    expect(kFactor(20, 2)).toBeCloseTo(0.5);
    expect(bendAllowance(90, 2, 2, 0.325)).toBeCloseTo((Math.PI / 2) * (2 + 0.65));
  });

  it("flat pattern: just the blank", () => {
    const r = rebuild(sheetPart([bendAt(70)], { flat: true }), []);
    expect(r.status.get("Sheet001")).toEqual({ ok: true });
    expect(vol(r.bodies[0]!)).toBeCloseTo(100 * 50 * 2, 3);
  });
});

describe("one bend", () => {
  // Bend line at x = 70: the left side of start->end (start (70,0) -> end (70,-50) in sketch
  // coords = up the screen... in plane-local (y flipped) it runs from (70,0) to (70,50); its left is -x.
  it("90° up: one solid, volume kept (to the K-factor), the flange stands up", () => {
    const r = rebuild(sheetPart([bendAt(70, { side: -1 })]), []);
    expect(r.status.get("Sheet001")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    const b = bodyBounds(r.bodies[0]!);
    const T = 2;
    const R = 2;
    const K = kFactor(R, T);
    const ba = bendAllowance(90, R, T, K);
    // The flat 30 mm past the line: flange length after the bend = 30 - BA/2; it rises from z = R + T.
    expect(b.max.z).toBeCloseTo(R + T + (30 - ba / 2), 3);
    // Outside face of the flange: base end (70 - BA/2) + R + T.
    expect(b.max.x).toBeCloseTo(70 - ba / 2 + R + T, 3);
    expect(b.min.z).toBeCloseTo(0, 6);
    // Volume: bend zone volume vs the flat strip it replaces differs by (K - 0.5)*T... compare to exact.
    const theta = Math.PI / 2;
    const zone = (theta / 2) * ((R + T) ** 2 - R ** 2) * 50;
    const flat = (70 - ba / 2) * 50 * T + (30 - ba / 2) * 50 * T;
    expect(Math.abs(vol(r.bodies[0]!) - (flat + zone)) / (flat + zone)).toBeLessThan(2e-4); // the arc is faceted
  });

  it("down mirrors up", () => {
    const r = rebuild(sheetPart([bendAt(70, { side: -1, dir: "down" })]), []);
    const b = bodyBounds(r.bodies[0]!);
    const ba = bendAllowance(90, 2, 2, kFactor(2, 2));
    expect(b.min.z).toBeCloseTo(-(2 + (30 - ba / 2)) + 0, 3);
    expect(b.max.z).toBeCloseTo(2, 6);
  });

  it("which side folds: the other side stays down", () => {
    const r = rebuild(sheetPart([bendAt(70, { side: 1 })]), []);
    const b = bodyBounds(r.bodies[0]!);
    const ba = bendAllowance(90, 2, 2, kFactor(2, 2));
    // The 70 mm side folded up instead.
    expect(b.max.z).toBeCloseTo(4 + (70 - ba / 2), 3);
  });
});

describe("several bends", () => {
  it("U channel: two flanges up, parallel", () => {
    const r = rebuild(sheetPart([bendAt(20, { side: 1 }), bendAt(80, { side: -1 })]), []);
    expect(r.status.get("Sheet001")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    const b = bodyBounds(r.bodies[0]!);
    const ba = bendAllowance(90, 2, 2, kFactor(2, 2));
    expect(b.max.z).toBeCloseTo(4 + (20 - ba / 2), 3);
    // Symmetric about x = 50.
    expect(b.min.x + b.max.x).toBeCloseTo(100, 3);
  });

  it("Z bracket: a bend inside a flange folds with it", () => {
    const r = rebuild(sheetPart([bendAt(30, { side: -1 }), bendAt(70, { side: -1, dir: "down" })]), []);
    expect(r.status.get("Sheet001")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    const b = bodyBounds(r.bodies[0]!);
    // The last flange points along +x again, at the top of the riser.
    expect(b.max.x).toBeGreaterThan(30);
    expect(b.max.z).toBeGreaterThan(30);
  });

  it("errors: line outside the blank, flange too short, bad angle", () => {
    const outside: SheetBendData = { line: [{ x: 150, y: 0 }, { x: 150, y: -50 }], side: 1, dir: "up", angle: "90" };
    expect(rebuild(sheetPart([outside]), []).status.get("Sheet001")?.error).toMatch(/isn't across the blank/);
    expect(rebuild(sheetPart([bendAt(99.5)]), []).status.get("Sheet001")?.error).toMatch(/too short/);
    expect(rebuild(sheetPart([bendAt(70, { angle: "200" })]), []).status.get("Sheet001")?.error).toMatch(/angle/);
  });
});

describe("slanted blank edges", () => {
  // The uploaded trapezoid (closed), bend lines across it between the slanted sides.
  const trap = (extra: Entity[]): Record<string, unknown>[] =>
    [L([188.5, -175], [452.5, -175]), L([452.5, -175], [641, 0]), L([641, 0], [0, 0]), L([0, 0], [188.5, -175]), ...extra].map((e) => e.serialize());
  const xAt = (y: number, left: boolean): number => (left ? (188.5 * -y) / 175 : 641 - ((641 - 452.5) * -y) / 175);
  const bend = (y: number, side: 1 | -1): SheetBendData => ({ line: [{ x: xAt(y, true), y }, { x: xAt(y, false), y }], side, dir: "up", angle: "90" });

  it("the bend is as wide as the blank at each point across it (follows the slant)", () => {
    const regions = findProfiles(parseEntities(trap([])).entities).regions;
    expect(regions).toHaveLength(1);
    // Plane-local (y up): a line along +x at local y = 30 + x0; the trapezoid is 641 wide at y=0, 264 at y=175.
    for (const y of [27, 30, 33]) {
      const [lo, hi] = chordAt(regions, { x: 300, y }, { x: 1, y: 0 }, [-100, 100]);
      const width = 641 - ((641 - 264) * y) / 175;
      expect(hi - lo).toBeCloseTo(width, 6);
      expect(300 + lo).toBeCloseTo((188.5 * y) / 175, 6);
    }
  });

  it("a slanted-side part folds into one solid, volume kept with K = 0.5", () => {
    const bends = [bend(-30, 1), bend(-145, -1)];
    const ents = trap(bends.map((b) => L([b.line[0].x, b.line[0].y], [b.line[1].x, b.line[1].y])));
    // R = 5T -> DIN 6935 K = 0.5: the neutral fibre is mid-thickness, so the folded part keeps the flat volume.
    const part = sheetPart(bends, { thickness: "2", radius: "10" }, ents);
    const r = rebuild(part, []);
    expect(r.status.get("Sheet001")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    const flatArea = ((264 + 641) / 2) * 175;
    // Slices step the slanted ends a little: within 0.3 %.
    expect(Math.abs(vol(r.bodies[0]!) - flatArea * 2) / (flatArea * 2)).toBeLessThan(3e-3);
  });
});

describe("holes and other features on a sheet", () => {
  it("a circle in the blank is a hole that folds with its flange", () => {
    const withHole = blank([L([70, 0], [70, -50]), new Circle({ x: 90, y: -25 }, 4)]);
    const r = rebuild(sheetPart([bendAt(70, { side: -1 })], {}, withHole), []);
    expect(r.status.get("Sheet001")).toEqual({ ok: true });
    const cyl = r.bodies[0]!.faces.find((f) => f.geom.kind === "cylinder" && Math.abs(f.geom.radius - 4) < 1e-6);
    expect(cyl).toBeDefined();
    // On the vertical flange: its axis is horizontal (along x).
    const g = cyl!.geom;
    expect(g.kind === "cylinder" && Math.abs(g.axis.z)).toBeLessThan(1e-6);
  });

  it("a flange face keeps its ref through an angle change (Hole / sketch on it find it)", () => {
    const r = rebuild(sheetPart([bendAt(70, { side: -1 })]), []);
    const outer = r.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.x > 0.99 && f.ref.index.startsWith("f1:"))!;
    expect(outer).toBeDefined();
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: outer.ref, centers: [{ x: 25, y: 15 }], diameter: "5", depth: "2", style: "plain", extent: "through" };
    const p90 = sheetPart([bendAt(70, { side: -1 })]);
    p90.features.push(hole);
    expect(rebuild(p90, []).status.get("Hole001")).toEqual({ ok: true });
    // At 60° the same ref names the flange's outer face, now tilted 30° off vertical.
    const r60 = rebuild(sheetPart([bendAt(70, { side: -1, angle: "60" })]), []);
    const again = r60.bodies[0]!.faces.find((f) => f.ref.feature === outer.ref.feature && f.ref.index === outer.ref.index)!;
    expect(again).toBeDefined();
    expect(again.geom.kind === "plane" && again.geom.normal.x).toBeCloseTo(Math.cos(Math.PI / 6));
  });

  it("saves and loads", () => {
    const p = sheetPart([bendAt(70, { side: -1, dir: "down", angle: "45" })], { flat: true });
    const back = parsePart(JSON.parse(JSON.stringify(p)))!;
    expect(back.features[0]).toEqual({ ...p.features[0], suppressed: false });
  });
});
