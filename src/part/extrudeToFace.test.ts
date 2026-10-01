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
const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const XY = planeFrame({ base: "XY", offset: 0 });
const NONE = { tanTaper: 0, shear: { x: 0, y: 0 }, square: false };
const FACET = Math.sin((2 * Math.PI) / 72) / ((2 * Math.PI) / 72);
const zRange = (b: Body): [number, number] => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < b.mesh.positions.length; i += 3) {
    lo = Math.min(lo, b.mesh.positions[i]!);
    hi = Math.max(hi, b.mesh.positions[i]!);
  }
  return [lo, hi];
};

describe("extrude up to a plane", () => {
  const square = findProfiles(rect(0, 0, 20, -20)).regions;

  it("a level plane above: a plain block of that height", () => {
    const b = extrudeShaped("E", square, XY, 0, 1, { ...NONE, upTo: { origin: { x: 0, y: 0, z: 12 }, normal: { x: 0, y: 0, z: -1 } } });
    expect(typeof b).toBe("object");
    if (typeof b === "string") return;
    expect(volume(b)).toBeCloseTo(400 * 12, 6);
    expect(zRange(b)).toEqual([0, 12]);
    const end = b.faces.find((f) => f.ref.role === "end")!.geom;
    expect(end.kind === "plane" && end.normal.z).toBeCloseTo(1); // outward, whatever way the target face looked
  });

  it("a sloped plane: the end lies in it, each corner at its own height", () => {
    // z = 10 + x / 2 over x 0..20 -> heights 10..20, mean 15.
    const n = { x: -0.5, y: 0, z: 1 };
    const b = extrudeShaped("E", square, XY, 0, 1, { ...NONE, upTo: { origin: { x: 0, y: 0, z: 10 }, normal: n } });
    expect(typeof b).toBe("object");
    if (typeof b === "string") return;
    expect(volume(b)).toBeCloseTo(400 * 15, 6);
    expect(zRange(b)[1]).toBeCloseTo(20);
    expect(b.faces.every((f) => f.geom.kind === "plane")).toBe(true);
    // A round boss up to a slope keeps its true cylinder; its top rim is no circle.
    const round = extrudeShaped("E", findProfiles([new Circle({ x: 10, y: -10 }, 5)]).regions, XY, 0, 1, { ...NONE, upTo: { origin: { x: 0, y: 0, z: 10 }, normal: n } });
    if (typeof round === "string") throw new Error(round);
    expect(round.faces.some((f) => f.geom.kind === "cylinder")).toBe(true);
    expect(round.edges.find((e) => e.ref.role === "end")!.geom.kind).toBe("polyline");
    expect(round.edges.find((e) => e.ref.role === "start")!.geom.kind).toBe("arc");
    expect(volume(round)).toBeCloseTo(Math.PI * 25 * 15 * FACET, 3);
  });

  it("a plane below works too; one square to the sketch, or cutting across it, is refused", () => {
    const below = extrudeShaped("E", square, XY, 0, 1, { ...NONE, upTo: { origin: { x: 0, y: 0, z: -8 }, normal: { x: 0, y: 0, z: 1 } } });
    if (typeof below === "string") throw new Error(below);
    expect(volume(below)).toBeCloseTo(400 * 8, 6);
    expect(zRange(below)).toEqual([-8, 0]);
    expect(extrudeShaped("E", square, XY, 0, 1, { ...NONE, upTo: { origin: { x: 50, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } } })).toMatch(/never reach/);
    expect(extrudeShaped("E", square, XY, 0, 1, { ...NONE, upTo: { origin: { x: 10, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 1 } } })).toMatch(/cuts across/);
    expect(extrudeShaped("E", square, XY, 0, 1, { ...NONE, upTo: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } } })).toMatch(/already lies/);
  });
});

describe("Extrude feature: to face", () => {
  // A plate on the ground and a second block floating 20 above it; a boss from the plate's top up to the block's underside.
  const sketch = (id: string, offset: number, e: Entity[]): PartData["sketches"][number] => ({ id, plane: { base: "XY", offset }, entities: drawing(e), constraints: [] });
  const base = (gap: string): PartData => ({
    ...emptyPart(),
    parameters: [{ name: "gap", expr: gap }],
    planes: [{ id: "WorkPlane001", base: "XY", offset: "10+gap", angle: "0", axis: "u" }],
    sketches: [
      { id: "Sketch001", plane: { base: "WorkPlane001", offset: 0 }, entities: drawing(rect(0, 0, 40, -40)), constraints: [] },
      sketch("Sketch002", 10, [new Circle({ x: 20, y: -20 }, 6)]),
    ],
    features: [
      { id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" },
      { id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "10", direction: "normal", operation: "new" },
    ],
  });
  const ENTS = drawing(rect(0, 0, 40, -40));

  it("the boss fills the gap exactly, and still does when the gap changes", () => {
    const first = rebuild(base("20"), ENTS);
    expect(first.bodies).toHaveLength(2);
    const underside = first.bodies[1]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z < -0.9)!;
    const boss: ExtrudeFeature = { id: "Extrude003", type: "extrude", sketch: "Sketch002", profiles: "all", distance: "10", direction: "normal", operation: "join", extent: "toFace", toFace: underside.ref };
    for (const [gap, height] of [["20", 20], ["35", 35]] as const) {
      const p = base(gap);
      const r = rebuild({ ...p, features: [...p.features, boss] }, ENTS);
      expect(r.status.get("Extrude003")).toEqual({ ok: true });
      expect(r.bodies).toHaveLength(1); // it bridges plate and block into one solid
      expect(volume(r.bodies[0]!)).toBeCloseTo(2 * 16000 + Math.PI * 36 * height * FACET, 1);
    }
    const p = base("20");
    const gone: ExtrudeFeature = { ...boss, toFace: { ...underside.ref, feature: "Nope" } };
    expect(rebuild({ ...p, features: [...p.features, gone] }, ENTS).status.get("Extrude003")?.error).toMatch(/no longer exists/);
    expect(parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), features: [boss] })))!.features[0]).toEqual({ ...boss, suppressed: false });
  });
});
