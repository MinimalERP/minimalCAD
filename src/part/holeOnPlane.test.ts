import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { planeRef } from "./kernel/types";
import { rebuild } from "./rebuild";
import { emptyPart } from "./types";
import type { HoleFeature, PartData } from "./types";
import type { Body } from "./kernel/types";

const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const FACET = Math.sin((2 * Math.PI) / 72) / ((2 * Math.PI) / 72);
const base = (distance: string): PartData => ({
  ...emptyPart(),
  features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance, direction: "normal", operation: "new" }],
});

describe("a hole on a work plane", () => {
  it("drills from the plane's front, square to it: a plane above a block", () => {
    const ents = drawing([
      new Line({ x: 0, y: 0 }, { x: 60, y: 0 }),
      new Line({ x: 60, y: 0 }, { x: 60, y: -40 }),
      new Line({ x: 60, y: -40 }, { x: 0, y: -40 }),
      new Line({ x: 0, y: -40 }, { x: 0, y: 0 }),
    ]);
    const p = base("10");
    const v0 = volume(rebuild(p, ents).bodies[0]!);
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: planeRef("WorkPlane001"), centers: [{ x: 30, y: 20 }], diameter: "10", depth: "5", style: "plain", extent: "through" };
    const planes: PartData["planes"] = [{ id: "WorkPlane001", base: "XY", offset: "25", angle: "0", axis: "u" }];
    const r = rebuild({ ...p, planes, features: [...p.features, hole] }, ents);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    expect(v0 - volume(r.bodies[0]!)).toBeCloseTo(Math.PI * 25 * 10 * FACET, 1);
    const bore = r.bodies[0]!.faces.find((f) => f.geom.kind === "cylinder")!.geom;
    expect(bore.kind === "cylinder" && [Math.round(bore.axisOrigin.x), Math.round(bore.axisOrigin.y)]).toEqual([30, 20]);
    // A blind one is measured from the plane: 20 deep from z = 25 reaches z = 5, into the block's top half only.
    const blind = rebuild({ ...p, planes, features: [...p.features, { ...hole, extent: undefined, depth: "20" }] }, ents);
    expect(blind.status.get("Hole001")).toEqual({ ok: true });
    const removed = v0 - volume(blind.bodies[0]!);
    expect(removed).toBeGreaterThan(Math.PI * 25 * 5 * FACET);
    expect(removed).toBeLessThan(Math.PI * 25 * 10 * FACET);
    // No such plane: reported, the block is left alone.
    const lost = rebuild({ ...p, features: [...p.features, hole] }, ents);
    expect(lost.status.get("Hole001")?.error).toMatch(/work plane/);
    expect(volume(lost.bodies[0]!)).toBeCloseTo(v0, 6);
  });

  it("on a plane tangent to a shaft: a cross hole, straight at the axis", () => {
    const ents = drawing([new Circle({ x: 0, y: 0 }, 15)]);
    const p = base("80");
    const shaft = rebuild(p, ents).bodies[0]!;
    const round = shaft.faces.find((f) => f.geom.kind === "cylinder")!;
    const planes: PartData["planes"] = [{ id: "WorkPlane001", base: "XY", offset: "0", angle: "0", axis: "u", on: { face: round.ref, tangent: true } }];
    // Sketch coordinates on a tangent plane: x along the shaft, measured from the model origin.
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: planeRef("WorkPlane001"), centers: [{ x: 40, y: 0 }], diameter: "6", depth: "5", style: "plain", extent: "through" };
    const r = rebuild({ ...p, planes, features: [...p.features, hole] }, ents);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    const bore = r.bodies[0]!.faces.find((f) => f.geom.kind === "cylinder" && f.geom.radius === 3)!.geom;
    // Its axis runs along X (the plane's normal at 0 degrees) and crosses the shaft's at mid height.
    expect(bore.kind === "cylinder" && Math.abs(bore.axis.x)).toBeCloseTo(1);
    expect(bore.kind === "cylinder" && Math.abs(bore.axisOrigin.z)).toBeCloseTo(40);
    expect(bore.kind === "cylinder" && bore.axisOrigin.y).toBeCloseTo(0);
    expect(volume(shaft) - volume(r.bodies[0]!)).toBeGreaterThan(Math.PI * 9 * 28);
  });
});
