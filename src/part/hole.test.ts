import { describe, expect, it } from "vitest";
import { Polyline } from "../entities/polyline";
import { Circle } from "../entities/circle";
import { revolveProfile } from "./kernel/revolve";
import { meshVolume } from "./kernel/extrude";
import type { Body } from "./kernel/types";
import { faceHasRef } from "./kernel/types";
import { faceFrameOf, faceSurfaceOf, rebuild } from "./rebuild";
import { cylTo3d, isCyl } from "./cylFrame";
import { edgesOnFace, refsOnRoundFace } from "./faceTopology";
import { emptyPart, parsePart } from "./types";
import { dependsOn, refLine, resolveCenters, signedDistance, solveCenter } from "./hole";
import type { Point } from "../core/types";
import type { HoleCenter, HoleFeature, PartData } from "./types";

/** Exact area of the 72-gon the tessellation uses for a circle of radius r. */
const polyArea = (r: number): number => 0.5 * 72 * r * r * Math.sin((2 * Math.PI) / 72);
const vol = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);

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
  for (const [k, n] of directed) {
    const [a, b] = k.split("|");
    if (n !== directed.get(`${b}|${a}`)) return false;
  }
  return true;
}

describe("revolveProfile", () => {
  const axis = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } };

  it("cylinder: volume, watertight, exact faces and rim circles", () => {
    const b = revolveProfile("R", "0", [{ r: 0, z: 0 }, { r: 5, z: 0 }, { r: 5, z: 10 }, { r: 0, z: 10 }], axis);
    expect(vol(b)).toBeCloseTo(polyArea(5) * 10, 8);
    expect(isWatertight(b)).toBe(true);
    expect(b.faces.map((f) => f.geom.kind)).toEqual(["plane", "cylinder", "plane"]);
    expect(b.edges.every((e) => e.geom.kind === "arc" && e.geom.radius === 5)).toBe(true);
  });

  it("cone faces are exact (apex + half angle), in either traversal direction", () => {
    const b = revolveProfile("R", "0", [{ r: 0, z: 10 }, { r: 5, z: 0 }, { r: 0, z: 0 }], axis);
    expect(vol(b)).toBeGreaterThan(0);
    const cone = b.faces.find((f) => f.geom.kind === "cone");
    expect(cone?.geom.kind === "cone" && cone.geom.apex.z).toBeCloseTo(10);
    expect(cone?.geom.kind === "cone" && cone.geom.halfAngle).toBeCloseTo(Math.atan(0.5));
  });
});

describe("Hole feature", () => {
  const plate = (): Record<string, unknown> =>
    new Polyline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 60 },
        { x: 0, y: 60 },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    ).serialize();

  /** 100 x 60 x 20 plate; its top face spans local x 0..100, y -60..0. */
  function partWith(hole: Omit<HoleFeature, "id" | "type" | "face">): PartData {
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
    part.features.push({ id: "Hole001", type: "hole", face: { feature: "Extrude001", role: "end", index: "0" }, ...hole });
    return part;
  }
  const plateVol = 100 * 60 * 20;

  it("plain through holes: two centres, exact volume, watertight, exact rims", () => {
    const part = partWith({ centers: [{ x: 25, y: -30 }, { x: 75, y: -30 }], diameter: "10", depth: "5", extent: "through", style: "plain" });
    const r = rebuild(part, [plate()]);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    expect(vol(b)).toBeCloseTo(plateVol - 2 * polyArea(5) * 20, 2);
    expect(isWatertight(b)).toBe(true);
    const rims = b.edges.filter((e) => e.geom.kind === "arc");
    expect(rims).toHaveLength(4);
    for (const e of rims) if (e.geom.kind === "arc") expect(e.geom.radius).toBe(5);
  });

  it("counterbore = big cylinder + small cylinder", () => {
    const part = partWith({
      centers: [{ x: 50, y: -30 }],
      diameter: "10",
      depth: "5",
      extent: "through",
      style: "counterbore",
      cbDiameter: "18",
      cbDepth: "6",
    });
    const b = rebuild(part, [plate()]).bodies[0]!;
    expect(vol(b)).toBeCloseTo(plateVol - polyArea(9) * 6 - polyArea(5) * 14, 2);
    expect(isWatertight(b)).toBe(true);
  });

  it("countersink: conical rim, exact circle edges at top and bottom of the cone", () => {
    const part = partWith({
      centers: [{ x: 50, y: -30 }],
      diameter: "10",
      depth: "5",
      extent: "through",
      style: "countersink",
      csDiameter: "20",
      csAngle: "90",
    });
    const r = rebuild(part, [plate()]);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    expect(isWatertight(b)).toBe(true);
    const radii = b.edges.flatMap((e) => (e.geom.kind === "arc" ? [+e.geom.radius.toFixed(4)] : [])).sort((x, y) => x - y);
    // bottom rim r5, cone/cylinder rim r5, top rim r10
    expect(radii).toEqual([5, 5, 10]);
    expect(b.faces.some((f) => f.geom.kind === "cone")).toBe(true);
  });

  it("blind hole with drill point stays inside the plate", () => {
    const part = partWith({ centers: [{ x: 50, y: -30 }], diameter: "10", depth: "8", style: "plain" });
    const b = rebuild(part, [plate()]).bodies[0]!;
    const tip = 5 / Math.tan((59 * Math.PI) / 180);
    const cone = (polyArea(5) * tip) / 3;
    expect(vol(b)).toBeCloseTo(plateVol - polyArea(5) * 8 - cone, 1);
    expect(isWatertight(b)).toBe(true);
  });

  it("errors are reported, not thrown; JSON round-trip keeps everything", () => {
    const bad = partWith({ centers: [{ x: 50, y: -30 }], diameter: "10", depth: "5", extent: "through", style: "counterbore", cbDiameter: "8", cbDepth: "3" });
    expect(rebuild(bad, [plate()]).status.get("Hole001")?.ok).toBe(false);
    const missing = partWith({ centers: [{ x: 500, y: 500 }], diameter: "10", depth: "5", extent: "through", style: "plain" });
    expect(rebuild(missing, [plate()]).status.get("Hole001")?.ok).toBe(false);

    const good = partWith({ centers: [{ x: 50, y: -30 }], diameter: "d", depth: "5", extent: "through", style: "countersink", csDiameter: "20", csAngle: "82" });
    const back = parsePart(JSON.parse(JSON.stringify(good)))!;
    expect(back.features[1]).toEqual(good.features[1] && { ...good.features[1], suppressed: false });
  });

  it("a hole on a boss's top face drills the boss, not the plate under it (same role/index, other feature)", () => {
    const part = partWith({ centers: [], diameter: "10", depth: "5", style: "plain" });
    part.features.pop(); // no hole on the plate
    part.sketches.push({
      id: "Sketch001",
      plane: { base: "face", offset: 0, face: { feature: "Extrude001", role: "end", index: "0" } },
      entities: [new Circle({ x: 50, y: 30 }, 15).serialize()],
      constraints: [],
    });
    part.features.push({ id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "10", direction: "normal", operation: "join" });
    const bossTop = { feature: "Extrude002", role: "end" as const, index: "0" };
    const before = rebuild(part, [plate()]);
    expect(before.bodies).toHaveLength(1);
    // Both extrudes have an "end 0" face: the boss's top is at z 30, the plate's at 20.
    expect(faceFrameOf(before.bodies, bossTop)?.origin.z).toBeCloseTo(30);
    expect(faceFrameOf(before.bodies, { ...bossTop, feature: "Extrude001" })?.origin.z).toBeCloseTo(20);

    part.features.push({ id: "Hole001", type: "hole", face: bossTop, centers: [{ x: 50, y: -30 }], diameter: "10", depth: "5", style: "plain" });
    const after = rebuild(part, [plate()]);
    expect(after.status.get("Hole001")).toEqual({ ok: true });
    const zs = Array.from(after.bodies[0]!.mesh.positions).filter((_, i) => i % 3 === 2);
    // The hole's bottom rim is 5 below the boss top: a vertex at z = 25.
    expect(zs.some((z) => Math.abs(z - 25) < 1e-6)).toBe(true);
    expect(vol(after.bodies[0]!)).toBeLessThan(vol(before.bodies[0]!) - polyArea(5) * 5 + 1e-6);
  });

  it("faces merged by a join keep every ref: a hole on either block's (now shared) top face works", () => {
    const part = partWith({ centers: [], diameter: "10", depth: "5", style: "plain" });
    part.features.pop();
    const block = new Polyline(
      [
        { x: 80, y: 0 },
        { x: 140, y: 0 },
        { x: 140, y: 60 },
        { x: 80, y: 60 },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    ).serialize();
    part.sketches.push({ id: "Sketch001", plane: { base: "XY", offset: 0 }, entities: [block], constraints: [] });
    part.features.push({ id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "20", direction: "normal", operation: "join" });
    const before = rebuild(part, [plate()]);
    expect(before.status.get("Extrude002")).toEqual({ ok: true });
    const tops = before.bodies[0]!.faces.filter((f) => f.geom.kind === "plane" && Math.abs(f.geom.normal.z - 1) < 1e-9);
    expect(tops).toHaveLength(1); // one merged top
    for (const feature of ["Extrude001", "Extrude002"]) {
      const ref = { feature, role: "end" as const, index: "0" };
      expect(faceFrameOf(before.bodies, ref)?.origin.z).toBeCloseTo(20);
      const withHole = structuredClone(part);
      withHole.features.push({ id: "Hole001", type: "hole", face: ref, centers: [{ x: 120, y: -30 }], diameter: "10", depth: "5", style: "plain" });
      expect(rebuild(withHole, [plate()]).status.get("Hole001")).toEqual({ ok: true });
    }
  });
});

describe("hole placement by dimensions (chain)", () => {
  // Plate top face (local coords, Y up): x 0..100, y 0..60.
  const bottom: [Point, Point] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const left: [Point, Point] = [{ x: 0, y: 60 }, { x: 0, y: 0 }];
  const side = (seg: [Point, Point], p: Point): 1 | -1 => {
    const l = refLine({ kind: "edge", seg }, []);
    return typeof l !== "string" && signedDistance(l, p) < 0 ? -1 : 1;
  };
  const inside = { x: 50, y: 30 };

  it("hole 1 from two edges; hole 2 from hole 1 + an edge; hole 3 from hole 2 + an edge", () => {
    const centers: HoleCenter[] = [
      { x: 14, y: 16, dims: [ { ref: { kind: "edge", seg: bottom }, d: "15", side: side(bottom, inside) }, { ref: { kind: "edge", seg: left }, d: "20", side: side(left, inside) } ] },
      { x: 48, y: 17, dims: [ { ref: { kind: "hole", index: 0, axis: "u" }, d: "30", side: 1 }, { ref: { kind: "edge", seg: bottom }, d: "15", side: side(bottom, inside) } ] },
      { x: 80, y: 20, dims: [ { ref: { kind: "hole", index: 1, axis: "u" }, d: "30", side: 1 }, { ref: { kind: "hole", index: 1, axis: "v" }, d: "10", side: 1 } ] },
    ];
    expect(resolveCenters({ centers }, new Map())).toEqual([
      { x: 20, y: 15 },
      { x: 50, y: 15 },
      { x: 80, y: 25 },
    ]);
    // The chain: moving hole 1 moves holes 2 and 3.
    centers[0]!.dims![1]!.d = "25";
    expect(resolveCenters({ centers }, new Map())).toEqual([
      { x: 25, y: 15 },
      { x: 55, y: 15 },
      { x: 85, y: 25 },
    ]);
  });

  it("any order: hole 1 may be constrained from hole 2 once hole 2 is placed; loops are refused", () => {
    const centers: HoleCenter[] = [
      { x: 0, y: 0, dims: [ { ref: { kind: "hole", index: 1, axis: "u" }, d: "30", side: -1 }, { ref: { kind: "hole", index: 1, axis: "v" }, d: "0", side: 1 } ] },
      { x: 60, y: 20, dims: [ { ref: { kind: "edge", seg: bottom }, d: "20", side: side(bottom, inside) }, { ref: { kind: "edge", seg: left }, d: "60", side: side(left, inside) } ] },
    ];
    expect(resolveCenters({ centers }, new Map())).toEqual([
      { x: 30, y: 20 },
      { x: 60, y: 20 },
    ]);
    expect(dependsOn({ centers }, 0, 1)).toBe(true);
    expect(dependsOn({ centers }, 1, 0)).toBe(false);
    centers[1]!.dims![0] = { ref: { kind: "hole", index: 0, axis: "v" }, d: "5", side: 1 };
    expect(typeof resolveCenters({ centers }, new Map())).toBe("string");
  });

  it("one dimension slides the clicked point onto that line; bad refs report", () => {
    expect(solveCenter([{ ref: { kind: "edge", seg: bottom }, d: "15", side: 1 }], { x: 33, y: 7 }, [], new Map())).toEqual({ x: 33, y: 15 });
    expect(typeof solveCenter([{ ref: { kind: "hole", index: 3, axis: "u" }, d: "5", side: 1 }], { x: 0, y: 0 }, [], new Map())).toBe("string");
    const parallel = [
      { ref: { kind: "edge" as const, seg: bottom }, d: "5", side: 1 as const },
      { ref: { kind: "point" as const, p: { x: 10, y: 10 }, axis: "v" as const }, d: "5", side: 1 as const },
    ];
    expect(typeof solveCenter(parallel, { x: 0, y: 0 }, [], new Map())).toBe("string");
  });

  it("a dimensioned hole rebuilds at the right spot and survives JSON", () => {
    const part = emptyPart();
    part.features.push({ id: "E", type: "extrude", sketch: "Drawing", profiles: "all", distance: "20", direction: "normal", operation: "new" });
    part.features.push({
      id: "H",
      type: "hole",
      face: { feature: "E", role: "end", index: "0" },
      centers: [{ x: 0, y: 0, dims: [ { ref: { kind: "edge", seg: bottom }, d: "15", side: side(bottom, inside) }, { ref: { kind: "edge", seg: left }, d: "20", side: side(left, inside) } ] }],
      diameter: "10",
      depth: "5",
      extent: "through",
      style: "plain",
    });
    // A plate drawn Y-up in world terms: stored Y-down, i.e. y 0..-60.
    const plate = new Polyline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: -60 },
        { x: 0, y: -60 },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    ).serialize();
    const back = parsePart(JSON.parse(JSON.stringify(part)))!;
    const b = rebuild(back, [plate]).bodies[0]!;
    const rim = b.edges.find((e) => e.geom.kind === "arc");
    expect(rim?.geom.kind === "arc" && rim.geom.center.x).toBeCloseTo(20);
    expect(rim?.geom.kind === "arc" && rim.geom.center.y).toBeCloseTo(15);
  });
});

describe("edgesOnFace (snaps belong to the face under the cursor)", () => {
  it("top face of a plate with a hole: its 4 edges + the hole rim only", () => {
    const part = emptyPart();
    part.features.push({ id: "E", type: "extrude", sketch: "Drawing", profiles: "all", distance: "20", direction: "normal", operation: "new" });
    part.features.push({
      id: "H",
      type: "hole",
      face: { feature: "E", role: "end", index: "0" },
      centers: [{ x: 50, y: -30 }],
      diameter: "10",
      depth: "5",
      extent: "through",
      style: "plain",
    });
    const plate = new Polyline(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 60 },
        { x: 0, y: 60 },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    ).serialize();
    const r = rebuild(part, [plate]);
    const top = faceFrameOf(r.bodies, { feature: "E", role: "end", index: "0" })!;
    const onTop = edgesOnFace(r.bodies[0]!, top);
    expect(onTop.lines).toHaveLength(4); // bottom-face and vertical edges excluded
    expect(onTop.circles).toEqual([{ center: { x: 50, y: -30 }, radius: 5 }]);
    expect(onTop.snaps.filter((s) => s.kind === "center")).toHaveLength(1);
  });
});

describe("radial holes (on a round face)", () => {
  /** Ø40 x 80 shaft standing on the XY plane, axis = world Z. */
  function shaft(hole?: Omit<HoleFeature, "id" | "type" | "face" | "placement">): PartData {
    const part = emptyPart();
    part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "80", direction: "normal", operation: "new" });
    if (hole !== undefined) {
      part.features.push({ id: "Hole001", type: "hole", placement: "radial", face: { feature: "Extrude001", role: "side", index: "0.0.0" }, ...hole });
    }
    return part;
  }
  const circle = (): Record<string, unknown> => new Circle({ x: 0, y: 0 }, 20).serialize();
  const shaftVol = (): number => vol(rebuild(shaft(), [circle()]).bodies[0]!);

  it("the shaft's side is a round face with a CylFrame (angle 0 = +X for a vertical axis)", () => {
    const bodies = rebuild(shaft(), [circle()]).bodies;
    const s = faceSurfaceOf(bodies, { feature: "Extrude001", role: "side", index: "0.0.0" });
    expect(s !== null && isCyl(s)).toBe(true);
    if (s === null || !isCyl(s)) return;
    expect(s.radius).toBeCloseTo(20);
    expect(s.ref.x).toBeCloseTo(1);
    const p = cylTo3d(s, { x: 30, y: 90 });
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(6))).toEqual([0, 20, 30]);
  });

  it("references on the round face: both end rims, and the XZ / YZ plane lines (both sides)", () => {
    const bodies = rebuild(shaft(), [circle()]).bodies;
    const ref = { feature: "Extrude001", role: "side" as const, index: "0.0.0" };
    const s = faceSurfaceOf(bodies, ref);
    if (s === null || !isCyl(s)) throw new Error("no round face");
    const refs = refsOnRoundFace(bodies[0]!, ref, s);
    const rims = refs.filter((r) => r.label === "end face").map((r) => +r.seg[0].x.toFixed(6)).sort((a, b) => a - b);
    expect(rims).toEqual([0, 80]);
    const planes = refs.filter((r) => r.label.endsWith("plane")).map((r) => `${r.label} ${Math.round(r.seg[0].y)}`).sort();
    expect(planes).toEqual(["XZ plane 0", "XZ plane 180", "YZ plane -90", "YZ plane 90"]);
    expect(refs.some((r) => r.label === "flat")).toBe(false);
  });

  it("a key flat along the shaft is an angle reference (at its normal's angle), and picking that face finds it", () => {
    const part = shaft();
    const box = new Polyline(
      [
        { x: 15, y: -30 },
        { x: 30, y: -30 },
        { x: 30, y: 30 },
        { x: 15, y: 30 },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    ).serialize();
    part.sketches.push({ id: "Sketch001", plane: { base: "XY", offset: 0 }, entities: [box], constraints: [] });
    part.features.push({ id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "80", direction: "normal", operation: "cut" });
    const r = rebuild(part, [circle()]);
    expect(r.status.get("Extrude002")).toEqual({ ok: true });
    const ref = { feature: "Extrude001", role: "side" as const, index: "0.0.0" };
    const s = faceSurfaceOf(r.bodies, ref);
    if (s === null || !isCyl(s)) throw new Error("no round face");
    const refs = refsOnRoundFace(r.bodies[0]!, ref, s);
    const flat = refs.find((x) => x.label === "flat");
    expect(flat?.seg[0].y).toBeCloseTo(0); // the flat faces +X: angle 0
    const flatFace = r.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && Math.abs(f.geom.normal.x - 1) < 1e-9);
    expect(flatFace !== undefined && flat?.flat !== undefined && faceHasRef(flatFace, flat.flat)).toBe(true);
    // The two straight seams where the flat meets the round face are references too.
    expect(refs.filter((x) => x.label === "edge")).toHaveLength(2);
  });

  it("through all: a Ø10 cross hole right across the shaft, watertight", () => {
    const r = rebuild(shaft({ centers: [{ x: 40, y: 0 }], diameter: "10", depth: "5", extent: "through", style: "plain" }), [circle()]);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    expect(isWatertight(b)).toBe(true);
    const removed = shaftVol() - vol(b);
    // A Ø10 bore through a Ø40 shaft: a bit under the 2R-long cylinder.
    expect(removed).toBeGreaterThan(Math.PI * 25 * 40 * 0.93);
    expect(removed).toBeLessThan(Math.PI * 25 * 40);
  });

  it("to axis: stops at the centre line (plus the drill point)", () => {
    const r = rebuild(shaft({ centers: [{ x: 40, y: 0 }], diameter: "10", depth: "5", extent: "toAxis", style: "plain" }), [circle()]);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    expect(isWatertight(b)).toBe(true);
    const removed = shaftVol() - vol(b);
    expect(removed).toBeGreaterThan(Math.PI * 25 * 20 * 0.9);
    expect(removed).toBeLessThan(Math.PI * 25 * 20 * 1.2);
    // Nothing on the far (-X) side is touched.
    const xs = Array.from(b.mesh.positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-20, 1);
  });

  it("constraints: 20 from the top end face + 90° from the angle-0 line -> the hole faces +Y at z 60", () => {
    const centers: HoleCenter[] = [
      {
        x: 0,
        y: 0,
        dims: [
          { ref: { kind: "edge", seg: [{ x: 80, y: 180 }, { x: 80, y: -180 }] }, d: "20", side: -1 },
          { ref: { kind: "edge", seg: [{ x: 0, y: 0 }, { x: 80, y: 0 }] }, d: "90", side: 1 },
        ],
      },
    ];
    const solved = resolveCenters({ centers }, new Map());
    expect(solved).toEqual([{ x: 60, y: 90 }]);
    const r = rebuild(shaft({ centers, diameter: "10", depth: "8", style: "plain" }), [circle()]);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    // The blind hole's bottom rim: a circle of r5 centred 8 in from +Y at z 60.
    const rim = b.edges.find((e) => e.geom.kind === "arc" && Math.abs(e.geom.radius - 5) < 1e-6);
    expect(rim?.geom.kind === "arc" && [rim.geom.center.x, rim.geom.center.y, rim.geom.center.z].map((v) => +v.toFixed(4))).toEqual([0, 12, 60]);
  });

  it("too wide for the shaft, or To axis on a flat face, is refused", () => {
    const wide = rebuild(shaft({ centers: [{ x: 40, y: 0 }], diameter: "40", depth: "5", extent: "through", style: "plain" }), [circle()]);
    expect(wide.status.get("Hole001")?.error).toMatch(/too wide/);
    const back = parsePart(JSON.parse(JSON.stringify(shaft({ centers: [{ x: 40, y: 0 }], diameter: "10", depth: "5", extent: "toAxis", style: "plain" }))))!;
    const h = back.features[1] as HoleFeature;
    expect([h.placement, h.extent]).toEqual(["radial", "toAxis"]);
  });
});
