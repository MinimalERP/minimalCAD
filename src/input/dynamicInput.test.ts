import { describe, expect, it } from "vitest";
import { evalNumber, parseCircleRadius, parsePoint, parsePositiveFloat, parseTwoPositiveFloats } from "./dynamicInput";

describe("evalNumber", () => {
  it("parses plain numbers", () => {
    expect(evalNumber("5")).toBe(5);
    expect(evalNumber("3.14")).toBeCloseTo(3.14);
    expect(evalNumber("  7  ")).toBe(7);
  });

  it("evaluates arithmetic with correct precedence", () => {
    expect(evalNumber("90/2")).toBe(45);
    expect(evalNumber("10+2.5*3")).toBe(17.5);
    expect(evalNumber("(5+3)/2")).toBe(4);
    expect(evalNumber("2*(3+4)")).toBe(14);
    expect(evalNumber("-5")).toBe(-5);
    expect(evalNumber("-(5+3)")).toBe(-8);
    expect(evalNumber("--5")).toBe(5);
    expect(evalNumber("+5")).toBe(5);
  });

  it("never throws, returns null for malformed input", () => {
    expect(evalNumber("")).toBeNull();
    expect(evalNumber(null)).toBeNull();
    expect(evalNumber(undefined)).toBeNull();
    expect(evalNumber("abc")).toBeNull();
    expect(evalNumber("5 +")).toBeNull();
    expect(evalNumber("(5")).toBeNull();
    expect(evalNumber("5)")).toBeNull();
    expect(evalNumber("5 5")).toBeNull();
    expect(evalNumber("..5")).toBeNull();
    expect(evalNumber("5..5")).toBeNull();
    expect(evalNumber("*5")).toBeNull();
    expect(evalNumber("5**5")).toBeNull();
  });

  it("returns null for division by zero instead of Infinity/NaN", () => {
    expect(evalNumber("5/0")).toBeNull();
    expect(evalNumber("0/0")).toBeNull();
  });

  it("rejects disallowed syntax (no functions, variables, exponents)", () => {
    expect(evalNumber("sqrt(4)")).toBeNull();
    expect(evalNumber("x+1")).toBeNull();
    expect(evalNumber("1e5")).toBeNull();
  });
});

describe("parsePoint", () => {
  const origin = { x: 10, y: 20 };

  // Typed values are AutoCAD-style (Y up, CCW angles); the world is Y-down,
  // so typed +Y comes out as a smaller world y.
  it("parses a relative x,y offset from origin (typed +Y is up)", () => {
    expect(parsePoint("12,7", origin)).toEqual({ x: 22, y: 13 });
  });

  it("'@' prefix is a no-op alias", () => {
    expect(parsePoint("@12,7", origin)).toEqual({ x: 22, y: 13 });
  });

  it("with no origin, x,y is absolute", () => {
    expect(parsePoint("12,7", null)).toEqual({ x: 12, y: -7 });
  });

  it("distance<angle in degrees, counter-clockwise like AutoCAD", () => {
    const p = parsePoint("10<90", origin)!;
    expect(p.x).toBeCloseTo(10, 9); // straight up on screen...
    expect(p.y).toBeCloseTo(10, 9); // ...= world y decreasing (Y-down world)
  });

  it("'/' is accepted identically to '<'", () => {
    const withSlash = parsePoint("10/90", origin);
    const withBracket = parsePoint("10<90", origin);
    expect(withSlash).toEqual(withBracket);
  });

  it("bare distance rides along currentAngle", () => {
    const p = parsePoint("5", origin, Math.PI)!; // 180deg -> (-1, 0) direction
    expect(p.x).toBeCloseTo(5, 9);
    expect(p.y).toBeCloseTo(20, 9);
  });

  it("returns null for garbage or empty input", () => {
    expect(parsePoint("", origin)).toBeNull();
    expect(parsePoint("abc", origin)).toBeNull();
    expect(parsePoint("12,", origin)).toBeNull();
  });
});

describe("parsePositiveFloat", () => {
  it("accepts positive numbers/expressions", () => {
    expect(parsePositiveFloat("5")).toBe(5);
    expect(parsePositiveFloat("2*3")).toBe(6);
  });

  it("rejects zero, negative, and invalid input", () => {
    expect(parsePositiveFloat("0")).toBeNull();
    expect(parsePositiveFloat("-5")).toBeNull();
    expect(parsePositiveFloat("abc")).toBeNull();
  });
});

describe("parseTwoPositiveFloats", () => {
  it("parses 'a,b' with both positive", () => {
    expect(parseTwoPositiveFloats("5,10")).toEqual([5, 10]);
  });

  it("rejects if either value is non-positive or missing", () => {
    expect(parseTwoPositiveFloats("5,0")).toBeNull();
    expect(parseTwoPositiveFloats("-5,10")).toBeNull();
    expect(parseTwoPositiveFloats("5")).toBeNull();
  });
});

describe("parseCircleRadius", () => {
  it("r-prefix is radius, case-insensitive", () => {
    expect(parseCircleRadius("r25")).toBe(25);
    expect(parseCircleRadius("R25")).toBe(25);
  });

  it("d-prefix is diameter (halved to radius), case-insensitive", () => {
    expect(parseCircleRadius("d25")).toBe(12.5);
    expect(parseCircleRadius("D25")).toBe(12.5);
  });

  it("a bare number defaults to radius (not diameter)", () => {
    expect(parseCircleRadius("25")).toBe(25);
  });

  it("rejects non-positive or invalid values", () => {
    expect(parseCircleRadius("r0")).toBeNull();
    expect(parseCircleRadius("r-5")).toBeNull();
    expect(parseCircleRadius("rabc")).toBeNull();
    expect(parseCircleRadius("")).toBeNull();
  });
});
