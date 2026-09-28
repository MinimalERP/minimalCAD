import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../../testUtils/fakeEngine";
import { DimensionGripCommand } from "./dimensionGrip";
import { Dimension } from "../../entities/dimension";
import { gripAt } from "../../engine/picking";
import { Selection } from "../../core/selection";

describe("gripAt + DimensionGripCommand", () => {
  it("gripAt finds a Dimension's grip point when it's the sole selection", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    const selection = new Selection();
    selection.select(dim);

    const hit = gripAt(selection, { x: 0, y: 0 }, 1);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("dimension_grip");
    expect(hit!.extra).toBe("p1");
  });

  it("dragging text_position freely repositions it without touching the measurement", () => {
    const engine = makeTestEngine();
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    engine.document.addEntity(dim);

    const cmd = new DimensionGripCommand(engine);
    cmd.start();
    cmd.begin(dim, "text_position");
    cmd.leftClick({ x: 25, y: 99 });

    expect(dim.data.text_position).toEqual({ x: 25, y: 99 });
    expect(dim.data.p1).toEqual({ x: 0, y: 0 });
    expect(dim.data.p2).toEqual({ x: 50, y: 0 });
  });

  it("dragging linear's p1 is constrained to the perpendicular axis (measured value never changes)", () => {
    const engine = makeTestEngine();
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 }, // horizontal dimension (text dropped mostly vertically)
    });
    engine.document.addEntity(dim);

    const cmd = new DimensionGripCommand(engine);
    cmd.start();
    cmd.begin(dim, "p1");
    cmd.leftClick({ x: 999, y: 7 }); // wildly off-axis x -- should be ignored

    expect(dim.data.p1).toEqual({ x: 0, y: 7 }); // x pinned to original, only y moved
  });

  it("textInput accepts a typed point the same way a click does", () => {
    const engine = makeTestEngine();
    const dim = new Dimension("leader", {
      point: { x: 0, y: 0 },
      text_position: { x: 20, y: -10 },
      text: "note",
    });
    engine.document.addEntity(dim);

    const cmd = new DimensionGripCommand(engine);
    cmd.start();
    cmd.begin(dim, "point");
    cmd.textInput("5,-5"); // typed Y up: -5 typed is +5 in the Y-down world

    expect(dim.data.point).toEqual({ x: 5, y: 5 });
  });
});
