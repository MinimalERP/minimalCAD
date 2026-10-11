import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { OffsetCommand } from "./offset";
import { RectangleCommand } from "./rectangle";
import { FilletCommand } from "./fillet";
import { Polyline } from "../entities/polyline";

function rectangle() {
  const engine = makeTestEngine();
  const rc = new RectangleCommand(engine);
  rc.start();
  rc.leftClick({ x: 0, y: 0 });
  rc.leftClick({ x: 100, y: 50 });
  rc.cancel();
  return engine;
}
const outlines = (engine: ReturnType<typeof makeTestEngine>) => engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);
const spanOf = (pl: Polyline) => {
  const xs = pl.vertices.map((v) => v.point.x);
  const ys = pl.vertices.map((v) => v.point.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => Math.round(n * 1e6) / 1e6);
};

describe("OffsetCommand on a rectangle", () => {
  it("offsets the whole outline: outside it grows, inside it shrinks, and each is one closed outline", () => {
    const engine = rectangle();
    const cmd = new OffsetCommand(engine);
    cmd.start();
    cmd.textInput("5");
    cmd.leftClick({ x: 50, y: 0 }); // pick the rectangle by its bottom side
    cmd.leftClick({ x: 50, y: -20 }); // outside
    cmd.leftClick({ x: 0, y: 25 }); // the command is still running: pick it again
    cmd.leftClick({ x: 50, y: 25 }); // inside

    const all = outlines(engine);
    expect(all).toHaveLength(3);
    expect(all.every((p) => p.closed && p.vertices.length === 4)).toBe(true);
    expect(all.map(spanOf)).toEqual([[0, 0, 100, 50], [-5, -5, 105, 55], [5, 5, 95, 45]]);
  });

  it("a rounded corner keeps its centre: its radius grows outside", () => {
    const engine = rectangle();
    const f = new FilletCommand(engine);
    f.start();
    f.textInput("10");
    f.leftClick({ x: 50, y: 0 });
    f.leftClick({ x: 0, y: 25 });
    f.cancel();

    const cmd = new OffsetCommand(engine);
    cmd.start();
    cmd.textInput("5");
    cmd.leftClick({ x: 50, y: 50 });
    cmd.leftClick({ x: 50, y: 80 }); // outside
    const all = outlines(engine);
    expect(all).toHaveLength(2);
    expect(all[1]!.closed).toBe(true);
    expect(all[1]!.vertices.filter((v) => v.bulge !== 0)).toHaveLength(1);
    expect(spanOf(all[1]!)).toEqual([-5, -5, 105, 55]);
  });

  it("refuses a distance the outline has no room for", () => {
    const engine = rectangle();
    const cmd = new OffsetCommand(engine);
    cmd.start();
    cmd.textInput("30"); // the rectangle is only 50 high
    cmd.leftClick({ x: 50, y: 0 });
    cmd.leftClick({ x: 50, y: 25 });
    expect(outlines(engine)).toHaveLength(1);
  });
});
