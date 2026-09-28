import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Polyline } from "../entities/polyline";
import type { Entity } from "../entities/entity";
import { findProfiles } from "./profile";
import { extrudeRegions, meshVolume } from "./kernel/extrude";
import { faceFrame, localTo3d, planeFrame, toLocal, workPlaneFrame } from "./plane";
import { evalExpression, resolveParameters } from "./params";
import { rebuild } from "./rebuild";
import { emptyPart, nextId, parsePart } from "./types";
import type { PartData } from "./types";
import type { Body } from "./kernel/types";

const rectLines = (w: number, h: number): Entity[] => [
  new Line({ x: 0, y: 0 }, { x: w, y: 0 }),
  new Line({ x: w, y: 0 }, { x: w, y: h }),
  new Line({ x: 0, y: h }, { x: w, y: h }), // deliberately reversed
  new Line({ x: 0, y: h }, { x: 0, y: 0 }),
];

/** Every undirected edge (welded by position) is shared by exactly two
 *  triangles, in opposite directions -- a closed, consistently wound mesh. */
function isWatertight(body: Body): boolean {
  const { positions, indices } = body.mesh;
  const key = (i: number): string =>
    [0, 1, 2].map((k) => Math.round(positions[i * 3 + k]! * 1e4)).join(",");
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

describe("plane frames", () => {
  it("maps the Y-down sketch 'up' to +v on every base plane", () => {
    const up = toLocal({ x: 0, y: -10 }); // drawn upward on screen
    expect(localTo3d(planeFrame({ base: "XY", offset: 0 }), up)).toEqual({ x: 0, y: 10, z: 0 });
    expect(localTo3d(planeFrame({ base: "XZ", offset: 0 }), up)).toEqual({ x: 0, y: 0, z: 10 });
    expect(localTo3d(planeFrame({ base: "YZ", offset: 0 }), up)).toEqual({ x: 0, y: 0, z: 10 });
  });

  it("frames are right-handed (u x v = n) and offset along n", () => {
    for (const base of ["XY", "XZ", "YZ"] as const) {
      const f = planeFrame({ base, offset: 5 });
      const c = { x: f.u.y * f.v.z - f.u.z * f.v.y, y: f.u.z * f.v.x - f.u.x * f.v.z, z: f.u.x * f.v.y - f.u.y * f.v.x };
      expect(c.x).toBeCloseTo(f.n.x);
      expect(c.y).toBeCloseTo(f.n.y);
      expect(c.z).toBeCloseTo(f.n.z);
      expect(f.origin).toEqual({ x: f.n.x * 5, y: f.n.y * 5, z: f.n.z * 5 });
    }
  });
});

describe("findProfiles", () => {
  it("chains 4 loose lines (any direction) into one CCW region", () => {
    const { regions, openChains } = findProfiles(rectLines(100, 50));
    expect(openChains).toBe(0);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(5000);
    expect(regions[0]!.outer.area).toBeGreaterThan(0);
  });

  it("accepts a closed polyline rectangle", () => {
    const rect = new Polyline(
      [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }].map((point) => ({ point, bulge: 0 })),
      true,
    );
    expect(findProfiles([rect]).regions[0]!.area).toBeCloseTo(800);
  });

  it("a circle alone is a region", () => {
    const { regions } = findProfiles([new Circle({ x: 0, y: 0 }, 10)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(Math.PI * 100, 0);
  });

  it("a circle inside a rectangle becomes a hole", () => {
    const { regions } = findProfiles([...rectLines(100, 50), new Circle({ x: 50, y: 25 }, 10)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.holes).toHaveLength(1);
    expect(regions[0]!.holes[0]!.area).toBeLessThan(0);
    expect(regions[0]!.area).toBeCloseTo(5000 - Math.PI * 100, 0);
  });

  it("an island inside a hole is its own region", () => {
    const { regions } = findProfiles([
      new Circle({ x: 0, y: 0 }, 30),
      new Circle({ x: 0, y: 0 }, 20),
      new Circle({ x: 0, y: 0 }, 10),
    ]);
    expect(regions).toHaveLength(2);
  });

  it("rejects an open chain", () => {
    const { regions, openChains } = findProfiles(rectLines(10, 10).slice(0, 3));
    expect(regions).toHaveLength(0);
    expect(openChains).toBe(1);
  });

  it("chains lines and an arc into a slot-like loop", () => {
    // D-shape: line along the bottom, semicircle over the top (Y-down world, so "top" is y<0).
    const arc = new Arc({ x: 10, y: 0 }, 10, Math.PI, 2 * Math.PI);
    const { regions } = findProfiles([new Line({ x: 0, y: 0 }, { x: 20, y: 0 }), arc]);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo((Math.PI * 100) / 2, 0);
  });
});

describe("extrude", () => {
  it("produces a watertight box with volume = area x height", () => {
    const { regions } = findProfiles(rectLines(100, 50));
    const body = extrudeRegions("E", regions, planeFrame({ base: "XY", offset: 0 }), 0, 20);
    expect(isWatertight(body)).toBe(true);
    expect(meshVolume(body.mesh.positions, body.mesh.indices)).toBeCloseTo(100000, 3);
    // 4 bottom + 4 top + 4 vertical edges, all exact lines.
    expect(body.edges).toHaveLength(12);
    expect(body.faces).toHaveLength(6);
  });

  it("plate with a hole: watertight, positive volume, exact circle edges", () => {
    const { regions } = findProfiles([...rectLines(100, 50), new Circle({ x: 50, y: 25 }, 10)]);
    const body = extrudeRegions("E", regions, planeFrame({ base: "XZ", offset: 0 }), 0, 10);
    expect(isWatertight(body)).toBe(true);
    const vol = meshVolume(body.mesh.positions, body.mesh.indices);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeCloseTo((5000 - Math.PI * 100) * 10, -2); // tessellation within 0.5%
    const arcs = body.edges.filter((e) => e.geom.kind === "arc");
    expect(arcs).toHaveLength(2);
    for (const e of arcs) if (e.geom.kind === "arc") expect(e.geom.radius).toBe(10);
    // Cylinder face is exact too.
    const cyl = body.faces.find((f) => f.geom.kind === "cylinder");
    expect(cyl?.geom.kind === "cylinder" && cyl.geom.radius).toBe(10);
  });

  it("works on YZ and for a D-shape with an arc wall", () => {
    const arc = new Arc({ x: 10, y: 0 }, 10, Math.PI, 2 * Math.PI);
    const { regions } = findProfiles([new Line({ x: 0, y: 0 }, { x: 20, y: 0 }), arc]);
    const body = extrudeRegions("E", regions, planeFrame({ base: "YZ", offset: 0 }), -5, 5);
    expect(isWatertight(body)).toBe(true);
    expect(meshVolume(body.mesh.positions, body.mesh.indices)).toBeGreaterThan(0);
  });
});

describe("params + rebuild", () => {
  it("evaluates parameter expressions and rejects unknown names", () => {
    const values = resolveParameters([
      { name: "d1", expr: "50" },
      { name: "d2", expr: "d1*2+5" },
    ]);
    expect(values.get("d2")).toBe(105);
    expect(evalExpression("d2/5", values)).toBe(21);
    expect(evalExpression("nope+1", values)).toBeNull();
  });

  function platePart(distance: string): PartData {
    const part = emptyPart();
    part.parameters.push({ name: "t", expr: "8" });
    part.sketches.push({
      id: nextId(part, "Sketch"),
      plane: { base: "XY", offset: 0 },
      entities: rectLines(100, 50).map((e) => e.serialize()),
      constraints: [],
    });
    part.features.push({
      id: nextId(part, "Extrude"),
      type: "extrude",
      sketch: "Sketch001",
      profiles: "all",
      distance,
      direction: "normal",
      operation: "new",
    });
    return part;
  }

  it("rebuild reflects a parameter change", () => {
    const part = platePart("t*2");
    let result = rebuild(part);
    expect(result.status.get("Extrude001")).toEqual({ ok: true });
    expect(meshVolume(result.bodies[0]!.mesh.positions, result.bodies[0]!.mesh.indices)).toBeCloseTo(80000, 2);
    part.parameters[0]!.expr = "10";
    result = rebuild(part);
    expect(meshVolume(result.bodies[0]!.mesh.positions, result.bodies[0]!.mesh.indices)).toBeCloseTo(100000, 2);
  });

  it("a bad feature reports an error instead of throwing", () => {
    const result = rebuild(platePart("oops"));
    expect(result.bodies).toHaveLength(0);
    expect(result.status.get("Extrude001")?.ok).toBe(false);
  });

  it("profile seed points pick one region", () => {
    const part = platePart("5");
    part.sketches[0]!.entities.push(new Circle({ x: 300, y: 0 }, 10).serialize());
    part.features[0]!.profiles = [{ x: 300, y: 0 }];
    const body = rebuild(part).bodies[0]!;
    expect(meshVolume(body.mesh.positions, body.mesh.indices)).toBeCloseTo(Math.PI * 100 * 5, -1);
  });

  it("parsePart survives a JSON round-trip and drops junk", () => {
    const part = platePart("t");
    const parsed = parsePart(JSON.parse(JSON.stringify({ ...part, features: [...part.features, { junk: 1 }] })));
    expect(parsed?.features).toHaveLength(1);
    expect(parsed?.sketches[0]!.entities).toHaveLength(4);
    expect(parsePart("nope")).toBeNull();
  });
});

describe("2D drawing as the XY base sketch", () => {
  const rect = (x: number, y: number): Record<string, unknown> =>
    new Polyline(
      [
        { x, y },
        { x: x + 40, y },
        { x: x + 40, y: y + 20 },
        { x, y: y + 20 },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    ).serialize();

  function drawingPart(): PartData {
    const part = emptyPart();
    part.features.push({
      id: "Extrude001",
      type: "extrude",
      sketch: "Drawing",
      profiles: [{ x: 20, y: 10, area: 800 }],
      distance: "5",
      direction: "normal",
      operation: "new",
    });
    return part;
  }

  it("extrudes a shape drawn in the 2D workspace, upward along +Z", () => {
    const result = rebuild(drawingPart(), [rect(0, 0)]);
    expect(result.status.get("Extrude001")).toEqual({ ok: true });
    const zs = Array.from(result.bodies[0]!.mesh.positions).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(5);
  });

  it("stays linked: moving the shape in 2D moves the solid", () => {
    const result = rebuild(drawingPart(), [rect(500, 300)]);
    expect(result.status.get("Extrude001")).toEqual({ ok: true });
    const xs = Array.from(result.bodies[0]!.mesh.positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(500);
  });

  it("reports an error when the linked shape is gone", () => {
    expect(rebuild(drawingPart(), []).status.get("Extrude001")?.ok).toBe(false);
  });

  it("never hands out the reserved drawing id", () => {
    expect(nextId(emptyPart(), "Drawing")).toBe("Drawing001");
  });
});

describe("work planes", () => {
  it("rotating XY by 90 degrees about its u (X) axis gives the XZ orientation", () => {
    const f = workPlaneFrame({ base: "XY", axis: "u" }, 0, 90);
    expect(f.n.x).toBeCloseTo(0);
    expect(f.n.y).toBeCloseTo(-1);
    expect(f.n.z).toBeCloseTo(0);
  });

  it("offset moves along the rotated normal; a 45 degree plane is exact", () => {
    const f = workPlaneFrame({ base: "XY", axis: "u" }, 10, 45);
    expect(f.origin.z).toBeCloseTo(10 * Math.SQRT1_2);
    expect(f.origin.y).toBeCloseTo(-10 * Math.SQRT1_2);
  });

  it("a sketch on a parametric work plane extrudes along that plane's normal", () => {
    const part = emptyPart();
    part.parameters.push({ name: "h", expr: "30" });
    part.planes.push({ id: "WorkPlane001", base: "XY", offset: "h", angle: "0", axis: "u" });
    part.sketches.push({
      id: "Sketch001",
      plane: { base: "WorkPlane001", offset: 0 },
      entities: [new Circle({ x: 0, y: 0 }, 5).serialize()],
      constraints: [],
    });
    part.features.push({
      id: "Extrude001",
      type: "extrude",
      sketch: "Sketch001",
      profiles: "all",
      distance: "10",
      direction: "normal",
      operation: "new",
    });
    const zs = Array.from(rebuild(part).bodies[0]!.mesh.positions).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(30);
    expect(Math.max(...zs)).toBeCloseTo(40);
    // Parameter change moves the plane, and the solid with it.
    part.parameters[0]!.expr = "50";
    const zs2 = Array.from(rebuild(part).bodies[0]!.mesh.positions).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs2)).toBeCloseTo(50);
  });

  it("a broken work plane reports on the feature instead of throwing", () => {
    const part = emptyPart();
    part.planes.push({ id: "WorkPlane001", base: "XY", offset: "nope", angle: "0", axis: "u" });
    part.sketches.push({ id: "Sketch001", plane: { base: "WorkPlane001", offset: 0 }, entities: [], constraints: [] });
    part.features.push({
      id: "Extrude001",
      type: "extrude",
      sketch: "Sketch001",
      profiles: "all",
      distance: "10",
      direction: "normal",
      operation: "new",
    });
    const result = rebuild(part);
    expect(result.planes.get("WorkPlane001")?.error).toBeDefined();
    expect(result.status.get("Extrude001")?.ok).toBe(false);
  });
});

describe("sketch on a face", () => {
  it("faceFrame keeps world-aligned orientation (top face reads like Top view)", () => {
    const f = faceFrame({ x: 5, y: 5, z: 20 }, { x: 0, y: 0, z: 1 });
    expect(f.u).toEqual({ x: 1, y: 0, z: 0 });
    expect(f.v).toEqual({ x: 0, y: 1, z: 0 });
    expect(f.origin.z).toBeCloseTo(20);
    const back = faceFrame({ x: 0, y: 60, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(back.v.z).toBeCloseTo(1); // Z stays up
    expect(back.u.x).toBeCloseTo(-1); // seen from behind, X runs left
  });

  it("a boss sketched on the top face of a plate stacks on top of it", () => {
    const part = emptyPart();
    part.features.push({
      id: "Extrude001",
      type: "extrude",
      sketch: "Drawing",
      profiles: "all",
      distance: "20",
      direction: "normal",
      operation: "new",
    });
    part.sketches.push({
      id: "Sketch001",
      plane: { base: "face", offset: 0, face: { feature: "Extrude001", role: "end", index: "0" } },
      entities: [new Circle({ x: 20, y: -20 }, 5).serialize()],
      constraints: [],
    });
    part.features.push({
      id: "Extrude002",
      type: "extrude",
      sketch: "Sketch001",
      profiles: "all",
      distance: "10",
      direction: "normal",
      operation: "new",
    });
    const result = rebuild(part, rectLines(100, 50).map((e) => e.serialize()));
    expect(result.status.get("Extrude002")).toEqual({ ok: true });
    const zs = Array.from(result.bodies[1]!.mesh.positions).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(20);
    expect(Math.max(...zs)).toBeCloseTo(30);
    // Survives a JSON round trip of the part.
    expect(parsePart(JSON.parse(JSON.stringify(part)))?.sketches[0]!.plane.face?.feature).toBe("Extrude001");
  });
});

describe("join / cut features in rebuild", () => {
  it("plate + face sketch circle cut through all = plate with a through hole; old files default to new", () => {
    const part = emptyPart();
    part.features.push({
      id: "Extrude001",
      type: "extrude",
      sketch: "Drawing",
      profiles: "all",
      distance: "20",
      direction: "normal",
      operation: "new",
    });
    part.sketches.push({
      id: "Sketch001",
      plane: { base: "face", offset: 0, face: { feature: "Extrude001", role: "end", index: "0" } },
      entities: [new Circle({ x: 50, y: 25 }, 10).serialize()], // world (50, -25): plate spans y -50..0
      constraints: [],
    });
    part.features.push({
      id: "Extrude002",
      type: "extrude",
      sketch: "Sketch001",
      profiles: "all",
      distance: "10",
      direction: "reverse",
      operation: "cut",
      extent: "through",
    });
    const result = rebuild(parsePart(JSON.parse(JSON.stringify(part)))!, rectLines(100, 50).map((e) => e.serialize()));
    expect(result.status.get("Extrude002")).toEqual({ ok: true });
    expect(result.bodies).toHaveLength(1);
    const hole = 0.5 * 72 * 100 * Math.sin((2 * Math.PI) / 72);
    expect(meshVolume(result.bodies[0]!.mesh.positions, result.bodies[0]!.mesh.indices)).toBeCloseTo((5000 - hole) * 20, 2);

    const legacy = parsePart({ features: [{ id: "E", type: "extrude", sketch: "Drawing", distance: 5 }] });
    expect(legacy?.features[0]!.operation).toBe("new");
    expect(legacy?.features[0]!.extent).toBeUndefined();
  });
});
