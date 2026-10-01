import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { rebuild } from "./rebuild";
import { emptyPart, parsePart } from "./types";
import type { FeatureData, HoleFeature, PartData, PatternFeature } from "./types";
import type { Body } from "./kernel/types";
import { reflection, rotation, transformBody, translation } from "./pattern";

const rect = (x0: number, y0: number, x1: number, y1: number): Entity[] => [
  new Line({ x: x0, y: y0 }, { x: x1, y: y0 }),
  new Line({ x: x1, y: y0 }, { x: x1, y: y1 }),
  new Line({ x: x1, y: y1 }, { x: x0, y: y1 }),
  new Line({ x: x0, y: y1 }, { x: x0, y: y0 }),
];
const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const FACET = Math.sin((2 * Math.PI) / 72) / ((2 * Math.PI) / 72);

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

/** An 80 x 40 x 10 plate with one Ø8 through hole at (10, 10). */
const PLATE = drawing(rect(0, 0, 80, -40));
const plate = (): PartData => ({
  ...emptyPart(),
  features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" }],
});
function withHole(extra: FeatureData[], planes: PartData["planes"] = []): { r: ReturnType<typeof rebuild>; v0: number } {
  const p = plate();
  const built = rebuild(p, PLATE);
  const top = built.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
  const hole: HoleFeature = { id: "Hole001", type: "hole", face: top.ref, centers: [{ x: 10, y: 10 }], diameter: "8", depth: "5", style: "plain", extent: "through" };
  return { r: rebuild({ ...p, planes, features: [...p.features, hole, ...extra] }, PLATE), v0: volume(built.bodies[0]!) };
}
const ONE_HOLE = Math.PI * 16 * 10 * FACET;
const pattern = (f: Partial<PatternFeature> & Pick<PatternFeature, "kind">): PatternFeature => ({ id: "Pattern001", type: "pattern", features: ["Hole001"], ...f });

describe("moving a body", () => {
  const { r } = withHole([]);
  const tool = r.made.get("Hole001")![0]!.tool;

  it("translation, rotation and reflection keep it a closed, outward solid", () => {
    for (const t of [translation({ x: 20, y: 5, z: -3 }), rotation({ x: 40, y: 20, z: 0 }, { x: 0, y: 0, z: 1 }, 1.1), reflection({ x: 40, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })]) {
      const moved = transformBody(tool, t, "x", "P", "0");
      expect(isWatertight(moved)).toBe(true);
      expect(volume(moved)).toBeCloseTo(volume(tool), 6);
      // Faces get refs of their own, distinct from the source's.
      expect(moved.faces[0]!.ref.feature).toBe("P");
      expect(moved.faces[0]!.ref.index).toContain("Hole001");
    }
    const mirrored = transformBody(tool, reflection({ x: 40, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), "x", "P", "0");
    const cyl = mirrored.faces.find((f) => f.geom.kind === "cylinder")!.geom;
    expect(cyl.kind === "cylinder" && cyl.axisOrigin.x).toBeCloseTo(70);
  });
});

describe("Pattern feature", () => {
  it("rectangular: 4 along X and 2 along Y makes 8 real holes", () => {
    const { r, v0 } = withHole([pattern({ kind: "rect", dir1: "X", count1: "4", spacing1: "20", dir2: "Y", count2: "2", spacing2: "20" })]);
    expect(r.status.get("Pattern001")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    expect(v0 - volume(r.bodies[0]!)).toBeCloseTo(8 * ONE_HOLE, 0);
    expect(isWatertight(r.bodies[0]!)).toBe(true);
    expect(r.bodies[0]!.faces.filter((f) => f.geom.kind === "cylinder")).toHaveLength(8);
    expect(r.made.get("Pattern001")).toHaveLength(7);
  });

  it("one direction only; a count of 1 adds nothing but is not an error", () => {
    const three = withHole([pattern({ kind: "rect", dir1: "X", count1: "3", spacing1: "30" })]);
    expect(three.v0 - volume(three.r.bodies[0]!)).toBeCloseTo(3 * ONE_HOLE, 0);
    expect(withHole([pattern({ kind: "rect", dir1: "X", count1: "1", spacing1: "30" })]).r.status.get("Pattern001")?.ok).toBe(false); // no copies: nothing touched
    expect(withHole([pattern({ kind: "rect", dir1: "X", count1: "2.5", spacing1: "30" })]).r.status.get("Pattern001")?.error).toMatch(/whole number/);
  });

  it("circular: evenly all round for 360, ending on the angle otherwise", () => {
    // Hole at (10, 10); 4 about Z through the origin: three copies leave the plate, one... check by transforms instead.
    const part = plate();
    const built = rebuild(part, PLATE);
    const top = built.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: top.ref, centers: [{ x: 60, y: 20 }], diameter: "8", depth: "5", style: "plain", extent: "through" };
    // About a second, central hole's axis: 4 holes on a 20 radius circle round (40, 20).
    const centre: HoleFeature = { ...hole, id: "Hole002", centers: [{ x: 40, y: 20 }], diameter: "6" };
    const pre = rebuild({ ...part, features: [...part.features, hole, centre] }, PLATE);
    const bore = pre.bodies[0]!.faces.find((f) => f.geom.kind === "cylinder" && f.geom.radius === 3)!;
    const circ = pattern({ kind: "circular", count1: "4", angle: "360", axisFace: bore.ref });
    const r = rebuild({ ...part, features: [...part.features, hole, centre, circ] }, PLATE);
    expect(r.status.get("Pattern001")).toEqual({ ok: true });
    const big = r.bodies[0]!.faces.filter((f) => f.geom.kind === "cylinder" && f.geom.radius === 4);
    expect(big).toHaveLength(4);
    const at = big.map((f) => (f.geom.kind === "cylinder" ? `${Math.round(f.geom.axisOrigin.x)},${Math.round(f.geom.axisOrigin.y)}` : "")).sort();
    expect(at).toEqual(["20,20", "40,0", "40,40", "60,20"]);
    // 3 over 90 degrees: at 0, 45 and 90.
    const part90 = rebuild({ ...part, features: [...part.features, hole, centre, pattern({ kind: "circular", count1: "3", angle: "90", axisFace: bore.ref })] }, PLATE);
    expect(part90.bodies[0]!.faces.filter((f) => f.geom.kind === "cylinder" && f.geom.radius === 4)).toHaveLength(3);
  });

  it("mirror: in a work plane, and it follows when the original moves", () => {
    const planes: PartData["planes"] = [{ id: "WorkPlane001", base: "YZ", offset: "40", angle: "0", axis: "u" }];
    const { r, v0 } = withHole([pattern({ kind: "mirror", plane: "WorkPlane001" })], planes);
    expect(r.status.get("Pattern001")).toEqual({ ok: true });
    expect(v0 - volume(r.bodies[0]!)).toBeCloseTo(2 * ONE_HOLE, 0);
    const xs = r.bodies[0]!.faces.flatMap((f) => (f.geom.kind === "cylinder" ? [Math.round(f.geom.axisOrigin.x)] : [])).sort((a, b) => a - b);
    expect(xs).toEqual([10, 70]);
    expect(withHole([pattern({ kind: "mirror" })]).r.status.get("Pattern001")?.error).toMatch(/mirror plane/);
  });

  it("repeats an added feature too, and a pattern of a pattern", () => {
    const p = plate();
    const boss: FeatureData = { id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "5", direction: "normal", operation: "join" };
    const sketches: PartData["sketches"] = [{ id: "Sketch001", plane: { base: "XY", offset: 10 }, entities: drawing([new Circle({ x: 10, y: -10 }, 4)]), constraints: [] }];
    const row = pattern({ kind: "rect", features: ["Extrude002"], dir1: "X", count1: "3", spacing1: "20" });
    const rows: PatternFeature = { ...pattern({ kind: "rect", features: ["Extrude002", "Pattern001"], dir1: "Y", count1: "2", spacing1: "20" }), id: "Pattern002" };
    const r = rebuild({ ...p, sketches, features: [...p.features, boss, row, rows] }, PLATE);
    expect(r.status.get("Pattern002")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    expect(volume(r.bodies[0]!)).toBeCloseTo(32000 + 6 * Math.PI * 16 * 5 * FACET, 0);
  });

  it("round-trips through parsePart; a missing source is reported", () => {
    const f = pattern({ kind: "circular", dir1: "Z", count1: "6", angle: "360" });
    expect(parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), features: [f] })))!.features[0]).toEqual({ ...f, suppressed: false });
    const { r } = withHole([{ ...pattern({ kind: "rect", dir1: "X", count1: "2", spacing1: "20" }), features: ["Nope"] }]);
    expect(r.status.get("Pattern001")?.error).toMatch(/Nothing to repeat/);
  });
});
