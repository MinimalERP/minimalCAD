import { describe, expect, it } from "vitest";
import { Circle } from "../../entities/circle";
import { Polyline } from "../../entities/polyline";
import type { Entity } from "../../entities/entity";
import { findProfiles } from "../profile";
import { planeFrame } from "../plane";
import type { Frame } from "../plane";
import { extrudeRegions, meshVolume } from "./extrude";
import { applyOperation } from "../rebuild";
import type { Body } from "./types";

const rect = (x: number, y: number, w: number, h: number): Polyline =>
  new Polyline(
    [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ].map((point) => ({ point, bulge: 0 })),
    true,
  );

const XY = planeFrame({ base: "XY", offset: 0 });

function solid(id: string, entities: Entity[], frame: Frame, h0: number, h1: number): Body {
  return extrudeRegions(id, findProfiles(entities).regions, frame, h0, h1);
}

const volume = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);

/** Watertight: every undirected edge (welded by position) used by exactly
 *  two triangles, once in each direction. */
function isWatertight(body: Body): boolean {
  const { positions, indices } = body.mesh;
  const key = (i: number): string => [0, 1, 2].map((k) => Math.round(positions[i * 3 + k]! * 1e4)).join(",");
  const directed = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(indices[t + e]!);
      const b = key(indices[t + ((e + 1) % 3)]!);
      if (a === b) continue;
      directed.set(`${a}|${b}`, (directed.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const [k, n] of directed) {
    const [a, b] = k.split("|");
    if (n !== directed.get(`${b}|${a}`)) return false;
  }
  return true;
}

describe("own boolean engine (csg + brep)", () => {
  it("box minus through-cylinder: exact-ish volume, watertight, exact rim arcs", () => {
    const bodies = [solid("E1", [rect(0, 0, 100, 60)], XY, 0, 20)];
    const tool = solid("E2", [new Circle({ x: 50, y: 30 }, 10)], XY, -5, 25);
    expect(applyOperation(bodies, tool, "cut")).toEqual({ ok: true });
    const b = bodies[0]!;
    // 72-gon hole area.
    const hole = 0.5 * 72 * 100 * Math.sin((2 * Math.PI) / 72);
    expect(volume(b)).toBeCloseTo((6000 - hole) * 20, 3);
    expect(isWatertight(b)).toBe(true);
    const arcs = b.edges.filter((e) => e.geom.kind === "arc");
    expect(arcs).toHaveLength(2);
    for (const e of arcs) {
      if (e.geom.kind !== "arc") continue;
      expect(e.geom.radius).toBe(10);
      expect(Math.abs(e.geom.sweep)).toBeCloseTo(2 * Math.PI);
    }
    // 12 box edges + 2 rims; no stray triangulation edges.
    expect(b.edges.filter((e) => e.geom.kind === "line")).toHaveLength(12);
  });

  it("join of overlapping boxes = inclusion-exclusion volume, one body", () => {
    const bodies = [solid("E1", [rect(0, 0, 10, 10)], XY, 0, 10)];
    expect(applyOperation(bodies, solid("E2", [rect(5, 5, 10, 10)], XY, 5, 15), "join")).toEqual({ ok: true });
    expect(bodies).toHaveLength(1);
    expect(volume(bodies[0]!)).toBeCloseTo(1000 + 1000 - 125, 6);
    expect(isWatertight(bodies[0]!)).toBe(true);
  });

  it("boss joined onto a plate: volumes add, no seam edge where they meet", () => {
    const bodies = [solid("E1", [rect(0, 0, 100, 60)], XY, 0, 20)];
    const boss = solid("E2", [rect(20, 20, 20, 20)], planeFrame({ base: "XY", offset: 20 }), 0, 15);
    applyOperation(bodies, boss, "join");
    expect(bodies).toHaveLength(1);
    const b = bodies[0]!;
    expect(volume(b)).toBeCloseTo(100 * 60 * 20 + 20 * 20 * 15, 6);
    expect(isWatertight(b)).toBe(true);
    // Plate: 12 edges. Boss: 4 vertical + 4 top + 4 where it meets the plate top = 12.
    expect(b.edges).toHaveLength(24);
  });

  it("two blocks side by side joined: shared top face shows no seam", () => {
    const bodies = [solid("E1", [rect(0, 0, 10, 10)], XY, 0, 10)];
    applyOperation(bodies, solid("E2", [rect(10, 0, 10, 10)], XY, 0, 10), "join");
    const b = bodies[0]!;
    expect(volume(b)).toBeCloseTo(2000, 6);
    // A plain 20 x 10 x 10 box: 12 edges, 6 faces.
    expect(b.faces).toHaveLength(6);
    expect(b.edges).toHaveLength(12);
  });

  it("cut from the side (cross-direction slot)", () => {
    const bodies = [solid("E1", [rect(0, 0, 100, 60)], XY, 0, 20)];
    // A 10 x 10 square on the XZ plane at x 45..55, z 5..15, through Y.
    const xz = planeFrame({ base: "XZ", offset: 0 });
    const slot = solid("E2", [rect(45, -15, 10, 10)], xz, -100, 100);
    expect(applyOperation(bodies, slot, "cut")).toEqual({ ok: true });
    expect(volume(bodies[0]!)).toBeCloseTo(120000 - 10 * 10 * 60, 6);
    expect(isWatertight(bodies[0]!)).toBe(true);
  });

  it("a cut that misses reports it and leaves the body alone", () => {
    const bodies = [solid("E1", [rect(0, 0, 10, 10)], XY, 0, 10)];
    const before = volume(bodies[0]!);
    const status = applyOperation(bodies, solid("E2", [rect(50, 50, 5, 5)], XY, 0, 10), "cut");
    expect(status.ok).toBe(false);
    expect(volume(bodies[0]!)).toBeCloseTo(before);
  });

  it("join with nothing to touch becomes its own body", () => {
    const bodies = [solid("E1", [rect(0, 0, 10, 10)], XY, 0, 10)];
    applyOperation(bodies, solid("E2", [rect(50, 50, 5, 5)], XY, 0, 10), "join");
    expect(bodies).toHaveLength(2);
  });
});
