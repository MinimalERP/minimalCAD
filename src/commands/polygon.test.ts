import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { Polyline } from "../entities/polyline";
import { Line } from "../entities/line";
import { PolygonCommand } from "./polygon";
import { TrimCommand } from "./trim";
import { OffsetCommand } from "./offset";
import { FilletCommand } from "./fillet";
import { ChamferCommand } from "./chamfer";

function polygon(mode: "i" | "c" = "i", sides = 4, radiusOrApothem = 50) {
  const engine = makeTestEngine();
  const cmd = new PolygonCommand(engine);
  cmd.start();
  cmd.textInput(String(sides));
  cmd.leftClick({ x: 0, y: 0 });
  cmd.textInput(mode);
  cmd.leftClick({ x: radiusOrApothem, y: 0 });
  return engine;
}

const outlines = (engine: ReturnType<typeof makeTestEngine>) =>
  engine.document.entities.filter((entity): entity is Polyline => entity instanceof Polyline);

describe("PolygonCommand", () => {
  it("creates a regular inscribed polygon from center and vertex radius", () => {
    const engine = polygon("i", 6, 20);
    const [shape] = outlines(engine);
    expect(shape?.closed).toBe(true);
    expect(shape?.vertices).toHaveLength(6);
    expect(shape?.vertices.every((v) => Math.abs(Math.hypot(v.point.x, v.point.y) - 20) < 1e-8)).toBe(true);
  });

  it("creates a regular circumscribed polygon with the requested center-to-edge distance", () => {
    const engine = makeTestEngine();
    const cmd = new PolygonCommand(engine);
    cmd.start();
    cmd.textInput("4");
    cmd.leftClick({ x: 0, y: 0 });
    cmd.textInput("c");
    cmd.leftClick({ x: 0, y: 10 });
    const [shape] = outlines(engine);
    expect(shape?.vertices).toHaveLength(4);
    const circumradius = Math.hypot(shape!.vertices[0]!.point.x, shape!.vertices[0]!.point.y);
    expect(circumradius).toBeCloseTo(10 / Math.cos(Math.PI / 4), 8);
    // The cursor pointed up, so the upper edge is centered 10 units from the origin.
    const upperEdgeMidY = (shape!.vertices[0]!.point.y + shape!.vertices[1]!.point.y) / 2;
    expect(upperEdgeMidY).toBeCloseTo(10, 8);
  });

  it("accepts a typed radius using the current cursor direction", () => {
    const engine = makeTestEngine();
    const cmd = new PolygonCommand(engine);
    cmd.start();
    cmd.textInput("5");
    cmd.textInput("10,20");
    cmd.textInput("inscribed");
    cmd.mouseMove({ x: 10, y: 30 });
    cmd.textInput("25");

    const [shape] = outlines(engine);
    expect(shape?.vertices).toHaveLength(5);
    expect(Math.hypot(shape!.vertices[0]!.point.x - 10, shape!.vertices[0]!.point.y + 20)).toBeCloseTo(25, 8);
  });

  it("applies Ortho to the final edge direction for previews and typed distance", () => {
    const engine = makeTestEngine();
    const cmd = new PolygonCommand(engine);
    cmd.start();
    cmd.textInput("4");
    cmd.leftClick({ x: 0, y: 0 });
    cmd.textInput("i");
    engine.toggleOrtho();
    cmd.mouseMove({ x: 10, y: 9 }); // nearer horizontal, so Ortho removes the Y component
    cmd.textInput("20");

    const [shape] = outlines(engine);
    expect(shape?.vertices.some((v) => Math.abs(v.point.x - 20) < 1e-8 && Math.abs(v.point.y) < 1e-8)).toBe(true);
  });

  it("rejects side counts outside AutoCAD's regular-polygon range without drawing", () => {
    const engine = makeTestEngine();
    const cmd = new PolygonCommand(engine);
    cmd.start();
    cmd.textInput("2");
    expect(outlines(engine)).toHaveLength(0);
    cmd.textInput("1025");
    expect(outlines(engine)).toHaveLength(0);
  });

  it("lets Trim open a polygon, remove the clicked piece, then rejoin the remaining outline", () => {
    const engine = polygon("i", 4, 100); // vertices at the four axes
    const cutter = new Line({ x: -200, y: 50 }, { x: 200, y: 50 });
    engine.document.addEntity(cutter);

    const trim = new TrimCommand(engine);
    trim.start();
    trim.leftClick({ x: 25, y: 75 }); // remove the part between the upper vertex and cutter
    trim.cancel(); // closes the temporary outline segments after the trim command ends

    const [remaining] = outlines(engine);
    expect(remaining).toBeDefined();
    expect(remaining!.closed).toBe(false);
    expect(remaining!.hitTest({ x: 25, y: 75 }, 0.1)).toBe(false);
    expect(engine.document.entities).toContain(cutter);
  });

  it("supports existing Offset, Fillet and Chamfer operations on the polygon outline", () => {
    const offsetEngine = polygon("i", 5, 50);
    const offset = new OffsetCommand(offsetEngine);
    offset.start();
    offset.textInput("5");
    offset.leftClick({ x: 32.7, y: 23.8 });
    offset.leftClick({ x: 70, y: 50 });
    expect(outlines(offsetEngine)).toHaveLength(2);
    expect(outlines(offsetEngine).every((shape) => shape.closed)).toBe(true);

    const filletEngine = polygon("i", 4, 50);
    const fillet = new FilletCommand(filletEngine);
    fillet.start();
    fillet.textInput("5");
    fillet.leftClick({ x: 25, y: 25 });
    fillet.leftClick({ x: 25, y: -25 });
    expect(outlines(filletEngine)).toHaveLength(1);
    expect(outlines(filletEngine)[0]!.closed).toBe(true);
    expect(outlines(filletEngine)[0]!.vertices.filter((v) => v.bulge !== 0)).toHaveLength(1);

    const chamferEngine = polygon("i", 4, 50);
    const chamfer = new ChamferCommand(chamferEngine);
    chamfer.start();
    chamfer.textInput("5");
    chamfer.leftClick({ x: 25, y: 25 });
    chamfer.leftClick({ x: 25, y: -25 });
    expect(outlines(chamferEngine)).toHaveLength(1);
    expect(outlines(chamferEngine)[0]!.closed).toBe(true);
    expect(outlines(chamferEngine)[0]!.vertices).toHaveLength(5);
  });
});
