import { describe, expect, it } from "vitest";
import { Polyline } from "../entities/polyline";
import { Circle } from "../entities/circle";
import { rebuild } from "../part/rebuild";
import { emptyPart } from "../part/types";
import type { HoleFeature, PartData } from "../part/types";
import type { ViewAxes, ViewCurve, ViewLine } from "./hlr";
import { viewBodies } from "./hlr";

const FRONT: ViewAxes = { dir: { x: 0, y: -1, z: 0 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } };
const TOP: ViewAxes = { dir: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };

const rect = (w: number, h: number): Record<string, unknown> =>
  new Polyline(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ].map((point) => ({ point, bulge: 0 })),
    true,
  ).serialize();

/** 100 x 60 x 20 plate (Z up; drawing Y-down, so the plate spans y -60..0),
 *  optionally with a hole in its top face. */
function plate(hole?: Omit<HoleFeature, "id" | "type" | "face">): PartData {
  const part = emptyPart();
  part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "20", direction: "normal", operation: "new" });
  if (hole !== undefined) part.features.push({ id: "Hole001", type: "hole", face: { feature: "Extrude001", role: "end", index: "0" }, ...hole });
  return part;
}

const len = (c: ViewCurve): number => {
  if (c.kind === "line") return Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
  if (c.kind === "arc") return c.r * (c.a1 - c.a0);
  let s = 0;
  for (let k = 0; k + 1 < c.pts.length; k++) s += Math.hypot(c.pts[k + 1]!.x - c.pts[k]!.x, c.pts[k + 1]!.y - c.pts[k]!.y);
  return s;
};
const total = (lines: ViewLine[], hidden: boolean): number => lines.filter((l) => l.hidden === hidden).reduce((s, l) => s + len(l.curve), 0);
/** Vertical line pieces at x (either visibility), summed length. */
const verticalAt = (lines: ViewLine[], x: number, hidden: boolean): number =>
  lines
    .filter((l) => l.hidden === hidden && l.curve.kind === "line" && Math.abs(l.curve.a.x - x) < 1e-6 && Math.abs(l.curve.b.x - x) < 1e-6)
    .reduce((s, l) => s + len(l.curve), 0);

describe("viewBodies (hidden-line views)", () => {
  it("plain plate, front view: just its 100 x 20 outline, nothing hidden", () => {
    const b = rebuild(plate(), [rect(100, 60)]).bodies;
    const v = viewBodies(b, FRONT);
    expect(total(v.lines, false)).toBeCloseTo(240, 6);
    expect(total(v.lines, true)).toBe(0);
  });

  it("through hole, front view: the bore shows as two hidden lines, outline unchanged", () => {
    const b = rebuild(plate({ centers: [{ x: 50, y: -30 }], diameter: "10", depth: "5", extent: "through", style: "plain" }), [rect(100, 60)]).bodies;
    const v = viewBodies(b, FRONT);
    expect(total(v.lines, false)).toBeCloseTo(240, 6);
    expect(verticalAt(v.lines, 45, true)).toBeCloseTo(20, 3);
    expect(verticalAt(v.lines, 55, true)).toBeCloseTo(20, 3);
    expect(total(v.lines, true)).toBeCloseTo(40, 3);
    // Seen from the side, the bore's axis is a centre line.
    expect(v.centerLines).toHaveLength(1);
    expect(v.centerLines[0]!.a.x).toBeCloseTo(50, 9);
  });

  it("through hole, top view: a true visible circle and a centre mark", () => {
    const b = rebuild(plate({ centers: [{ x: 50, y: -30 }], diameter: "10", depth: "5", extent: "through", style: "plain" }), [rect(100, 60)]).bodies;
    const v = viewBodies(b, TOP);
    const circles = v.lines.filter((l) => l.curve.kind === "arc");
    expect(circles.length).toBeGreaterThanOrEqual(1);
    for (const c of circles) {
      if (c.curve.kind !== "arc") continue;
      expect(c.curve.r).toBe(5);
      expect(c.hidden).toBe(false);
      expect(c.curve.center.x).toBeCloseTo(50, 9);
      expect(c.curve.center.y).toBeCloseTo(-30, 9);
    }
    // The bottom rim lies right under the top one: never drawn twice / dashed.
    expect(total(v.lines, true)).toBe(0);
    expect(v.centerMarks).toHaveLength(1);
    expect(v.centerMarks[0]!.center.x).toBeCloseTo(50, 9);
    expect(v.centerMarks[0]!.center.y).toBeCloseTo(-30, 9);
    expect(v.centerMarks[0]!.r).toBeCloseTo(5, 9);
  });

  it("blind hole from the top, front view: hidden bore stops at its depth", () => {
    const b = rebuild(plate({ centers: [{ x: 50, y: -30 }], diameter: "10", depth: "8", style: "plain" }), [rect(100, 60)]).bodies;
    const v = viewBodies(b, FRONT);
    expect(total(v.lines, false)).toBeCloseTo(240, 6);
    expect(verticalAt(v.lines, 45, true)).toBeCloseTo(8, 3);
    expect(verticalAt(v.lines, 55, true)).toBeCloseTo(8, 3);
  });

  it("shaft from the side: outline lines are visible and stop where a cross hole cuts them", () => {
    const part = emptyPart();
    part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "80", direction: "normal", operation: "new" });
    const plain = rebuild(part, [new Circle({ x: 0, y: 0 }, 20).serialize()]).bodies;
    // Front view: outline lines at x = +-20, 80 long each; ends are the rims (edge-on).
    const v = viewBodies(plain, FRONT);
    expect(verticalAt(v.lines, 20, false) + verticalAt(v.lines, -20, false)).toBeCloseTo(160, 3);
    expect(total(v.lines, true)).toBe(0);

    part.features.push({
      id: "Hole001",
      type: "hole",
      placement: "radial",
      face: { feature: "Extrude001", role: "side", index: "0.0.0" },
      centers: [{ x: 40, y: 0 }],
      diameter: "10",
      depth: "5",
      extent: "through",
      style: "plain",
    });
    const drilled = rebuild(part, [new Circle({ x: 0, y: 0 }, 20).serialize()]).bodies;
    const w = viewBodies(drilled, FRONT);
    // The cross hole runs along X (angle 0): it breaks both side outlines
    // over its Ø10.
    const sides = verticalAt(w.lines, 20, false) + verticalAt(w.lines, -20, false);
    expect(sides).toBeLessThan(160 - 2 * 9.9);
    expect(sides).toBeGreaterThan(160 - 2 * 10.1);
  });
});
