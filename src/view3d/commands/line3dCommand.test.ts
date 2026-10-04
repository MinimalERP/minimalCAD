import { describe, expect, it } from "vitest";
import { Line3dCommand } from "./line3dCommand";
import type { ModelContext } from "./context";
import type { Hit } from "../modelView";
import type { Vec3 } from "../../part/vec3";

type PointHit = Extract<Hit, { kind: "point3d" }>;

/** A command over an empty part, with the last cursor point the view was shown. */
function setup(ortho: { on: boolean }): { cmd: Line3dCommand; hover: (hit: PointHit) => void; cursor: () => Vec3 | null; status: () => string } {
  let hover: ((hit: PointHit | null) => void) | null = null;
  let cursor: Vec3 | null = null;
  let status = "";
  const view = {
    setOriginPlanesVisible: () => {},
    setPoint3dMode: () => {},
    setPoint3dCandidates: () => {},
    setChainPreview: (_chain: unknown, _rubber: unknown, c: { p: Vec3 } | null) => {
      cursor = c === null ? null : c.p;
    },
    setPickMode: () => {},
    pixelSize: () => 0.1,
    set onPoint3dHover(fn: ((hit: PointHit | null) => void) | null) {
      hover = fn;
    },
  };
  const ctx = {
    view,
    result: () => null,
    ortho: () => ortho.on,
    status: (_c: string, text: string) => {
      status = text;
    },
  } as unknown as ModelContext;
  const cmd = new Line3dCommand(ctx);
  return { cmd, hover: (hit) => hover!(hit), cursor: () => cursor, status: () => status };
}

/** Looking straight down -Z at (x, y). */
const down = (x: number, y: number): PointHit => ({ kind: "point3d", ray: { o: { x, y, z: 100 }, d: { x: 0, y: 0, z: -1 } }, snap: null, at: null });

describe("Line3dCommand", () => {
  it("lands on an origin axis line anywhere along it, before and after the first point", () => {
    const t = setup({ on: false });
    t.hover(down(40, 0.5)); // 5 px off the X axis
    expect(t.cursor()).toEqual({ x: 40, y: 0, z: 0 });
    expect(t.status()).toContain("X axis");

    t.cmd.onPick(down(40, 0.5));
    t.hover(down(0.3, 25));
    expect(t.cursor()!.x).toBeCloseTo(0);
    expect(t.cursor()!.y).toBeCloseTo(25);
    expect(t.status()).toContain("Y axis");

    t.hover(down(30, 30)); // nowhere near an axis: free
    expect(t.cursor()!.x).toBeCloseTo(30);
  });

  it("keeps catching the axes once the loop has its plane, laid flat onto it", () => {
    const t = setup({ on: false });
    const at = (x: number, y: number, z: number): PointHit => ({ kind: "point3d", ray: { o: { x, y, z: 100 }, d: { x: 0, y: 0, z: -1 } }, snap: { p: { x, y, z }, kind: "end" }, at: null });
    // A loop on the plane z = 20, away from the origin.
    t.cmd.onPick(at(10, 10, 20));
    t.cmd.onPick(at(60, 10, 20));
    t.cmd.onPick(at(60, 50, 20));
    t.hover(down(30, 0.4)); // over the X axis, seen from above
    expect(t.cursor()).toEqual({ x: 30, y: 0, z: 20 });
    expect(t.status()).toContain("X axis");
    t.hover(down(60.3, 80)); // along Y from the last point
    expect(t.cursor()!.x).toBeCloseTo(60);
    expect(t.cursor()!.z).toBeCloseTo(20);
  });

  it("Ortho runs the next point along an axis from the last one", () => {
    const ortho = { on: true };
    const t = setup(ortho);
    t.cmd.onPick(down(10, 10));
    t.hover(down(50, 14));
    expect(t.cursor()!.x).toBeCloseTo(50);
    expect(t.cursor()!.y).toBeCloseTo(10);
    t.hover(down(13, 60));
    expect(t.cursor()!.x).toBeCloseTo(10);
    expect(t.cursor()!.y).toBeCloseTo(60);

    // Still snaps with Ortho on: pointing at the Y axis gives where the
    // ortho line (along X from the last point) meets it.
    t.hover(down(0.4, 12));
    expect(t.cursor()!.x).toBeCloseTo(0);
    expect(t.cursor()!.y).toBeCloseTo(10);
    expect(t.status()).toContain("on the Y axis");
    t.hover(down(50, 14)); // away from the axes again: plain Ortho
    expect(t.status()).toContain("Ortho - along X");

    ortho.on = false;
    t.hover(down(50, 14));
    expect(t.cursor()!.y).toBeCloseTo(14);
    // Off, but close to the X line through the last point: it still catches.
    t.hover(down(50, 10.4));
    expect(t.cursor()!.y).toBeCloseTo(10);
    expect(t.status()).toContain("Along X");
  });
});
