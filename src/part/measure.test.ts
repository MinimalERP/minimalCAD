import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { rebuild } from "./rebuild";
import { betweenMeasure, edgeAngle, edgeMeasure, faceAngle, faceMeasure, pointDistance, solidMeasure } from "./measure";
import type { BetweenMeasure } from "./measure";
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

  it("between: parallel faces, parallel edges, faces that meet", () => {
    expect(betweenMeasure(top, bottom)).toMatchObject({ distance: expect.closeTo(10, 9), toCentre: false });
    expect(typeof betweenMeasure(top, side)).toBe("string");
    const long = body.edges.filter((e) => e.geom.kind === "line" && Math.abs((edgeMeasure(e) as { length: number }).length - 80) < 1e-6);
    const ds = long.slice(1).map((e) => (betweenMeasure(long[0]!, e) as { distance: number }).distance).sort((a, b) => a - b);
    expect(ds[0]).toBeCloseTo(10);
    expect(ds[ds.length - 1]).toBeCloseTo(Math.hypot(40, 10));
    // An edge against the face it runs along the far side of.
    const onTop = long.find((e) => e.geom.kind === "line" && Math.abs(e.geom.a.z - 10) < 1e-9)!;
    expect(betweenMeasure(bottom, onTop)).toMatchObject({ distance: expect.closeTo(10, 9) });
  });

  it("between: two holes' centre distance and the wall between, a hole to a side face", () => {
    const hole: HoleFeature = { id: "H1", type: "hole", face: top.ref, centers: [{ x: 10, y: 10 }, { x: 40, y: 10 }], diameter: "8", depth: "5", style: "plain", extent: "through" };
    const b = rebuild({ ...part(), features: [...part().features, hole] }, PLATE).bodies[0]!;
    const [c1, c2] = b.faces.filter((f) => f.geom.kind === "cylinder");
    expect(betweenMeasure(c1!, c2!)).toMatchObject({ distance: expect.closeTo(30, 6), gap: expect.closeTo(22, 6), toCentre: true });
    const rims = b.edges.filter((e) => e.geom.kind === "arc");
    const far = Math.max(...rims.map((e) => (betweenMeasure(rims[0]!, e) as { distance: number }).distance));
    expect(far).toBeCloseTo(Math.hypot(30, 10)); // across to the other hole's rim on the other side
    const dists = b.faces.filter((f) => f.geom.kind === "plane" && Math.abs(f.geom.normal.z) < 1e-9).map((f) => (betweenMeasure(c1!, f) as BetweenMeasure).distance);
    expect(Math.min(...dists)).toBeCloseTo(10);
    expect(typeof betweenMeasure(c1!, flat(b.faces, 0, 0, 1))).toBe("string"); // the hole runs through the top face
  });

  it("solid: volume, surface, overall size, centre", () => {
    const m = solidMeasure(body);
    expect(m.volume).toBeCloseTo(32000);
    expect(m.area).toBeCloseTo(2 * (3200 + 800 + 400));
    expect([m.size.x, m.size.y, m.size.z].sort((a, b) => a - b)).toEqual([expect.closeTo(10, 6), expect.closeTo(40, 6), expect.closeTo(80, 6)]);
    expect(m.centre.z).toBeCloseTo(5);
    expect(Math.abs(m.centre.x)).toBeCloseTo(40);
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
