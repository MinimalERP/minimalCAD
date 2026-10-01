import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { Arc } from "../entities/arc";
import { Polyline } from "../entities/polyline";
import { applySize, formatSize, rectangleCorners, sizeLabelsOf } from "./sizeLabels";
import { Document } from "./document";
import { constraintValue, referenceGeometry, setConstraintDistance } from "./constraints";
import type { Constraint } from "./constraints";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { ConstrainDistanceCommand } from "../commands/constrainDistance";

const rect = (x: number, y: number, w: number, h: number): Polyline =>
  new Polyline(
    [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y - h },
      { x, y: y - h },
    ].map((point) => ({ point, bulge: 0 })),
    true,
  );

describe("an entity's own sizes", () => {
  it("a line shows its length, a circle its diameter, a rectangle its width and height", () => {
    expect(sizeLabelsOf(new Line({ x: 0, y: 0 }, { x: 30, y: 40 })).map((l) => [l.key, l.value])).toEqual([["length", 50]]);
    const dia = sizeLabelsOf(new Circle({ x: 5, y: 5 }, 12.5))[0]!;
    expect([dia.key, dia.value, dia.prefix]).toEqual(["diameter", 25, "Ø"]);
    const sizes = Object.fromEntries(sizeLabelsOf(rect(10, 10, 40, 25)).map((l) => [l.key, l.value]));
    expect(sizes).toEqual({ width: 40, height: 25 });
    // Labels sit outside the rectangle: pushed away from its centre.
    for (const l of sizeLabelsOf(rect(10, 10, 40, 25))) {
      const out = { x: l.anchor.x - 30, y: l.anchor.y - -2.5 };
      expect(out.x * l.away.x + out.y * l.away.y).toBeGreaterThan(0);
    }
  });

  it("only real rectangles count; other shapes show nothing", () => {
    expect(rectangleCorners(rect(0, 0, 10, 5))).not.toBeNull();
    const skew = rect(0, 0, 10, 5);
    skew.vertices[2]!.point = { x: 14, y: -5 };
    expect(sizeLabelsOf(skew)).toEqual([]);
    const open = rect(0, 0, 10, 5);
    open.closed = false;
    expect(sizeLabelsOf(open)).toEqual([]);
    expect(sizeLabelsOf(new Arc({ x: 0, y: 0 }, 5, 0, 1))).toEqual([]);
    expect(sizeLabelsOf(new Line({ x: 1, y: 1 }, { x: 1, y: 1 }))).toEqual([]);
  });

  it("a rotated rectangle still has a width (its more horizontal side) and a height", () => {
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const r = new Polyline(
      [
        { x: 0, y: 0 },
        { x: 40 * c, y: -40 * s },
        { x: 40 * c - 25 * s, y: -40 * s - 25 * c },
        { x: -25 * s, y: -25 * c },
      ].map((point) => ({ point, bulge: 0 })),
      true,
    );
    const sizes = Object.fromEntries(sizeLabelsOf(r).map((l) => [l.key, +l.value.toFixed(6)]));
    expect(sizes).toEqual({ width: 40, height: 25 });
  });

  it("editing a size: line about its middle, circle about its centre, rectangle from its first corner", () => {
    const line = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(applySize(line, "length", 30)).toBe(true);
    expect(line.startPoint).toEqual({ x: -10, y: 0 });
    expect(line.endPoint).toEqual({ x: 20, y: 0 });

    const circle = new Circle({ x: 3, y: 4 }, 5);
    expect(applySize(circle, "diameter", 30)).toBe(true);
    expect(circle.radius).toBe(15);
    expect(circle.center).toEqual({ x: 3, y: 4 });

    const r = rect(10, 10, 40, 25);
    expect(applySize(r, "width", 60)).toBe(true);
    expect(applySize(r, "height", 10)).toBe(true);
    expect(r.vertices.map((v) => v.point)).toEqual([
      { x: 10, y: 10 },
      { x: 70, y: 10 },
      { x: 70, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(applySize(r, "diameter", 5)).toBe(false);
    expect(applySize(circle, "diameter", 0)).toBe(false);
  });

  it("formats without trailing zeros", () => {
    expect([25, 12.5, 7.256, 0.1 + 0.2].map(formatSize)).toEqual(["25", "12.5", "7.26", "0.3"]);
  });
});

describe("constraint values", () => {
  it("shows the real distance and, when edited, moves the entity keeping its other constraint", () => {
    const doc = new Document();
    const wallX = new Line({ x: 0, y: 0 }, { x: 0, y: -100 });
    const wallY = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const hole = new Circle({ x: 30, y: -20 }, 5);
    for (const e of [wallX, wallY, hole]) doc.addEntity(e);
    const c1: Constraint = { id: "c1", driven_entity_id: hole.id!, driven_feature: "center", ref_entity_id: wallX.id!, ref_feature: "edge", target: 30 };
    const c2: Constraint = { id: "c2", driven_entity_id: hole.id!, driven_feature: "center", ref_entity_id: wallY.id!, ref_feature: "edge", target: -20 };
    doc.constraints = [c1, c2];
    expect(constraintValue(doc, c1)).toBeCloseTo(30);
    expect(setConstraintDistance(doc, "c1", 45)).toBeNull();
    expect(hole.center.x).toBeCloseTo(45);
    expect(hole.center.y).toBeCloseTo(-20); // the other distance still holds
    expect(constraintValue(doc, c1)).toBeCloseTo(45);
    expect(setConstraintDistance(doc, "nope", 5)).toMatch(/gone/);
  });

  it("a constraint can measure from reference geometry behind a sketch (a projected model edge)", () => {
    const engine = makeTestEngine();
    const hole = new Circle({ x: 30, y: -20 }, 5);
    engine.document.addEntity(hole);
    const edge = new Line({ x: 0, y: 50 }, { x: 0, y: -50 }); // not in the document
    engine.underlay = [edge];
    const cmd = new ConstrainDistanceCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 35, y: -20 }); // the circle
    cmd.leftClick({ x: 0, y: -10 }); // the model edge
    cmd.textInput("50");
    const [c] = engine.document.constraints as Constraint[];
    expect(c).toMatchObject({ ref_entity_id: "", ref_geom: referenceGeometry(edge) });
    expect(hole.center.x).toBeCloseTo(50);
    expect(constraintValue(engine.document, c!)).toBeCloseTo(50);
    // Survives save / load: the reference travels with the constraint.
    const back = new Document();
    back.restoreFromDict(JSON.parse(JSON.stringify(engine.document.toDict())));
    expect(constraintValue(back, (back.constraints as Constraint[])[0]!)).toBeCloseTo(50);
    expect(setConstraintDistance(back, c!.id, 12)).toBeNull();
    expect((back.getEntities()[0] as Circle).center.x).toBeCloseTo(12);
  });
});
