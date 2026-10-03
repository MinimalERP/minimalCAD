import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { meshVolume } from "./kernel/extrude";
import { rebuild } from "./rebuild";
import { chainToSketch, isPlanar, loopPlane, planeTriple, snapPoints3d } from "./line3d";
import { pointsFrame } from "./workPlane";
import { emptyPart } from "./types";
import type { PartData } from "./types";
import type { Vec3 } from "./vec3";

const box = (): ReturnType<typeof rebuild> => {
  const r = [
    new Line({ x: 0, y: 0 }, { x: 20, y: 0 }),
    new Line({ x: 20, y: 0 }, { x: 20, y: -10 }),
    new Line({ x: 20, y: -10 }, { x: 0, y: -10 }),
    new Line({ x: 0, y: -10 }, { x: 0, y: 0 }),
  ].map((e) => e.serialize());
  const p: PartData = { ...emptyPart(), features: [{ id: "E1", type: "extrude", sketch: "Drawing", profiles: "all", distance: "5", direction: "normal", operation: "new" }] };
  return rebuild(p, r);
};

describe("3D Line", () => {
  it("osnaps a box: 8 corners, 12 edge middles", () => {
    const snaps = snapPoints3d(box().bodies);
    expect(snaps.filter((s) => s.kind === "end")).toHaveLength(8);
    expect(snaps.filter((s) => s.kind === "mid")).toHaveLength(12);
  });

  it("tells a flat loop from a twisted one", () => {
    const tilted: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 10 },
      { x: 0, y: 10, z: 10 },
    ];
    expect(isPlanar(tilted)).toBe(true);
    expect(isPlanar([...tilted.slice(0, 3), { x: 0, y: 10, z: 3 }])).toBe(false);
    expect(planeTriple([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }])).toBeNull();
    const n = loopPlane(tilted)!.n;
    expect(Math.abs(n.y + n.z) < 1e-9 && Math.abs(n.x) < 1e-9).toBe(true);
  });

  it("a closed slanted loop becomes a sketch on its own plane and extrudes along its normal", () => {
    // A square leaning 45° (normal along (0, -1, 1)/√2), 10 x 10√2.
    const loop: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 10 },
      { x: 0, y: 10, z: 10 },
    ];
    const t = planeTriple(loop)!;
    const placed = pointsFrame(t, 0);
    if (typeof placed === "string") throw new Error(placed);
    const part: PartData = {
      ...emptyPart(),
      planes: [{ id: "WP1", base: "XY", offset: "0", angle: "0", axis: "u", on: { points: t } }],
      sketches: [{ id: "S1", plane: { base: "WP1", offset: 0 }, entities: chainToSketch(loop, placed.frame, true), constraints: [] }],
      features: [{ id: "E1", type: "extrude", sketch: "S1", profiles: "all", distance: "4", direction: "normal", operation: "new" }],
    };
    const r = rebuild(part, []);
    expect(r.sketches.get("S1")!.profiles.regions).toHaveLength(1);
    expect(r.status.get("E1")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    expect(Math.abs(meshVolume(b.mesh.positions, b.mesh.indices))).toBeCloseTo(10 * 10 * Math.SQRT2 * 4, 3);
    // Every vertex is on the loop's plane or 4 off it, along the normal.
    const n = placed.frame.n;
    const p = b.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const d = p[i]! * n.x + p[i + 1]! * n.y + p[i + 2]! * n.z;
      expect(Math.min(Math.abs(d), Math.abs(Math.abs(d) - 4))).toBeLessThan(1e-6);
    }
  });
});

describe("sketches on the XY plane", () => {
  it("each is its own sketch, separate from the 2D drawing", () => {
    const sq = (x0: number, x1: number): Record<string, unknown>[] =>
      [
        new Line({ x: x0, y: 0 }, { x: x1, y: 0 }),
        new Line({ x: x1, y: 0 }, { x: x1, y: -10 }),
        new Line({ x: x1, y: -10 }, { x: x0, y: -10 }),
        new Line({ x: x0, y: -10 }, { x: x0, y: 0 }),
      ].map((e) => e.serialize());
    const part: PartData = {
      ...emptyPart(),
      sketches: [
        { id: "Sketch001", plane: { base: "XY", offset: 0 }, entities: sq(0, 10), constraints: [] },
        { id: "Sketch002", plane: { base: "XY", offset: 0 }, entities: sq(20, 30), constraints: [] },
      ],
      features: [{ id: "E2", type: "extrude", sketch: "Sketch002", profiles: "all", distance: "5", direction: "normal", operation: "new" }],
    };
    const r = rebuild(part, sq(40, 50));
    expect(r.sketches.get("Sketch001")!.profiles.regions).toHaveLength(1);
    expect(r.sketches.get("Sketch002")!.profiles.regions).toHaveLength(1);
    expect(r.sketches.get("Drawing")!.profiles.regions).toHaveLength(1);
    expect(r.status.get("E2")).toEqual({ ok: true });
    // Only Sketch002's square was extruded.
    const xs = Array.from(r.bodies[0]!.mesh.positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(20);
    expect(Math.max(...xs)).toBeCloseTo(30);
  });
});
