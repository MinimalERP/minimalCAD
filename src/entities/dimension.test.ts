import { describe, expect, it } from "vitest";
import { Dimension } from "./dimension";
import { Viewport } from "../engine/viewport";

/** Minimal no-op Canvas 2D context stub -- Dimension.draw() only calls a
 *  handful of drawing primitives, and hitTest()/getBounds() only need the
 *  world-space geometry draw() *computes* (cached as a side effect), never
 *  anything it actually paints. */
function fakeCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    save: noop,
    restore: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    arc: noop,
    fillText: noop,
    setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
}

/** Identity-transform viewport (zoom=1, panOffset={0,0} by default -- see
 *  engine/viewport.ts's field initializers), so world and screen coordinates
 *  coincide and test expectations can be written directly in world units. */
function identityViewport(): Viewport {
  return new Viewport(
    () => 800,
    () => 600,
  );
}

describe("Dimension: linear", () => {
  it("horizontal placement (text dropped mostly vertically) measures X", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("50.00");
  });

  it("vertical placement (text dropped mostly horizontally) measures Y", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 0, y: 30 },
      text_position: { x: 20, y: 15 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("30.00");
  });

  it("text_override replaces the computed measurement", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
      text_override: "CUSTOM",
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("CUSTOM");
  });

  it("hitTest finds the dimension line after draw() populates the cache, and rejects far misses", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    // Before any draw(), the cache is empty -- matches entities/dimension.py's
    // own documented quirk (see its get_bounds() docstring).
    expect(dim.hitTest({ x: 0, y: 20 })).toBe(false);

    dim.draw(fakeCtx(), identityViewport());
    expect(dim.hitTest({ x: 0, y: 20 }, 1)).toBe(true); // on an extension line
    expect(dim.hitTest({ x: 1000, y: 1000 })).toBe(false);
  });

  it("constrainGrip restricts p1/p2 to the perpendicular axis for a horizontal dimension", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    const constrained = dim.constrainGrip("p1", { x: 999, y: 5 });
    expect(constrained).toEqual({ x: 0, y: 5 }); // x pinned, only y (perpendicular) moves
  });
});

describe("Dimension: aligned", () => {
  it("measures the raw Euclidean distance regardless of placement side", () => {
    const dim = new Dimension("aligned", {
      p1: { x: 0, y: 0 },
      p2: { x: 3, y: 4 },
      text_position: { x: 1.5, y: 10 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("5.00");
  });
});

describe("Dimension: angular", () => {
  it("measures the angle between two lines meeting at a vertex", () => {
    const dim = new Dimension("angular", {
      line1_p1: { x: 0, y: 0 },
      line1_p2: { x: 10, y: 0 },
      line2_p1: { x: 0, y: 0 },
      line2_p2: { x: 0, y: 10 },
      text_position: { x: 5, y: -5 }, // radius = dist(vertex, text_position)
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("90.00°");
  });

  it("uses whichever endpoint is farther from the vertex as the direction reference", () => {
    // line1 stored "backwards" (p2 is the shared vertex, not p1) -- still reads 90deg.
    const dim = new Dimension("angular", {
      line1_p1: { x: 10, y: 0 },
      line1_p2: { x: 0, y: 0 },
      line2_p1: { x: 0, y: 0 },
      line2_p2: { x: 0, y: 10 },
      text_position: { x: 5, y: -5 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("90.00°");
  });

  it("returns no geometry for parallel lines (no intersection)", () => {
    const dim = new Dimension("angular", {
      line1_p1: { x: 0, y: 0 },
      line1_p2: { x: 10, y: 0 },
      line2_p1: { x: 0, y: 5 },
      line2_p2: { x: 10, y: 5 },
      text_position: { x: 5, y: -5 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe(""); // never set -- draw bailed out early
  });
});

describe("Dimension: diameter/radius", () => {
  it("diameter shows the doubled radius with the diameter glyph", () => {
    const dim = new Dimension("diameter", {
      center: { x: 0, y: 0 },
      radius_point: { x: 10, y: 0 },
      text_position: { x: 30, y: 0 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("Ø20.00");
  });

  it("radius shows the plain radius with the R prefix", () => {
    const dim = new Dimension("radius", {
      center: { x: 0, y: 0 },
      radius_point: { x: 10, y: 0 },
      text_position: { x: 30, y: 0 },
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("R10.00");
  });
});

describe("Dimension: leader", () => {
  it("displays its own free-form text, not a computed measurement", () => {
    const dim = new Dimension("leader", {
      point: { x: 0, y: 0 },
      text_position: { x: 20, y: -10 },
      text: "See note 3",
    });
    dim.draw(fakeCtx(), identityViewport());
    expect(dim.getDisplayText()).toBe("See note 3");
  });
});

describe("Dimension: shared interaction behavior", () => {
  it("move() translates every point key for the dim_type, and only those", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    dim.move(5, 3);
    expect(dim.data.p1).toEqual({ x: 5, y: 3 });
    expect(dim.data.p2).toEqual({ x: 55, y: 3 });
    expect(dim.data.text_position).toEqual({ x: 30, y: 23 });
  });

  it("rotate() about a point matches the Y-down clockwise-positive convention", () => {
    const dim = new Dimension("leader", {
      point: { x: 10, y: 0 },
      text_position: { x: 10, y: 0 },
      text: "x",
    });
    dim.rotate(0, 0, Math.PI / 2);
    expect((dim.data.point as { x: number; y: number }).x).toBeCloseTo(0, 9);
    expect((dim.data.point as { x: number; y: number }).y).toBeCloseTo(10, 9);
  });

  it("copy() deep-clones point fields so mutating the copy doesn't affect the original", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
    });
    const copy = dim.copy();
    copy.move(100, 100);
    expect(dim.data.p1).toEqual({ x: 0, y: 0 });
  });

  it("serialize/fromDict round-trips field-for-field, including scalar and text fields", () => {
    const dim = new Dimension("linear", {
      p1: { x: 1.5, y: -2 },
      p2: { x: 50, y: 0 },
      text_position: { x: 25, y: 20 },
      scale: 1.5,
      text_override: "CUSTOM",
    });
    const serialized = dim.serialize();
    expect(serialized.type).toBe("linear");
    const restored = Dimension.fromDict(serialized);
    expect(restored.serialize()).toEqual(serialized);
  });

  it("getBounds reflects grip points even before any draw() call", () => {
    const dim = new Dimension("linear", {
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 10 },
      text_position: { x: 25, y: 30 },
    });
    expect(dim.getBounds()).toEqual([0, 0, 50, 30]);
  });

  it("gripItems exposes exactly the draggable (key, point) pairs for the dim_type", () => {
    const dim = new Dimension("angular", {
      line1_p1: { x: 0, y: 0 },
      line1_p2: { x: 10, y: 0 },
      line2_p1: { x: 0, y: 0 },
      line2_p2: { x: 0, y: 10 },
      text_position: { x: 5, y: -5 },
    });
    const keys = dim.gripItems().map(([k]) => k);
    expect(keys).toEqual(["line1_p2", "line2_p2", "text_position"]);
  });
});

describe("Dimension: decimals, small dimensions, movable text", () => {
  const draw = (dim: Dimension): Dimension => {
    dim.draw(fakeCtx(), identityViewport());
    return dim;
  };
  const linear = (len: number, extra: Record<string, unknown> = {}): Dimension =>
    new Dimension("linear", { p1: { x: 0, y: 0 }, p2: { x: len, y: 0 }, text_position: { x: len / 2, y: 20 }, ...extra } as never);

  it("auto decimals keep real decimals (12.5 is not cut to '12.') and drop zeros", () => {
    expect(draw(linear(12.5, { trim_zeros: 1 })).getDisplayText()).toBe("12.5");
    expect(draw(linear(0.5, { trim_zeros: 1 })).getDisplayText()).toBe("0.5");
    expect(draw(linear(10.25, { trim_zeros: 1 })).getDisplayText()).toBe("10.25");
    expect(draw(linear(80, { trim_zeros: 1 })).getDisplayText()).toBe("80");
    expect(draw(linear(100, { trim_zeros: 1 })).getDisplayText()).toBe("100");
  });

  it("fixed decimals (DIMDEC / sheet setting), after the view's measure scale", () => {
    expect(draw(linear(12.5, { precision: 2 })).getDisplayText()).toBe("12.50");
    expect(draw(linear(12.5, { precision: 0 })).getDisplayText()).toBe("13");
    expect(draw(linear(40, { precision: 1, measure_scale: 2 })).getDisplayText()).toBe("80.0");
  });

  it("a small dimension puts its text outside, past the second extension line", () => {
    const dim = draw(linear(3));
    const [x0] = dim.getBounds();
    const b = dim.getBounds();
    expect(x0).toBeLessThan(0); // arrows outside, pointing in
    expect(b[2]).toBeGreaterThan(3 + 4); // text past p2
    // A roomy one keeps its text centred between the lines.
    const wide = draw(linear(60));
    const grip = wide.gripItems().find(([k]) => k === "text_position")![1];
    expect(grip.x).toBeCloseTo(30, 9);
  });

  it("dragged text stays where it's dropped, and the dimension keeps measuring X", () => {
    const dim = draw(linear(10));
    dim.pinText();
    // Dropped far along the line (and to the side): would read as a
    // vertical dim if the direction weren't pinned.
    dim.data.text_position = { x: 40, y: 22 };
    draw(dim);
    expect(dim.getDisplayText()).toBe("10.00");
    const grip = dim.gripItems().find(([k]) => k === "text_position")![1];
    expect(grip.x).toBeCloseTo(40, 9);
    expect(grip.y).toBeCloseTo(22, 9);
    // The dimension line runs out to the text.
    expect(dim.getBounds()[2]).toBeGreaterThan(40);
  });
});
