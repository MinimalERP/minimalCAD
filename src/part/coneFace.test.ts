import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { rebuild } from "./rebuild";
import { emptyPart } from "./types";
import type { HoleFeature, PartData, WorkPlane } from "./types";
import type { Body } from "./kernel/types";
import { planeRef } from "./kernel/types";
import { coneFrame, cylTo3d, radiusAt, surfaceNormal } from "./cylFrame";
import { tangentFrame } from "./workPlane";
import { dot, length, sub } from "./vec3";

const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
const FACET = Math.sin((2 * Math.PI) / 72) / ((2 * Math.PI) / 72);

/** A cone frustum about X: radius 20 at x = 0 down to 10 at x = 40 (drawn Y-down), 360 degrees. */
const FRUSTUM = drawing([
  new Line({ x: 0, y: 0 }, { x: 40, y: 0 }),
  new Line({ x: 40, y: 0 }, { x: 40, y: -10 }),
  new Line({ x: 40, y: -10 }, { x: 0, y: -20 }),
  new Line({ x: 0, y: -20 }, { x: 0, y: 0 }),
]);
const frustum = (): PartData => ({
  ...emptyPart(),
  features: [{ id: "Revolve001", type: "revolve", sketch: "Drawing", profiles: "all", axis: { kind: "u" }, angle: "360", direction: "normal", operation: "new" }],
});

describe("a conical face", () => {
  const base = rebuild(frustum(), FRUSTUM);
  const body = base.bodies[0]!;
  const cone = body.faces.find((f) => f.geom.kind === "cone")!;

  it("is found on the revolved frustum, and its frame lies on the surface", () => {
    expect(base.status.get("Revolve001")).toEqual({ ok: true });
    expect(cone).toBeDefined();
    if (cone.geom.kind !== "cone") return;
    const f = coneFrame(cone.geom);
    expect(Math.abs(f.slope)).toBeCloseTo(0.25); // 10 of radius over 40 of length
    // Every point of the frame at the face's two ends is at the drawn radius from the X axis.
    const xs = [20, 10].map((r) => r / f.slope);
    for (const [i, x] of xs.entries()) {
      const p = cylTo3d(f, { x, y: 37 });
      expect(Math.hypot(p.y, p.z)).toBeCloseTo([20, 10][i]!);
      expect(radiusAt(f, x)).toBeCloseTo([20, 10][i]!);
    }
    // The normal is square to the slant line and points away from the axis.
    const n = surfaceNormal(f, 37);
    const a = cylTo3d(f, { x: xs[0]!, y: 37 });
    const b = cylTo3d(f, { x: xs[1]!, y: 37 });
    expect(dot(n, sub(b, a))).toBeCloseTo(0);
    expect(n.y * a.y + n.z * a.z).toBeGreaterThan(0);
    expect(length(n)).toBeCloseTo(1);
  });

  it("takes a hole, drilled square to the cone, blind and through", () => {
    if (cone.geom.kind !== "cone") return;
    const f = coneFrame(cone.geom);
    const x = 15 / f.slope; // where the radius is 15
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: cone.ref, placement: "radial", centers: [{ x, y: 0 }], diameter: "4", depth: "3", style: "plain" };
    const p = frustum();
    const blind = rebuild({ ...p, features: [...p.features, hole] }, FRUSTUM);
    expect(blind.status.get("Hole001")).toEqual({ ok: true });
    const removed = volume(body) - volume(blind.bodies[0]!);
    // About a 4 dia x 3 deep plug (a little more: the cone falls away round the hole's rim).
    expect(removed).toBeGreaterThan(Math.PI * 4 * 3 * FACET * 0.98);
    expect(removed).toBeLessThan(Math.PI * 4 * 3 * 1.25);
    const bore = blind.bodies[0]!.faces.find((g) => g.geom.kind === "cylinder" && Math.abs(g.geom.radius - 2) < 1e-6)!;
    expect(bore).toBeDefined();
    // The bore's axis is the cone's normal there.
    if (bore.geom.kind === "cylinder") expect(Math.abs(dot(bore.geom.axis, surfaceNormal(f, 0)))).toBeCloseTo(1);
    const through = rebuild({ ...p, features: [...p.features, { ...hole, extent: "through" }] }, FRUSTUM);
    expect(through.status.get("Hole001")).toEqual({ ok: true });
    expect(volume(body) - volume(through.bodies[0]!)).toBeGreaterThan(removed * 3);
    const toAxis = rebuild({ ...p, features: [...p.features, { ...hole, extent: "toAxis" }] }, FRUSTUM);
    expect(toAxis.status.get("Hole001")).toEqual({ ok: true });
    const dv = volume(body) - volume(toAxis.bodies[0]!);
    expect(dv).toBeGreaterThan(removed * 2);
    expect(dv).toBeLessThan(volume(body) - volume(through.bodies[0]!));
    // Too wide where the cone is narrow.
    const wide = rebuild({ ...p, features: [...p.features, { ...hole, diameter: "35" }] }, FRUSTUM);
    expect(wide.status.get("Hole001")?.error).toMatch(/too wide/);
  });

  it("takes a tangent work plane: touching along a slant line, through the apex; a sketch on it cuts a flat", () => {
    if (cone.geom.kind !== "cone") return;
    const f = coneFrame(cone.geom);
    const { frame, centerAt } = tangentFrame(body, cone, 90, 0);
    expect(dot(frame.n, frame.u)).toBeCloseTo(0);
    expect(dot(sub(f.origin, frame.origin), frame.n)).toBeCloseTo(0); // the apex is on it
    for (const r of [20, 15, 10]) expect(dot(sub(cylTo3d(f, { x: r / f.slope, y: 90 }), frame.origin), frame.n)).toBeCloseTo(0);
    // Any other point of the cone is behind the plane.
    expect(dot(sub(cylTo3d(f, { x: 15 / f.slope, y: 120 }), frame.origin), frame.n)).toBeLessThan(0);
    expect(dot(sub(centerAt, frame.origin), frame.n)).toBeCloseTo(0);
    const wp: WorkPlane = { id: "WorkPlane001", base: "XY", axis: "u", offset: "-2", angle: "90", on: { face: cone.ref, tangent: true } };
    const p = frustum();
    const r = rebuild({ ...p, planes: [wp] }, FRUSTUM);
    expect(r.planes.get("WorkPlane001")?.error).toBeUndefined();
    expect(r.planes.get("WorkPlane001")!.frame).not.toBeNull();
    // A hole on that plane goes in square to it (so square to the cone there).
    const at = cylTo3d(f, { x: 15 / f.slope, y: 90 });
    const pf = r.planes.get("WorkPlane001")!.frame!;
    const d = sub(at, pf.origin);
    const hole: HoleFeature = { id: "Hole001", type: "hole", face: planeRef("WorkPlane001"), centers: [{ x: dot(d, pf.u), y: dot(d, pf.v) }], diameter: "4", depth: "6", style: "plain" };
    const holed = rebuild({ ...p, planes: [wp], features: [...p.features, hole] }, FRUSTUM);
    expect(holed.status.get("Hole001")).toEqual({ ok: true });
    expect(volume(body) - volume(holed.bodies[0]!)).toBeGreaterThan(Math.PI * 4 * 3 * FACET);
  });
});
