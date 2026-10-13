import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../../testUtils/fakeEngine";
import { ExtendGripCommand } from "./extendGrip";
import { Line } from "../../entities/line";

/** A triangle like the one in the bug report: a top edge, a slanted edge,
 *  and a vertical line hanging from the top edge's right end. */
function triangle() {
  const engine = makeTestEngine();
  const top = new Line({ x: 0, y: 0 }, { x: 500, y: 0 });
  const slant = new Line({ x: 0, y: 0 }, { x: 480, y: 180 });
  const vertical = new Line({ x: 500, y: 0 }, { x: 500, y: 180 });
  for (const line of [top, slant, vertical]) engine.document.addEntity(line);
  const cmd = new ExtendGripCommand(engine);
  cmd.start();
  cmd.begin(vertical, false);
  return { engine, slant, vertical, cmd };
}

describe("ExtendGripCommand snapping", () => {
  it("a point on a neighbouring line is not a Perpendicular snap just because the cursor is on it", () => {
    const { engine, cmd } = triangle();
    // On the slanted line, well away from its ends, midpoint and the real foot.
    cmd.mouseMove({ x: 120, y: 45 });
    expect(engine.activeSnapType).toBe("NEAREST");
    cmd.mouseMove({ x: 360, y: 135 });
    expect(engine.activeSnapType).toBe("NEAREST");
  });

  it("Perpendicular is the one foot from the end that stays put", () => {
    const { engine, slant, cmd } = triangle();
    // Foot of (500,0) on the slanted line.
    const d = { x: slant.endPoint.x, y: slant.endPoint.y };
    const u = (500 * d.x) / (d.x * d.x + d.y * d.y);
    const foot = { x: u * d.x, y: u * d.y };
    cmd.mouseMove({ x: foot.x + 0.5, y: foot.y });
    expect(engine.activeSnapType).toBe("PERPENDICULAR");
    expect(engine.activeSnapPoint!.x).toBeCloseTo(foot.x, 6);
    expect(engine.activeSnapPoint!.y).toBeCloseTo(foot.y, 6);
  });

  it("dragging along the line itself only changes its length, with no snap onto its own old shape", () => {
    const { engine, vertical, cmd } = triangle();
    cmd.leftClick({ x: 503, y: 90 }); // beside its own midpoint
    expect(engine.activeSnapType).toBeNull();
    expect(vertical.endPoint).toEqual({ x: 500, y: 90 });
  });

  it("never collapses onto the fixed end, where a neighbour's corner is", () => {
    const { vertical, cmd } = triangle();
    cmd.leftClick({ x: 500.5, y: 0.5 });
    expect(Math.hypot(vertical.endPoint.x - 500, vertical.endPoint.y)).toBeGreaterThan(0);
  });
});
