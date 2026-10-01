import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { rebuild } from "./rebuild";
import { emptyPart, parsePart } from "./types";
import type { HoleFeature, PartData } from "./types";
import type { Body } from "./kernel/types";
import { cylFrame } from "./cylFrame";
import { faceFrame } from "./plane";
import { drillAxis, holeLean } from "./hole";
import { dot } from "./vec3";

const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
const rect = (w: number, h: number): Entity[] => [
  new Line({ x: 0, y: 0 }, { x: w, y: 0 }),
  new Line({ x: w, y: 0 }, { x: w, y: -h }),
  new Line({ x: w, y: -h }, { x: 0, y: -h }),
  new Line({ x: 0, y: -h }, { x: 0, y: 0 }),
];
const base = (distance: string): PartData => ({
  ...emptyPart(),
  features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance, direction: "normal", operation: "new" }],
});
const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const FACET = Math.sin((2 * Math.PI) / 72) / ((2 * Math.PI) / 72); // a 72-sided "circle" is this much smaller
const rad = (deg: number): number => (deg * Math.PI) / 180;

describe("a leaning hole on a flat face", () => {
  const BLOCK = drawing(rect(80, 60));
  const block = rebuild(base("20"), BLOCK).bodies[0]!;
  const top = block.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
  const frame = faceFrame(top.geom.kind === "plane" ? top.geom.origin : { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const hole = (extra: Partial<HoleFeature>): HoleFeature => ({ id: "Hole001", type: "hole", face: top.ref, centers: [{ x: 40, y: 30 }], diameter: "10", depth: "10", style: "plain", extent: "through", ...extra });

  it("goes in at the entry point, tipped toward the lean direction", () => {
    const straight = drillAxis(frame, { x: 40, y: 30 }, null, false);
    expect(straight.dir.z).toBeCloseTo(-1);
    const lean = { angle: rad(30), toward: 0 };
    const tipped = drillAxis(frame, { x: 40, y: 30 }, lean, false);
    expect(tipped.origin).toEqual(straight.origin); // same entry point
    expect(tipped.dir.z).toBeCloseTo(-Math.cos(rad(30)));
    expect(dot(tipped.dir, frame.u)).toBeCloseTo(Math.sin(rad(30))); // drifts along the face's horizontal
    expect(dot(drillAxis(frame, { x: 40, y: 30 }, { angle: rad(30), toward: rad(90) }, false).dir, frame.v)).toBeCloseTo(Math.sin(rad(30)));
  });

  it("through all: removes an oblique cylinder, longer by 1 / cos(lean)", () => {
    const v0 = volume(block);
    const straight = rebuild({ ...base("20"), features: [...base("20").features, hole({})] }, BLOCK);
    expect(v0 - volume(straight.bodies[0]!)).toBeCloseTo(Math.PI * 25 * 20 * FACET, 1);
    const leaning = rebuild({ ...base("20"), features: [...base("20").features, hole({ lean: "30", leanToward: "0" })] }, BLOCK);
    expect(leaning.status.get("Hole001")).toEqual({ ok: true });
    expect(v0 - volume(leaning.bodies[0]!)).toBeCloseTo((Math.PI * 25 * 20 * FACET) / Math.cos(rad(30)), 1);
  });

  it("a blind leaning hole's depth runs along its own line; bad angles are refused", () => {
    const r = rebuild({ ...base("20"), features: [...base("20").features, hole({ extent: undefined, depth: "10", lean: "45", leanToward: "90" })] }, BLOCK);
    expect(r.status.get("Hole001")).toEqual({ ok: true });
    // 10 along a 45 degree line reaches only ~7 deep (plus the drill point): the bottom face is untouched.
    const p = r.bodies[0]!.mesh.positions;
    let pierced = false;
    for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2]!) < 1e-9 && Math.hypot(p[i]! - 40, p[i + 1]! - 30) < 20) pierced = true;
    expect(pierced).toBe(false);
    expect(holeLean({ lean: "85" }, new Map())).toMatch(/0 to 80/);
    expect(holeLean({ lean: "0" }, new Map())).toBeNull();
    expect(rebuild({ ...base("20"), features: [...base("20").features, hole({ lean: "85" })] }, BLOCK).status.get("Hole001")?.ok).toBe(false);
  });
});

describe("a leaning hole on a round face", () => {
  const SHAFT = drawing([new Circle({ x: 0, y: 0 }, 20)]);
  const shaft = rebuild(base("100"), SHAFT).bodies[0]!;
  const round = shaft.faces.find((f) => f.geom.kind === "cylinder")!;
  const cyl = cylFrame(round.geom as Extract<typeof round.geom, { kind: "cylinder" }>);
  const hole = (extra: Partial<HoleFeature>): HoleFeature => ({ id: "Hole001", type: "hole", face: round.ref, placement: "radial", centers: [{ x: 50, y: 0 }], diameter: "8", depth: "10", style: "plain", extent: "through", ...extra });
  const along = { angle: rad(30), toward: 0 };

  it("entry-point location: enters where it is dimensioned, crosses the axis further along", () => {
    const a = drillAxis(cyl, { x: 50, y: 0 }, along, false);
    expect(dot({ x: a.origin.x - cyl.origin.x, y: a.origin.y - cyl.origin.y, z: a.origin.z - cyl.origin.z }, cyl.axis)).toBeCloseTo(50);
    // Reaches the axis after radius / cos(lean), having drifted radius * tan(lean) along the shaft.
    const reach = 20 / Math.cos(rad(30));
    const hit = { x: a.origin.x + a.dir.x * reach, y: a.origin.y + a.dir.y * reach, z: a.origin.z + a.dir.z * reach };
    expect(Math.hypot(hit.x, hit.y)).toBeCloseTo(0);
    expect(hit.z).toBeCloseTo(50 + Math.sign(cyl.axis.z) * 20 * Math.tan(rad(30)));
  });

  it("axis-crossing location: the centreline meets the axis exactly at the dimension", () => {
    const a = drillAxis(cyl, { x: 50, y: 0 }, along, true);
    expect(Math.hypot(a.origin.x, a.origin.y)).toBeCloseTo(20); // still starts on the surface
    const reach = 20 / Math.cos(rad(30));
    const hit = { x: a.origin.x + a.dir.x * reach, y: a.origin.y + a.dir.y * reach, z: a.origin.z + a.dir.z * reach };
    expect(Math.hypot(hit.x, hit.y)).toBeCloseTo(0);
    expect(hit.z).toBeCloseTo(50);
  });

  it("rebuilds through, to the axis, and sideways; refuses what can't be", () => {
    const run = (extra: Partial<HoleFeature>) => rebuild({ ...base("100"), features: [...base("100").features, hole(extra)] }, SHAFT);
    const v0 = volume(shaft);
    const through = run({ lean: "30" });
    expect(through.status.get("Hole001")).toEqual({ ok: true });
    expect(v0 - volume(through.bodies[0]!)).toBeGreaterThan(Math.PI * 16 * 40 * 0.9); // more than a straight cross-hole's worth
    expect(run({ lean: "30", locate: "axis" }).status.get("Hole001")).toEqual({ ok: true });
    expect(run({ lean: "30", extent: "toAxis" }).status.get("Hole001")).toEqual({ ok: true });
    const sideways = run({ lean: "30", leanToward: "90" });
    expect(sideways.status.get("Hole001")).toEqual({ ok: true });
    expect(run({ lean: "30", leanToward: "90", extent: "toAxis" }).status.get("Hole001")?.error).toMatch(/misses the axis/);
    expect(run({ lean: "30", leanToward: "90", locate: "axis" }).status.get("Hole001")?.error).toMatch(/leans along the axis/);
  });

  it("round-trips through parsePart", () => {
    const f = hole({ lean: "30", leanToward: "0", locate: "axis" });
    expect(parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), features: [f] })))!.features[0]).toEqual({ ...f, suppressed: false });
  });
});
