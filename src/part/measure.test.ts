import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { rebuild } from "./rebuild";
import { edgeAngle, edgeMeasure, faceAngle, faceMeasure, pointDistance } from "./measure";
import { emptyPart } from "./types";
import type { HoleFeature, PartData } from "./types";
import type { Face } from "./kernel/types";

// An 80 x 40 x 10 plate.
const PLATE = [
  new Line({ x: 0, y: 0 }, { x: 80, y: 0 }),
  new Line({ x: 80, y: 0 }, { x: 80, y: -40 }),
  new Line({ x: 80, y: -40 }, { x: 0, y: -40 }),
  new Line({ x: 0, y: -40 }, { x: 0, y: 0 }),
].map((e) => e.serialize());
const part = (): PartData => ({ ...emptyPart(), features: [{ id: "E1", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" }] });
const flat = (faces: Face[], nx: number, ny: number, nz: number): Face =>
  faces.find((f) => f.geom.kind === "plane" && Math.abs(f.geom.normal.x - nx) < 1e-9 && Math.abs(f.geom.normal.y - ny) < 1e-9 && Math.abs(f.geom.normal.z - nz) < 1e-9)!;

describe("Measure", () => {
  const r = rebuild(part(), PLATE);
  const body = r.bodies[0]!;
  const top = flat(body.faces, 0, 0, 1);
  const bottom = flat(body.faces, 0, 0, -1);
  const side = body.faces.find((f) => f.geom.kind === "plane" && Math.abs(f.geom.normal.z) < 1e-9)!;

  it("angle between faces: top / side 90°, top / bottom parallel with the gap", () => {
    expect(faceAngle(top, side)).toMatchObject({ planes: expect.closeTo(90, 9), between: expect.closeTo(90, 9) });
    const tb = faceAngle(top, bottom);
    expect(typeof tb !== "string" && tb.planes).toBeCloseTo(0);
    expect(typeof tb !== "string" && tb.gap).toBeCloseTo(10);
  });

  it("angle against a 45° slanted face", () => {
    const slanted: Face = { id: 99, ref: top.ref, geom: { kind: "plane", origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 } } };
    const a = faceAngle(top, slanted);
    expect(typeof a !== "string" && a.planes).toBeCloseTo(45);
    expect(typeof a !== "string" && a.between).toBeCloseTo(135);
  });

  it("edges: length, angle; point distance; face area", () => {
    const lines = body.edges.filter((e) => e.geom.kind === "line");
    const lens = lines.map((e) => (edgeMeasure(e) as { length: number }).length).sort((a, b) => a - b);
    expect(lens[0]).toBeCloseTo(10);
    expect(lens[lens.length - 1]).toBeCloseTo(80);
    const long = lines.find((e) => Math.abs((edgeMeasure(e) as { length: number }).length - 80) < 1e-6)!;
    const short = lines.find((e) => Math.abs((edgeMeasure(e) as { length: number }).length - 40) < 1e-6)!;
    expect(edgeAngle(long, short)).toBeCloseTo(90);
    expect(pointDistance({ x: 0, y: 0, z: 0 }, { x: 80, y: 40, z: 10 }).distance).toBeCloseTo(Math.hypot(80, 40, 10));
    expect(faceMeasure(body, top).area).toBeCloseTo(3200);
  });

  it("a hole: circle edge radius and round face radius", () => {
    const hole: HoleFeature = { id: "H1", type: "hole", face: top.ref, centers: [{ x: 10, y: 10 }], diameter: "8", depth: "5", style: "plain", extent: "through" };
    const r2 = rebuild({ ...part(), features: [...part().features, hole] }, PLATE);
    const b = r2.bodies[0]!;
    const rim = b.edges.find((e) => e.geom.kind === "arc")!;
    expect(edgeMeasure(rim)).toMatchObject({ kind: "arc", radius: expect.closeTo(4, 6), diameter: expect.closeTo(8, 6) });
    const cyl = b.faces.find((f) => f.geom.kind === "cylinder")!;
    expect(faceMeasure(b, cyl).radius).toBeCloseTo(4);
  });
});
