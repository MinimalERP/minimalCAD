import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { CopyCommand } from "./copy";
import { Line } from "../entities/line";

describe("CopyCommand", () => {
  it("keeps placing copies of the selected object, one per click, until it is cancelled", () => {
    const engine = makeTestEngine();
    const line = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    engine.document.addEntity(line);
    engine.selection.select(line);

    const cmd = new CopyCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 }); // reference point
    cmd.leftClick({ x: 0, y: 20 });
    cmd.leftClick({ x: 0, y: 40 });
    cmd.leftClick({ x: 30, y: 0 });

    const ys = engine.document.entities.map((e) => [(e as Line).startPoint.x, (e as Line).startPoint.y]);
    expect(ys).toEqual([[0, 0], [0, 20], [0, 40], [30, 0]]); // each from the same reference point
    expect(engine.selection.getEntities()).toEqual([line]); // still selected

    cmd.cancel();
    expect(engine.document.entities).toHaveLength(4);
    expect(engine.selection.getEntities()).toEqual([line]);

    // each placement is its own undo step
    engine.document.restoreFromDict(engine.undo.undo(engine.document.toDict())!);
    expect(engine.document.entities).toHaveLength(3);
  });
});
