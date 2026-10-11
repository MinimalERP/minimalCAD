import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { ExplodeCommand } from "./explode";
import { Polyline } from "../entities/polyline";
import { Line } from "../entities/line";
import { Arc } from "../entities/arc";
import { Text } from "../entities/text";
import { Dimension } from "../entities/dimension";

describe("ExplodeCommand", () => {
  it("clicking a Polyline breaks it into its Line/Arc segments and removes the Polyline", () => {
    const engine = makeTestEngine();
    const poly = new Polyline(
      [
        { point: { x: 0, y: 0 }, bulge: 1.0 },
        { point: { x: 10, y: 0 }, bulge: 0 },
        { point: { x: 10, y: 10 }, bulge: 0 },
      ],
      false,
    );
    engine.document.addEntity(poly);

    const cmd = new ExplodeCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 10, y: 5 }); // on the straight second segment

    expect(engine.document.entities).not.toContain(poly);
    expect(engine.document.entities.filter((e) => e instanceof Arc)).toHaveLength(1); // the bulged first segment
    expect(engine.document.entities.filter((e) => e instanceof Line)).toHaveLength(1); // the straight second segment
  });

  it("clicking a Dimension breaks it into Line/Text primitives", () => {
    const engine = makeTestEngine();
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    engine.document.addEntity(dim);
    // Dimension only populates its hit-test cache after a draw() -- same
    // prerequisite entities/dimension.test.ts documents.
    dim.draw({ save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, closePath: () => {}, fill: () => {}, arc: () => {}, fillText: () => {}, setLineDash: () => {} } as unknown as CanvasRenderingContext2D, engine.viewport);

    const cmd = new ExplodeCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 20 }); // on an extension line, within the cached geometry

    expect(engine.document.entities).not.toContain(dim);
    expect(engine.document.entities.some((e) => e instanceof Line)).toBe(true);
    expect(engine.document.entities.some((e) => e instanceof Text)).toBe(true);
  });

  it("bulk-explodes every pre-selected explodable entity as a single action", () => {
    const engine = makeTestEngine();
    const poly1 = new Polyline([{ point: { x: 0, y: 0 }, bulge: 0 }, { point: { x: 10, y: 0 }, bulge: 0 }], false);
    const poly2 = new Polyline([{ point: { x: 0, y: 20 }, bulge: 0 }, { point: { x: 10, y: 20 }, bulge: 0 }], false);
    engine.document.addEntity(poly1);
    engine.document.addEntity(poly2);
    engine.selection.select(poly1);
    engine.selection.select(poly2);

    const cmd = new ExplodeCommand(engine);
    cmd.start(); // pre-selected -- explodes immediately, no click needed

    expect(engine.document.entities).not.toContain(poly1);
    expect(engine.document.entities).not.toContain(poly2);
    expect(engine.document.entities.filter((e) => e instanceof Line)).toHaveLength(2);
    expect(engine.selection.getEntities()).toHaveLength(0);
  });

  it("leaves an already-primitive entity (Line) untouched when clicked", () => {
    const engine = makeTestEngine();
    const line = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    engine.document.addEntity(line);

    const cmd = new ExplodeCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 5, y: 0 });

    expect(engine.document.entities).toEqual([line]);
  });

  it("clicking empty space does nothing", () => {
    const engine = makeTestEngine();
    const poly = new Polyline([{ point: { x: 0, y: 0 }, bulge: 0 }, { point: { x: 10, y: 0 }, bulge: 0 }], false);
    engine.document.addEntity(poly);

    const cmd = new ExplodeCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 500, y: 500 });

    expect(engine.document.entities).toEqual([poly]);
  });
});
