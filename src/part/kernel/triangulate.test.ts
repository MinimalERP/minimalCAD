import { describe, expect, it } from "vitest";
import { triangulate } from "./triangulate";

function triArea(flat: number[], tris: number[]): number {
  let a = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [i, j, k] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    a += Math.abs(
      (flat[j * 2]! - flat[i * 2]!) * (flat[k * 2 + 1]! - flat[i * 2 + 1]!) -
        (flat[j * 2 + 1]! - flat[i * 2 + 1]!) * (flat[k * 2]! - flat[i * 2]!),
    ) / 2;
  }
  return a;
}

function circle(cx: number, cy: number, r: number, n: number, cw = false): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((cw ? -1 : 1) * 2 * Math.PI * i) / n;
    out.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return out;
}

describe("triangulate", () => {
  it("square", () => {
    const flat = [0, 0, 10, 0, 10, 10, 0, 10];
    const tris = triangulate(flat);
    expect(tris).toHaveLength(6);
    expect(triArea(flat, tris)).toBeCloseTo(100);
  });

  it("concave L-shape (either winding)", () => {
    const flat = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
    expect(triArea(flat, triangulate(flat))).toBeCloseTo(300);
    const rev: number[] = [];
    for (let i = flat.length / 2 - 1; i >= 0; i--) rev.push(flat[i * 2]!, flat[i * 2 + 1]!);
    expect(triArea(rev, triangulate(rev))).toBeCloseTo(300);
  });

  it("rectangle with two circular holes: area = outer - holes, no overlap", () => {
    const outer = [0, 0, 100, 0, 100, 60, 0, 60];
    const h1 = circle(30, 30, 10, 72, true);
    const h2 = circle(70, 30, 15, 72);
    const flat = [...outer, ...h1, ...h2];
    const tris = triangulate(flat, [4, 4 + 72]);
    const holeArea = (r: number) => 0.5 * 72 * r * r * Math.sin((2 * Math.PI) / 72);
    expect(triArea(flat, tris)).toBeCloseTo(6000 - holeArea(10) - holeArea(15), 6);
  });

  it("is fast on a large profile", () => {
    const flat = circle(0, 0, 100, 2000);
    const t0 = performance.now();
    const tris = triangulate(flat);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(tris).toHaveLength((2000 - 2) * 3);
  });
});
