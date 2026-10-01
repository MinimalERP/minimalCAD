import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { Dimension } from "../entities/dimension";
import { meshVolume } from "../part/kernel/extrude";
import { rebuild } from "../part/rebuild";
import { emptyPart } from "../part/types";
import type { PartData } from "../part/types";
import { ORIENTATIONS, ViewCache, axesOf, newSheet, sheetGraphics } from "./sheet";
import type { SheetView } from "./sheet";
import { carryAnnotations, nextSectionName, sectionBodies, sectionHatch } from "./section";

const rect = (x0: number, y0: number, x1: number, y1: number): Entity[] => [
  new Line({ x: x0, y: y0 }, { x: x1, y: y0 }),
  new Line({ x: x1, y: y0 }, { x: x1, y: y1 }),
  new Line({ x: x1, y: y1 }, { x: x0, y: y1 }),
  new Line({ x: x0, y: y1 }, { x: x0, y: y0 }),
];
/** A 60 x 40 x 20 block with a Ø20 hole right through its middle (along Z). */
function block() {
  const part: PartData = { ...emptyPart(), features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "20", direction: "normal", operation: "new" }] };
  return rebuild(part, [...rect(0, 0, 60, -40), new Circle({ x: 30, y: -20 }, 10)].map((e) => e.serialize())).bodies;
}

describe("section view", () => {
  const bodies = block();
  // Looking from the front (viewer at -Y), cut through the hole's centre: y = 20.
  const front = axesOf(ORIENTATIONS.front);
  const at = { x: 0, y: 20, z: 0 };

  it("cuts away everything nearer the viewer than the plane", () => {
    const cut = sectionBodies(bodies, at, front);
    expect(cut).toHaveLength(1);
    const full = meshVolume(bodies[0]!.mesh.positions, bodies[0]!.mesh.indices);
    expect(meshVolume(cut[0]!.mesh.positions, cut[0]!.mesh.indices)).toBeCloseTo(full / 2, 3);
    const p = cut[0]!.mesh.positions;
    for (let i = 1; i < p.length; i += 3) expect(p[i]!).toBeGreaterThan(20 - 1e-9); // only the far half is left
  });

  it("hatches the cut faces only: the solid either side of the hole, not the hole", () => {
    const cut = sectionBodies(bodies, at, front);
    const hatch = sectionHatch(cut, front, 2);
    expect(hatch.length).toBeGreaterThan(20);
    for (const [a, b] of hatch) {
      for (const q of [a, b]) {
        // In the front view x is the model's X, y its Z: inside the block's outline...
        expect(q.x).toBeGreaterThan(-1e-6);
        expect(q.x).toBeLessThan(60 + 1e-6);
        expect(q.y).toBeGreaterThan(-1e-6);
        expect(q.y).toBeLessThan(20 + 1e-6);
      }
      // ...and never across the bore (x 20..40).
      const mid = (a.x + b.x) / 2;
      expect(mid < 20 + 1e-6 || mid > 40 - 1e-6).toBe(true);
    }
    // Total hatch length ~ cut area / spacing: 2 x (20 x 20) / 2.
    const total = hatch.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0);
    expect(total).toBeGreaterThan(400 * 0.9);
    expect(total).toBeLessThan(400 * 1.1);
    // The uncut part has no cut faces: nothing to hatch.
    expect(sectionHatch(bodies, front, 2)).toEqual([]);
  });

  it("draws on a sheet: the section's hatch, and the cutting line with its letter on the parent", () => {
    const sheet = newSheet();
    const top: SheetView = { id: "View1", ...ORIENTATIONS.top, scale: 1, x: 100, y: 150, hiddenLines: true, label: "FRONT VIEW" };
    const section: SheetView = { id: "View2", dir: ORIENTATIONS.front.dir, up: ORIENTATIONS.front.up, scale: 1, x: 100, y: 80, parent: "View1", hiddenLines: false, label: "SECTION A-A", section: { at, name: "A" } };
    const plain = sheetGraphics({ ...sheet, views: [top, { ...section, section: undefined }] }, bodies, new ViewCache());
    const withCut = sheetGraphics({ ...sheet, views: [top, section] }, bodies, new ViewCache());
    const thin = (g: typeof plain): number => g.prims.filter((p) => p.kind === "line" && p.pen === "thin").length;
    expect(thin(withCut)).toBeGreaterThan(thin(plain) + 15); // the hatch
    expect(withCut.prims.filter((p) => p.kind === "text" && p.text === "A")).toHaveLength(2); // a letter at each end of the cutting line
    expect(withCut.prims.some((p) => p.kind === "text" && p.text === "SECTION A-A")).toBe(true);
    // The cutting line runs across the top view at the hole's centre (paper y = 150 -> world -150 - (20 - 20)).
    const chain = withCut.prims.filter((p) => p.kind === "line" && p.pen === "center" && Math.abs(p.a.y - p.b.y) < 1e-9 && Math.abs(p.b.x - p.a.x) > 60);
    expect(chain.length).toBeGreaterThan(0);
    expect(nextSectionName([])).toBe("A");
    expect(nextSectionName(["A", "B"])).toBe("C");
  });
});

describe("annotations follow their view", () => {
  const dim = (x: number): Dimension => new Dimension("linear", { p1: { x, y: -100 }, p2: { x: x + 20, y: -100 }, text_position: { x: x + 10, y: -120 }, measure_scale: 1 });
  const boxes = [{ id: "View1", box: [80, -120, 140, -80] as const }];
  const before = [{ id: "View1", x: 110, y: 100, scale: 1 }];

  it("moves with a moved view", () => {
    const d = dim(90);
    const note = new Line({ x: 95, y: -95 }, { x: 105, y: -95 });
    const kept = carryAnnotations([d, note], boxes, before, [{ id: "View1", x: 160, y: 130, scale: 1 }]);
    expect(kept).toHaveLength(2);
    expect(d.data.p1).toEqual({ x: 140, y: -130 });
    expect(d.data.text_position).toEqual({ x: 150, y: -150 });
    expect(note.startPoint).toEqual({ x: 145, y: -125 });
  });

  it("scales about the view's centre when the view is rescaled, and keeps measuring the part", () => {
    const d = dim(100); // 20 on paper at 1:1 = 20 on the part
    carryAnnotations([d], boxes, before, [{ id: "View1", x: 110, y: 100, scale: 0.5 }]);
    expect(d.data.p1).toEqual({ x: 105, y: -100 });
    expect(d.data.p2).toEqual({ x: 115, y: -100 }); // 10 on paper at 1:2...
    expect(d.data.measure_scale).toBe(2); // ...is still 20 on the part
  });

  it("a deleted view takes its dimensions; things on no view are left alone", () => {
    const onView = dim(100);
    const elsewhere = dim(300);
    const kept = carryAnnotations([onView, elsewhere], boxes, before, []);
    expect(kept).toEqual([elsewhere]);
    expect(elsewhere.data.p1).toEqual({ x: 300, y: -100 });
  });
});
