import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { bodyBounds } from "./kernel/brep";
import type { Body } from "./kernel/types";
import { rebuild } from "./rebuild";
import { axisEdgeRef, axisEdges } from "./rotateBody";
import { emptyPart, parsePart } from "./types";
import type { FeatureData, HoleFeature, PartData, RotateFeature } from "./types";

const rect = (x0: number, y0: number, x1: number, y1: number): Entity[] => [
  new Line({ x: x0, y: y0 }, { x: x1, y: y0 }),
  new Line({ x: x1, y: y0 }, { x: x1, y: y1 }),
  new Line({ x: x1, y: y1 }, { x: x0, y: y1 }),
  new Line({ x: x0, y: y1 }, { x: x0, y: y0 }),
];
const PLATE = rect(0, 0, 80, -40).map((e) => e.serialize());
const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const base = (): PartData => ({
  ...emptyPart(),
  features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" }],
});
const build = (extra: FeatureData[]): ReturnType<typeof rebuild> => {
  const p = base();
  return rebuild({ ...p, features: [...p.features, ...extra] }, PLATE);
};
const rotate = (f: Partial<RotateFeature>): RotateFeature => ({ id: "Rotate001", type: "rotate", angle: "90", ...f });

describe("Rotate Body", () => {
  const before = build([]);
  const b0 = bodyBounds(before.bodies[0]!);

  it("turns every body about an origin axis, keeping its volume", () => {
    const r = build([rotate({ axis: "Z" })]);
    expect(r.status.get("Rotate001")).toEqual({ ok: true });
    const b = bodyBounds(r.bodies[0]!);
    // (x, y) -> (-y, x)
    expect(b.min.x).toBeCloseTo(-b0.max.y);
    expect(b.max.x).toBeCloseTo(-b0.min.y);
    expect(b.min.y).toBeCloseTo(b0.min.x);
    expect(b.max.y).toBeCloseTo(b0.max.x);
    expect(volume(r.bodies[0]!)).toBeCloseTo(volume(before.bodies[0]!), 6);
  });

  it("turns about a picked straight edge, and follows it", () => {
    // The long bottom edge along X at the plate's min y.
    const edge = axisEdges(before.bodies[0]!).find(
      (e) => Math.abs(e.a.z) < 1e-9 && Math.abs(e.b.z) < 1e-9 && Math.abs(e.a.y - b0.min.y) < 1e-9 && Math.abs(e.b.y - b0.min.y) < 1e-9,
    )!;
    expect(edge).toBeDefined();
    const r = build([rotate({ axisEdge: axisEdgeRef(edge), angle: "90" })]);
    expect(r.status.get("Rotate001")).toEqual({ ok: true });
    const b = bodyBounds(r.bodies[0]!);
    // Stood up on that edge: 40 tall, 10 deep.
    expect(b.max.z - b.min.z).toBeCloseTo(b0.max.y - b0.min.y);
    expect(b.max.y - b.min.y).toBeCloseTo(10);
  });

  it("turns about a round face's axis", () => {
    const top = before.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: top.ref, centers: [{ x: 10, y: 10 }], diameter: "8", depth: "5", style: "plain", extent: "through" };
    const withHole = build([hole]);
    const cyl = withHole.bodies[0]!.faces.find((f) => f.geom.kind === "cylinder")!;
    expect(cyl.geom.kind).toBe("cylinder");
    const ax = cyl.geom.kind === "cylinder" ? cyl.geom.axisOrigin : { x: 0, y: 0, z: 0 };
    const r = build([hole, rotate({ axisFace: cyl.ref, angle: "180" })]);
    expect(r.status.get("Rotate001")).toEqual({ ok: true });
    const b = bodyBounds(r.bodies[0]!);
    expect(b.min.x).toBeCloseTo(2 * ax.x - b0.max.x);
    expect(b.max.x).toBeCloseTo(2 * ax.x - b0.min.x);
  });

  it("keeps face refs: a later hole on the turned top face still works", () => {
    const top = before.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: top.ref, centers: [{ x: 10, y: 10 }], diameter: "8", depth: "5", style: "plain", extent: "through" };
    const r = build([rotate({ axis: "X", angle: "30" }), hole]);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    expect(volume(r.bodies[0]!)).toBeLessThan(volume(before.bodies[0]!));
  });

  it("reports a bad angle and survives save / load", () => {
    expect(build([rotate({ angle: "nope" })]).status.get("Rotate001")?.ok).toBe(false);
    const edge = axisEdges(before.bodies[0]!)[0]!;
    const f = rotate({ bodies: ["Extrude001"], axisEdge: axisEdgeRef(edge), angle: "d1*2" });
    const parsed = parsePart(JSON.parse(JSON.stringify({ ...base(), features: [f] })));
    expect(parsed?.features[0]).toEqual({ ...f, suppressed: false });
  });
});
