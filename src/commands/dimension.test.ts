import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { LinearDimensionCommand } from "./linearDimension";
import { AlignedDimensionCommand } from "./alignedDimension";
import { AngularDimensionCommand } from "./angularDimension";
import { DiameterDimensionCommand, RadiusDimensionCommand } from "./radialDimension";
import { LeaderCommand } from "./leader";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Dimension } from "../entities/dimension";

function dims(engine: ReturnType<typeof makeTestEngine>): Dimension[] {
  return engine.document.entities.filter((e): e is Dimension => e instanceof Dimension);
}

describe("LinearDimensionCommand", () => {
  it("places a linear dimension from three clicks", () => {
    const engine = makeTestEngine();
    const cmd = new LinearDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 50, y: 0 });
    cmd.leftClick({ x: 25, y: 20 });

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.dimType).toBe("linear");
    expect(created[0]!.data.p1).toEqual({ x: 0, y: 0 });
    expect(created[0]!.data.p2).toEqual({ x: 50, y: 0 });
    expect(created[0]!.data.text_position).toEqual({ x: 25, y: 20 });
  });

  it("ignores a second click that coincides with the first (degenerate)", () => {
    const engine = makeTestEngine();
    const cmd = new LinearDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 0, y: 0 }); // same point -- rejected, stays in state 1
    cmd.leftClick({ x: 50, y: 0 }); // now this is treated as the (still-pending) second point
    cmd.leftClick({ x: 25, y: 20 });

    expect(dims(engine)).toHaveLength(1);
  });
});

describe("AlignedDimensionCommand", () => {
  it("places an aligned dimension from three clicks", () => {
    const engine = makeTestEngine();
    const cmd = new AlignedDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 30, y: 40 });
    cmd.leftClick({ x: 15, y: 25 });

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.dimType).toBe("aligned");
  });
});

describe("AngularDimensionCommand", () => {
  it("places an angular dimension between two picked, non-parallel lines", () => {
    const engine = makeTestEngine();
    const l1 = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    const l2 = new Line({ x: 0, y: 0 }, { x: 0, y: 10 });
    engine.document.addEntity(l1);
    engine.document.addEntity(l2);

    const cmd = new AngularDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 5, y: 0 }); // on l1
    cmd.leftClick({ x: 0, y: 5 }); // on l2
    cmd.leftClick({ x: 5, y: -5 }); // place the arc

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.dimType).toBe("angular");
    expect(created[0]!.data.line1_p1).toEqual(l1.startPoint);
    expect(created[0]!.data.line2_p1).toEqual(l2.startPoint);
  });

  it("resets to state 0 and reports parallel lines instead of placing anything", () => {
    const engine = makeTestEngine();
    const l1 = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    const l2 = new Line({ x: 0, y: 5 }, { x: 10, y: 5 });
    engine.document.addEntity(l1);
    engine.document.addEntity(l2);

    const cmd = new AngularDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 5, y: 0 });
    cmd.leftClick({ x: 5, y: 5 });
    cmd.leftClick({ x: 5, y: -5 }); // would only place if state had advanced to 2

    expect(dims(engine)).toHaveLength(0);
  });
});

describe("DiameterDimensionCommand / RadiusDimensionCommand", () => {
  it("places a diameter dimension whose radius_point sits on the circle boundary toward the click", () => {
    const engine = makeTestEngine();
    const circle = new Circle({ x: 0, y: 0 }, 10);
    engine.document.addEntity(circle);

    const cmd = new DiameterDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 10, y: 0 }); // on the circle's edge
    cmd.leftClick({ x: 100, y: 0 }); // placement, straight out along +X

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.dimType).toBe("diameter");
    const rp = created[0]!.data.radius_point as { x: number; y: number };
    expect(rp.x).toBeCloseTo(10, 6); // exactly on the boundary toward (100,0)
    expect(rp.y).toBeCloseTo(0, 6);
  });

  it("radius command produces a radius-type dimension from the same pick flow", () => {
    const engine = makeTestEngine();
    const circle = new Circle({ x: 0, y: 0 }, 10);
    engine.document.addEntity(circle);

    const cmd = new RadiusDimensionCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 10, y: 0 });
    cmd.leftClick({ x: 100, y: 0 });

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.dimType).toBe("radius");
  });
});

describe("LeaderCommand", () => {
  it("places a leader after point -> landing -> typed text", () => {
    const engine = makeTestEngine();
    const cmd = new LeaderCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 }); // point being called out
    cmd.leftClick({ x: 20, y: -10 }); // text landing
    cmd.textInput("See note 3");

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.dimType).toBe("leader");
    expect(created[0]!.data.text).toBe("See note 3");
  });

  it("a typed point at the landing step also works, same as a click", () => {
    const engine = makeTestEngine();
    const cmd = new LeaderCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 });
    cmd.textInput("20,10"); // typed Y up -> world (20, -10)
    cmd.textInput("Typed landing works");

    const created = dims(engine);
    expect(created).toHaveLength(1);
    expect(created[0]!.data.text_position).toEqual({ x: 20, y: -10 });
  });

  it("ignores an empty text submission and stays ready for another attempt", () => {
    const engine = makeTestEngine();
    const cmd = new LeaderCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 20, y: -10 });
    cmd.textInput("   ");
    expect(dims(engine)).toHaveLength(0);

    cmd.textInput("Now it works");
    expect(dims(engine)).toHaveLength(1);
  });
});
