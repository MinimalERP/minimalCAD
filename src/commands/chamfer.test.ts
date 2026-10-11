import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { ChamferCommand } from "./chamfer";
import { RectangleCommand } from "./rectangle";
import { Polyline } from "../entities/polyline";

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

  it("chamfers two sides of a rectangle, and the rectangle stays one closed outline with the new corner in it", () => {
    const engine = rectangle();
    const cmd = new ChamferCommand(engine);
    cmd.start();
    cmd.textInput("10");
    cmd.leftClick({ x: 50, y: 0 }); // the bottom side
    cmd.leftClick({ x: 0, y: 25 }); // the left side

    expect(engine.document.entities).toHaveLength(1);
    const [outline] = polylines(engine);
    expect(outline!.closed).toBe(true);
    expect(outline!.vertices).toHaveLength(5); // four corners, one of them now two points
    expect(outline!.vertices.filter((v) => v.bulge !== 0)).toHaveLength(0);
    const pts = outline!.vertices.map((v) => `${Math.round(v.point.x)},${Math.round(v.point.y)}`).sort();
    expect(pts).toEqual(["0,10", "0,50", "10,0", "100,0", "100,50"]);

    // one undo step brings the plain rectangle back
    engine.document.restoreFromDict(engine.undo.undo(engine.document.toDict())!);
    expect(polylines(engine)[0]!.vertices).toHaveLength(4);
    expect(engine.document.entities).toHaveLength(1);
  });

  it("Esc after picking one side leaves the rectangle as it was", () => {
    const engine = rectangle();
    const cmd = new ChamferCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 50, y: 0 });
    expect(polylines(engine)).toHaveLength(0); // open while the command runs
    cmd.cancel();
    expect(engine.document.entities).toHaveLength(1);
    expect(polylines(engine)[0]!.closed).toBe(true);
    expect(polylines(engine)[0]!.vertices).toHaveLength(4);
  });
});
