import { describe, expect, it } from "vitest";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { RectangleCommand } from "./rectangle";
import { Polyline } from "../entities/polyline";

describe("RectangleCommand", () => {
  it("draws a rectangle from two opposite corners (default mode)", () => {
    const engine = makeTestEngine();
    const cmd = new RectangleCommand(engine);
    cmd.start();
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 100, y: 50 });

    const rects = engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.closed).toBe(true);
    expect(rects[0]!.vertices).toHaveLength(4);
    const xs = rects[0]!.vertices.map((v) => v.point.x);
    const ys = rects[0]!.vertices.map((v) => v.point.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(100);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(50);
  });

  it("typing C switches to center mode: first point becomes the rectangle's center", () => {
    const engine = makeTestEngine();
    const cmd = new RectangleCommand(engine);
    cmd.start();
    cmd.textInput("c");
    cmd.leftClick({ x: 0, y: 0 }); // center
    cmd.leftClick({ x: 20, y: 10 }); // one corner

    const rects = engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.closed).toBe(true);
    expect(rects[0]!.vertices).toHaveLength(4);
    const xs = rects[0]!.vertices.map((v) => v.point.x);
    const ys = rects[0]!.vertices.map((v) => v.point.y);
    expect(Math.min(...xs)).toBe(-20);
    expect(Math.max(...xs)).toBe(20);
    expect(Math.min(...ys)).toBe(-10);
    expect(Math.max(...ys)).toBe(10);
  });

  it("center mode accepts a typed width,height, doubled and centered on the first point", () => {
    const engine = makeTestEngine();
    const cmd = new RectangleCommand(engine);
    cmd.start();
    cmd.textInput("center");
    cmd.leftClick({ x: 5, y: 5 }); // center
    cmd.textInput("10,4"); // width 10, height 4

    const rects = engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.closed).toBe(true);
    expect(rects[0]!.vertices).toHaveLength(4);
    const xs = rects[0]!.vertices.map((v) => v.point.x);
    const ys = rects[0]!.vertices.map((v) => v.point.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(10);
    expect(Math.min(...ys)).toBe(3);
    expect(Math.max(...ys)).toBe(7);
  });

  it("a new command invocation resets back to corner mode", () => {
    const engine = makeTestEngine();
    const cmd = new RectangleCommand(engine);
    cmd.start();
    cmd.textInput("c");
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 10, y: 10 });

    cmd.start(); // second rectangle, no "c" this time
    cmd.leftClick({ x: 0, y: 0 });
    cmd.leftClick({ x: 30, y: 20 });

    const rects = engine.document.entities.filter((e): e is Polyline => e instanceof Polyline);
    expect(rects).toHaveLength(2);
    const xs = rects[1]!.vertices.map((v) => v.point.x);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(30);
  });
});
