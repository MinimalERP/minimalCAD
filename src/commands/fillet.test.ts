import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { FilletCommand } from "./fillet";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
import { RectangleCommand } from "./rectangle";
import { Polyline } from "../entities/polyline";

describe("FilletCommand", () => {
  it("rounds a right-angle corner with the expected tangent points and arc radius", () => {
    const engine = makeTestEngine();
    // A right-angle corner at the origin: one line along +X, one along +Y.
    const l1 = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const l2 = new Line({ x: 0, y: 0 }, { x: 0, y: 100 });
    engine.document.addEntity(l1);
    engine.document.addEntity(l2);

    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.textInput("10"); // radius 10
    cmd.leftClick({ x: 50, y: 0 }); // pick l1 near its far end
    cmd.leftClick({ x: 0, y: 50 }); // pick l2 near its far end

    const lines = engine.document.entities.filter((e): e is Line => e instanceof Line);
    const arcs = engine.document.entities.filter((e): e is Arc => e instanceof Arc);
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.radius).toBeCloseTo(10, 6);

    // For a right-angle corner, the tangent setback distance equals the radius exactly.
    const trimmedEnds = lines.map((l) => (Math.hypot(l.startPoint.x, l.startPoint.y) < Math.hypot(l.endPoint.x, l.endPoint.y) ? l.startPoint : l.endPoint));
    const nearCorner = trimmedEnds.filter((p) => Math.hypot(p.x, p.y) < 50);
    expect(nearCorner).toHaveLength(2);
    for (const p of nearCorner) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 6);
    }
  });

  it("radius 0 trims to a sharp corner with no arc", () => {
    const engine = makeTestEngine();
    const l1 = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const l2 = new Line({ x: 0, y: 0 }, { x: 0, y: 100 });
    engine.document.addEntity(l1);
    engine.document.addEntity(l2);

    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.textInput("0");
    cmd.leftClick({ x: 50, y: 0 });
    cmd.leftClick({ x: 0, y: 50 });

    const arcs = engine.document.entities.filter((e): e is Arc => e instanceof Arc);
    expect(arcs).toHaveLength(0);

    const lines = engine.document.entities.filter((e): e is Line => e instanceof Line);
    // Both trimmed lines should now meet exactly at the origin.
    const atOrigin = lines.filter(
      (l) =>
        (Math.abs(l.startPoint.x) < 1e-6 && Math.abs(l.startPoint.y) < 1e-6) ||
        (Math.abs(l.endPoint.x) < 1e-6 && Math.abs(l.endPoint.y) < 1e-6),
    );
    expect(atOrigin).toHaveLength(2);
  });

  it("rejects a radius too large for the available line length", () => {
    const engine = makeTestEngine();
    const l1 = new Line({ x: 0, y: 0 }, { x: 5, y: 0 }); // short line, only 5 units
    const l2 = new Line({ x: 0, y: 0 }, { x: 0, y: 100 });
    engine.document.addEntity(l1);
    engine.document.addEntity(l2);

    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.textInput("10"); // radius bigger than l1's whole length
    cmd.leftClick({ x: 2, y: 0 });
    cmd.leftClick({ x: 0, y: 50 });

    // Nothing should have changed -- both original lines still present, no arc added.
    expect(engine.document.entities).toHaveLength(2);
    expect(engine.document.entities.filter((e) => e instanceof Arc)).toHaveLength(0);
  });

  it("Line-Arc: fillets a hand-verifiable corner with a true tangency check", () => {
    // A quarter-plus arc (extra margin on both ends so the tangent point,
    // at angle 0, lands strictly interior to the span) and a vertical line
    // 20 units to its right -- radius 10 exactly bridges the gap, so the
    // resulting geometry is exactly hand-derivable:
    //   offset arc radius  = 50 + 10 = 60 (line click is outside the arc -> grow)
    //   offset line        = x = 70 - 10 = 60 (moved toward the arc)
    //   intersection of (x=60) with (radius 60 circle at origin) = (60, 0) exactly (tangent)
    const engine = makeTestEngine();
    const arc = new Arc({ x: 0, y: 0 }, 50, -0.5, Math.PI / 2 + 0.5);
    const line = new Line({ x: 70, y: -50 }, { x: 70, y: 50 });
    engine.document.addEntity(arc);
    engine.document.addEntity(line);

    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.textInput("10");
    // Click the arc well within its kept portion (away from the tangent point at angle 0).
    const clickArc = { x: 50 * Math.cos(1.0), y: 50 * Math.sin(1.0) };
    cmd.leftClick(clickArc);
    // Click the upper half of the line -- keeps the (70,50) end.
    cmd.leftClick({ x: 70, y: 20 });

    const arcs = engine.document.entities.filter((e): e is Arc => e instanceof Arc);
    const lines = engine.document.entities.filter((e): e is Line => e instanceof Line);
    expect(lines).toHaveLength(1);
    // Trimmed arc (original, radius 50) + connector fillet arc (radius 10).
    expect(arcs).toHaveLength(2);

    const connector = arcs.find((a) => Math.abs(a.radius - 10) < 1e-6);
    const trimmedArc = arcs.find((a) => Math.abs(a.radius - 50) < 1e-6);
    expect(connector).toBeDefined();
    expect(trimmedArc).toBeDefined();

    // The connector's center must be exactly (60, 0): tangent to both the
    // original 50-radius arc (external tangency: 50+10=60 apart) and the
    // original line at x=70 (perpendicular distance exactly 10).
    expect(connector!.center.x).toBeCloseTo(60, 6);
    expect(connector!.center.y).toBeCloseTo(0, 6);
    expect(dist(connector!.center, arc.center)).toBeCloseTo(60, 6);

    // The trimmed line survives as the upper half, now starting at the tangent point (70,0).
    expect(lines[0]!.startPoint.y).toBeCloseTo(0, 6);
    expect(lines[0]!.startPoint.x).toBeCloseTo(70, 6);
    expect(lines[0]!.endPoint).toEqual({ x: 70, y: 50 });

    // The trimmed arc's own kept span still passes through the click point's angle (1.0 rad).
    expect(trimmedArc!.angleInSweep(1.0)).toBe(true);
  });

  it("Arc-Arc: fillets two overlapping arcs with a hand-verifiable tangent-circle setup", () => {
    // Two radius-30 circles, centers 50 apart (so they genuinely overlap:
    // 30+30=60 > 50) -- clicks on each arc's OUTER side (facing away from
    // the other) grow both offset circles to 40 each. By symmetry the
    // offset circles (both grown to 40, centers 50 apart) must intersect on
    // the perpendicular bisector x=25, at y=+-sqrt(40^2-25^2) -- NOT
    // between the two circles along their centerline, since growing both
    // circles pushes their crossing point to the lens's top/bottom, not the
    // "outer" side either click happens to sit on. Both arcs are given a
    // nearly-full span so wherever that tangent point actually lands, it's
    // safely within each arc's own sweep.
    const engine = makeTestEngine();
    const arc1 = new Arc({ x: 0, y: 0 }, 30, 0.001, 2 * Math.PI - 0.001);
    const arc2 = new Arc({ x: 50, y: 0 }, 30, 0.001, 2 * Math.PI - 0.001);
    engine.document.addEntity(arc1);
    engine.document.addEntity(arc2);

    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.textInput("10");
    cmd.leftClick({ x: -30, y: 0 }); // arc1 at angle pi -- outside arc2, so arc2 grows
    cmd.leftClick({ x: 50 + 30 * Math.cos(0.05), y: 30 * Math.sin(0.05) }); // arc2 near angle 0 -- outside arc1, so arc1 grows

    const arcs = engine.document.entities.filter((e): e is Arc => e instanceof Arc);
    // 2 trimmed originals + 1 connector = 3.
    expect(arcs).toHaveLength(3);
    const connector = arcs.find((a) => Math.abs(a.radius - 10) < 1e-6)!;
    expect(connector).toBeDefined();

    // Both offset circles grew to 40 (clicks were outside each other's
    // original 30-radius circle) -- the fillet center must sit on the
    // perpendicular bisector (x=25) and be exactly 40 from each original
    // center (external tangency: 30+10).
    expect(connector.center.x).toBeCloseTo(25, 4);
    expect(dist(connector.center, arc1.center)).toBeCloseTo(40, 4);
    expect(dist(connector.center, arc2.center)).toBeCloseTo(40, 4);
  });
});

describe("on a rectangle (a polyline)", () => {
  const rectangle = () => {
    const engine = makeTestEngine();
    const rc = new RectangleCommand(engine);
    rc.start();
    rc.leftClick({ x: 0, y: 0 });
    rc.leftClick({ x: 100, y: 50 });
    rc.cancel();
    return engine;
  };
  const polylines = (engine: ReturnType<typeof makeTestEngine>) => engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);

  it("fillets two sides of a rectangle, and the rectangle stays one closed outline with the new corner in it", () => {
    const engine = rectangle();
    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.textInput("10");
    cmd.leftClick({ x: 50, y: 0 }); // the bottom side
    cmd.leftClick({ x: 0, y: 25 }); // the left side

    expect(engine.document.entities).toHaveLength(1);
    const [outline] = polylines(engine);
    expect(outline!.closed).toBe(true);
    expect(outline!.vertices).toHaveLength(5); // four corners, one of them now two points
    expect(outline!.vertices.filter((v) => v.bulge !== 0)).toHaveLength(1);
    const pts = outline!.vertices.map((v) => `${Math.round(v.point.x)},${Math.round(v.point.y)}`).sort();
    expect(pts).toEqual(["0,10", "0,50", "10,0", "100,0", "100,50"]);

    // one undo step brings the plain rectangle back
    engine.document.restoreFromDict(engine.undo.undo(engine.document.toDict())!);
    expect(polylines(engine)[0]!.vertices).toHaveLength(4);
    expect(engine.document.entities).toHaveLength(1);
  });

  it("Esc after picking one side leaves the rectangle as it was", () => {
    const engine = rectangle();
    const cmd = new FilletCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 50, y: 0 });
    expect(polylines(engine)).toHaveLength(0); // open while the command runs
    cmd.cancel();
    expect(engine.document.entities).toHaveLength(1);
    expect(polylines(engine)[0]!.closed).toBe(true);
    expect(polylines(engine)[0]!.vertices).toHaveLength(4);
  });
});
