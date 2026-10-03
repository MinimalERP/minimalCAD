import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import type { Entity } from "../entities/entity";
import { bodyBounds } from "./kernel/brep";
import { rebuild } from "./rebuild";
import { emptyPart } from "./types";
import type { PartData, RotateFeature } from "./types";

const rect = (x0: number, y0: number, x1: number, y1: number): Entity[] => [
  new Line({ x: x0, y: y0 }, { x: x1, y: y0 }),
  new Line({ x: x1, y: y0 }, { x: x1, y: y1 }),
  new Line({ x: x1, y: y1 }, { x: x0, y: y1 }),
  new Line({ x: x0, y: y1 }, { x: x0, y: y0 }),
];

describe("Rotate picks one solid", () => {
  it("one extrude of two separate squares: turning one leaves the other", () => {
    const p: PartData = { ...emptyPart(), features: [{ id: "E1", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" }] };
    const D2 = [...rect(0, 0, 20, -20), ...rect(40, 0, 60, -20)].map((e) => e.serialize());
    const before = rebuild(p, D2);
    expect(before.bodies).toHaveLength(1);
    const yMid = (bodyBounds(before.bodies[0]!).min.y + bodyBounds(before.bodies[0]!).max.y) / 2;
    const rot: RotateFeature = { id: "R", type: "rotate", angle: "90", axis: "Z", pieces: [{ feature: "E1", at: { x: 50, y: yMid, z: 10 } }] };
    const r = rebuild({ ...p, features: [...p.features, rot] }, D2);
    expect(r.status.get("R")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(2);
    const xs = r.bodies.map((b) => bodyBounds(b)).map((b) => [Math.round(b.min.x), Math.round(b.max.x)]);
    expect(xs).toContainEqual([0, 20]); // the untouched square
  });
});
