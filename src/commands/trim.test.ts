import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { ExtendCommand, TrimCommand } from "./trim";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Ellipse } from "../entities/ellipse";

// These five scenarios directly mirror the scripted Python probes used to
// verify (and fix) commands/trim.py's three real bugs earlier this session:
// gap-tolerance near-touch trimming, merge-not-fragment on multi-crossing
// survivors, and whole-entity deletion when a line's only cutting edges
// touch it exactly at its own two endpoints (e.g. a rectangle corner).
import { RectangleCommand } from "./rectangle";
import { Polyline } from "../entities/polyline";

describe("TrimCommand", () => {
  it("a click near an entity with no real cutting edge nearby does nothing", () => {
    const engine = makeTestEngine();
    const target = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const far = new Line({ x: -500, y: -500 }, { x: -400, y: -500 });
    engine.document.addEntity(target);
    engine.document.addEntity(far);

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 50, y: 0 });

    expect(engine.document.entities).toHaveLength(2); // untouched
  });

  it("trims a line whose only cutting edge falls just short of it, within pick tolerance", () => {
    const engine = makeTestEngine();
    const target = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const cutter = new Line({ x: 50, y: 0.02 }, { x: 50, y: 50 }); // endpoint 0.02 above the target
    engine.document.addEntity(target);
    engine.document.addEntity(cutter);

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 75, y: 0 }); // click the right half

    const remnant = engine.document.entities.find(
      (e): e is Line => e instanceof Line && Math.abs(e.startPoint.y) < 1 && Math.abs(e.endPoint.y) < 1,
    );
    expect(remnant).toBeDefined();
    expect(remnant!.endPoint.x).toBeCloseTo(50, 6);
  });

  it("trimming a middle segment merges the untouched survivors instead of fragmenting them", () => {
    const engine = makeTestEngine();
    const target = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    for (const x of [20, 40, 60, 80]) {
      engine.document.addEntity(new Line({ x, y: -50 }, { x, y: 50 }));
    }
    engine.document.addEntity(target);

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 50, y: 0 }); // remove the [40,60] middle segment

    const remnants = engine.document.entities
      .filter((e): e is Line => e instanceof Line && e.startPoint.y === 0 && e.endPoint.y === 0)
      .map((e) => [e.startPoint.x, e.endPoint.x])
      .sort((a, b) => a[0]! - b[0]!);
    expect(remnants).toEqual([
      [0, 40],
      [60, 100],
    ]);
  });

  it("a circle's first trim produces exactly one spanning Arc, not one fragment per crossing", () => {
    const engine = makeTestEngine();
    const circle = new Circle({ x: 0, y: 0 }, 50);
    engine.document.addEntity(circle);
    engine.document.addEntity(new Line({ x: -100, y: 10 }, { x: 100, y: 10 }));
    engine.document.addEntity(new Line({ x: -100, y: -10 }, { x: 100, y: -10 }));

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 50 }); // top sliver

    const arcs = engine.document.entities.filter((e): e is Arc => e instanceof Arc);
    expect(arcs).toHaveLength(1);
  });

  it("a rectangle side whose only cutting edges touch it at its own two corners deletes entirely", () => {
    const engine = makeTestEngine();
    const p1 = { x: 0, y: 0 }, p2 = { x: 100, y: 0 }, p3 = { x: 100, y: 60 }, p4 = { x: 0, y: 60 };
    engine.document.addEntity(new Line(p1, p2)); // bottom -- the one we'll click
    engine.document.addEntity(new Line(p2, p3));
    engine.document.addEntity(new Line(p3, p4));
    engine.document.addEntity(new Line(p4, p1));

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 50, y: 0 }); // click the bottom side

    expect(engine.document.entities).toHaveLength(3); // bottom side fully deleted
  });

  it("an ellipse's first trim (cut by two lines) produces exactly one spanning elliptical arc", () => {
    const engine = makeTestEngine();
    const ellipse = new Ellipse({ x: 0, y: 0 }, 50, 25);
    engine.document.addEntity(ellipse);
    engine.document.addEntity(new Line({ x: -100, y: 10 }, { x: 100, y: 10 }));
    engine.document.addEntity(new Line({ x: -100, y: -10 }, { x: 100, y: -10 }));

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 25 }); // top sliver

    const arcs = engine.document.entities.filter((e): e is Ellipse => e instanceof Ellipse);
    expect(arcs).toHaveLength(1);
    // The surviving piece should still cover the bottom of the ellipse
    // (e.g. its own -y quadrant point), not the trimmed-away top sliver.
    expect(arcs[0]!.hitTest({ x: 0, y: -25 }, 1)).toBe(true);
  });

  it("trims a line at the point it crosses an ellipse", () => {
    const engine = makeTestEngine();
    const ellipse = new Ellipse({ x: 0, y: 0 }, 20, 10);
    const line = new Line({ x: -50, y: 0 }, { x: 50, y: 0 });
    engine.document.addEntity(ellipse);
    engine.document.addEntity(line);

    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 35, y: 0 }); // click the right-hand remainder, outside the ellipse

    // The line crosses the ellipse at x=-20 AND x=20; clicking past the
    // x=20 crossing removes only that [20,50] piece -- per trim's
    // documented "merge, don't fragment" design, the untouched remainder
    // survives as ONE piece spanning back through the interior x=-20
    // crossing, not split into two fragments there.
    const remnant = engine.document.entities.find(
      (e): e is Line => e instanceof Line && Math.abs(e.startPoint.y) < 1e-6 && Math.abs(e.endPoint.y) < 1e-6,
    );
    expect(remnant).toBeDefined();
    const xs = [remnant!.startPoint.x, remnant!.endPoint.x].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-50, 6);
    expect(xs[1]).toBeCloseTo(20, 2);
  });
});

describe("TrimCommand: dragging, and polylines", () => {
  const L = (x1: number, y1: number, x2: number, y2: number) => new Line({ x: x1, y: y1 }, { x: x2, y: y2 });

  it("a drag trims everything the stroke crosses, as one undo step", () => {
    const engine = makeTestEngine();
    for (const l of [L(-50, 0, 50, 0), L(-50, 10, 50, 10), L(-10, -20, -10, 30), L(10, -20, 10, 30)]) engine.document.addEntity(l);
    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: -15 }); // on nothing
    cmd.mouseMove({ x: 0, y: 5 }); // across the first horizontal
    cmd.mouseMove({ x: 0, y: 15 }); // and the second
    cmd.leftRelease();

    const horizontals = engine.document.entities.filter((e): e is Line => e instanceof Line && e.startPoint.y === e.endPoint.y);
    expect(horizontals).toHaveLength(4); // each lost its middle, between the two verticals
    for (const h of horizontals) expect(Math.min(Math.abs(h.startPoint.x), Math.abs(h.endPoint.x))).toBeCloseTo(10, 6);
    expect(engine.document.entities).toHaveLength(6);

    engine.document.restoreFromDict(engine.undo.undo(engine.document.toDict())!);
    expect(engine.document.entities).toHaveLength(4);
    expect(engine.undo.undo(engine.document.toDict())).toBeNull();
  });

  it("moving without the button held trims nothing", () => {
    const engine = makeTestEngine();
    for (const l of [L(-50, 0, 50, 0), L(-10, -20, -10, 30), L(10, -20, 10, 30)]) engine.document.addEntity(l);
    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.mouseMove({ x: 0, y: -5 });
    cmd.mouseMove({ x: 0, y: 5 });
    expect(engine.document.entities).toHaveLength(3);
  });

  it("a rectangle cuts a line through it, and its own side can be trimmed: what is left stays one outline", () => {
    const engine = makeTestEngine();
    const rc = new RectangleCommand(engine);
    rc.start();
    rc.leftClick({ x: 0, y: 0 });
    rc.leftClick({ x: 100, y: 50 });
    rc.cancel();
    engine.document.addEntity(L(50, -20, 50, 70));
    const cmd = new TrimCommand(engine);
    cmd.start();

    // the line's part inside the rectangle goes: the rectangle's sides are the cutting edges
    cmd.leftClick({ x: 50, y: 25 });
    cmd.leftRelease();
    const lines = () => engine.document.entities.filter((e): e is Line => e instanceof Line);
    expect(lines()).toHaveLength(2);
    expect(engine.document.entities.filter((e) => e instanceof Polyline)).toHaveLength(1);

    // the left half of the bottom side goes, up to where the line meets it
    cmd.leftClick({ x: 25, y: 0 });
    cmd.leftRelease();
    const outlines = engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]!.closed).toBe(false);
    expect(outlines[0]!.vertices).toHaveLength(5);
    expect(lines()).toHaveLength(2); // the two loose pieces of the line were not swallowed
  });
});

describe("TrimCommand: fence, extend", () => {
  const L = (x1: number, y1: number, x2: number, y2: number) => new Line({ x: x1, y: y1 }, { x: x2, y: y2 });

  it("two clicks on empty space make a fence: everything the line between them crosses is trimmed, as one undo step", () => {
    const engine = makeTestEngine();
    for (const l of [L(-50, 0, 50, 0), L(-50, 10, 50, 10), L(-10, -20, -10, 30), L(10, -20, 10, 30)]) engine.document.addEntity(l);
    const cmd = new TrimCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: -15 });
    cmd.leftRelease(); // a click, not a drag: the fence starts here
    expect(engine.document.entities).toHaveLength(4);
    cmd.mouseMove({ x: 0, y: 15 });
    cmd.leftClick({ x: 0, y: 15 });
    cmd.leftRelease();
    expect(engine.document.entities).toHaveLength(6);
    engine.document.restoreFromDict(engine.undo.undo(engine.document.toDict())!);
    expect(engine.document.entities).toHaveLength(4);
  });

  it("Shift extends instead: the end of a line nearest the click runs out to the next edge", () => {
    const engine = makeTestEngine();
    const short = L(0, 0, 30, 0);
    engine.document.addEntity(short);
    engine.document.addEntity(L(50, -20, 50, 20)); // the edge in its way
    engine.document.addEntity(L(80, -20, 80, 20)); // a farther one
    const cmd = new TrimCommand(engine);
    cmd.start();
    engine.shiftHeld = true;
    cmd.leftClick({ x: 25, y: 0 }); // near its right end
    cmd.leftRelease();
    expect(short.endPoint.x).toBeCloseTo(50, 6);
    expect(short.startPoint.x).toBe(0);
    engine.shiftHeld = false;
  });

  it("EXTEND extends on a plain click, an arc too, and says so when nothing is in the way", () => {
    const engine = makeTestEngine();
    const arc = new Arc({ x: 0, y: 0 }, 10, 0, Math.PI / 2); // from (10,0) round to (0,10)
    engine.document.addEntity(arc);
    engine.document.addEntity(L(-20, 0, -5, 0)); // the circle the arc lies on meets it at (-10,0)
    const cmd = new ExtendCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 10 * Math.cos(1.4), y: 10 * Math.sin(1.4) }); // near the arc's end
    cmd.leftRelease();
    expect(arc.endAngle).toBeCloseTo(Math.PI, 6);
    expect(arc.startAngle).toBeCloseTo(0, 6);

    const lonely = L(100, 100, 120, 100);
    engine.document.addEntity(lonely);
    cmd.leftClick({ x: 118, y: 100 });
    cmd.leftRelease();
    expect(lonely.endPoint.x).toBe(120);
  });
});
