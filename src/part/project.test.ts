import { describe, expect, it } from "vitest";
import { Circle } from "../entities/circle";
import { Ellipse } from "../entities/ellipse";
import { Line } from "../entities/line";
import { Polyline } from "../entities/polyline";
import { findProfiles } from "./profile";
import { extrudeRegions } from "./kernel/extrude";
import { planeFrame, workPlaneFrame } from "./plane";
import { projectBodies } from "./project";

const rect = (w: number, h: number): Polyline =>
  new Polyline(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ].map((point) => ({ point, bulge: 0 })),
    true,
  );

/** 100 x 60 plate, 20 thick, with a R15 hole, on XY. */
function plate() {
  const { regions } = findProfiles([rect(100, 60), new Circle({ x: 50, y: 30 }, 15)]);
  return extrudeRegions("E", regions, planeFrame({ base: "XY", offset: 0 }), 0, 20);
}

describe("projectBodies", () => {
  it("top view (XY): outline rectangle and the hole as a true circle", () => {
    const ents = projectBodies([plate()], planeFrame({ base: "XY", offset: 0 }));
    const circles = ents.filter((e): e is Circle => e instanceof Circle);
    expect(circles.length).toBeGreaterThanOrEqual(1);
    expect(circles[0]!.radius).toBe(15);
    expect(circles[0]!.center.x).toBeCloseTo(50);
    expect(circles[0]!.center.y).toBeCloseTo(30);
    // Top and bottom outlines coincide in plan -> deduplicated to 4 lines.
    expect(ents.filter((e) => e instanceof Line)).toHaveLength(4);
  });

  it("front view (XZ): plate is a 100 x 20 rectangle, hole shows as silhouettes", () => {
    const ents = projectBodies([plate()], planeFrame({ base: "XZ", offset: 0 }));
    const lines = ents.filter((e): e is Line => e instanceof Line);
    const xs = lines.flatMap((l) => [l.startPoint.x, l.endPoint.x]);
    const ys = lines.flatMap((l) => [l.startPoint.y, l.endPoint.y]);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(100);
    // Sketch coords are Y-down: plate height 20 appears as y in [-20, 0].
    expect(Math.min(...ys)).toBeCloseTo(-20);
    expect(Math.max(...ys)).toBeCloseTo(0);
    // Hole silhouettes: vertical lines at x = 35 and x = 65.
    const vertical = lines.filter((l) => Math.abs(l.startPoint.x - l.endPoint.x) < 1e-6).map((l) => l.startPoint.x);
    expect(vertical.some((x) => Math.abs(x - 35) < 1e-6)).toBe(true);
    expect(vertical.some((x) => Math.abs(x - 65) < 1e-6)).toBe(true);
    // Hole rims are edge-on circles -> lines, not ellipses.
    expect(ents.some((e) => e instanceof Ellipse)).toBe(false);
  });

  it("a tilted plane sees the hole rim as an exact ellipse", () => {
    const ents = projectBodies([plate()], workPlaneFrame({ base: "XY", axis: "u" }, 0, 60));
    const ellipses = ents.filter((e): e is Ellipse => e instanceof Ellipse);
    expect(ellipses.length).toBeGreaterThan(0);
    const e = ellipses[0]!;
    expect(Math.max(e.radiusX, e.radiusY)).toBeCloseTo(15);
    expect(Math.min(e.radiusX, e.radiusY)).toBeCloseTo(15 * Math.cos(Math.PI / 3));
  });
});
