import { describe, expect, it } from "vitest";
import { Polyline } from "../entities/polyline";
import { Circle } from "../entities/circle";
import { meshVolume } from "./kernel/extrude";
import { bodyToPolygons, polygonsToBody } from "./kernel/brep";
import type { Body } from "./kernel/types";
import { rebuild } from "./rebuild";
import { blendEdges, edgeRefOf } from "./edgeBlend";
import type { BlendEdge } from "./edgeBlend";
import { emptyPart, parsePart } from "./types";
import type { EdgeFeature, PartData } from "./types";

const vol = (b: Body): number => meshVolume(b.mesh.positions, b.mesh.indices);
/** Corner area outside a quarter circle of radius r. */
const cornerArea = (r: number): number => r * r * (1 - Math.PI / 4);
/** The same with the arc drawn as 5° chords (as the kernel does): a bit more. */
const facetedCornerArea = (r: number): number => cornerArea(r) + ((r * r) / 2) * 18 * ((5 * Math.PI) / 180 - Math.sin((5 * Math.PI) / 180));
/** That area's centroid, from the corner along each leg. */
const cornerCentroid = (r: number): number => (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));

function rect(x0: number, y0: number, x1: number, y1: number): Record<string, unknown> {
  return new Polyline(
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ].map((point) => ({ point, bulge: 0 })),
    true,
  ).serialize();
}

/** 100 x 60 x `h` box on the drawing. */
function box(h = "20"): PartData {
  const part = emptyPart();
  part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: h, direction: "normal", operation: "new" });
  return part;
}

/** The straight edge whose midpoint is nearest `p`. */
function lineEdgeNear(body: Body, p: { x: number; y: number; z: number }): BlendEdge {
  const edges = blendEdges(body).filter((e) => e.kind === "line");
  edges.sort((a, b) => Math.hypot(a.at.x - p.x, a.at.y - p.y, a.at.z - p.z) - Math.hypot(b.at.x - p.x, b.at.y - p.y, b.at.z - p.z));
  return edges[0]!;
}

function withFeature(part: PartData, f: Omit<EdgeFeature, "id">): PartData {
  const p = structuredClone(part);
  p.features.push({ id: "Fillet001", ...f } as EdgeFeature);
  return p;
}

describe("fillet / chamfer on straight edges", () => {
  const drawing = [rect(0, 0, 100, 60)];
  const base = rebuild(box(), drawing).bodies[0]!;
  const boxVol = vol(base);
  // Top edge along X at y = 0 (front), z = 20.
  const front = edgeRefOf(lineEdgeNear(base, { x: 50, y: 0, z: 20 }));

  it("a box has 12 blendable straight edges", () => {
    expect(blendEdges(base).filter((e) => e.kind === "line")).toHaveLength(12);
  });

  it("fillet R5 on an outside edge removes the corner outside a quarter circle, with an exact cylinder face", () => {
    const r = rebuild(withFeature(box(), { type: "fillet", edges: [front], size: "5" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    const b = r.bodies[0]!;
    expect(boxVol - vol(b)).toBeCloseTo(facetedCornerArea(5) * 100, 3);
    const cyl = b.faces.find((f) => f.geom.kind === "cylinder");
    expect(cyl?.geom.kind === "cylinder" && cyl.geom.radius).toBeCloseTo(5);
  });

  it("chamfer 5 (equal) removes a 5 x 5 triangle along the edge", () => {
    const r = rebuild(withFeature(box(), { type: "chamfer", mode: "equal", edges: [front], size: "5" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    expect(boxVol - vol(r.bodies[0]!)).toBeCloseTo(12.5 * 100, 3);
  });

  it("chamfer with two distances, and distance + angle (45° = equal)", () => {
    const two = rebuild(withFeature(box(), { type: "chamfer", mode: "two", edges: [front], size: "4", size2: "6" }), drawing);
    expect(boxVol - vol(two.bodies[0]!)).toBeCloseTo(12 * 100, 3);
    const ang = rebuild(withFeature(box(), { type: "chamfer", mode: "angle", edges: [front], size: "5", angle: "45" }), drawing);
    expect(boxVol - vol(ang.bodies[0]!)).toBeCloseTo(12.5 * 100, 3);
  });

  it("all four top edges filleted: still one watertight-volume solid, corners overlap", () => {
    const top = blendEdges(base).filter((e) => e.kind === "line" && Math.abs(e.at.z - 20) < 1e-9).map(edgeRefOf);
    expect(top).toHaveLength(4);
    const r = rebuild(withFeature(box(), { type: "fillet", edges: top, size: "3" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    expect(r.bodies).toHaveLength(1);
    const removed = boxVol - vol(r.bodies[0]!);
    // 4 edges' worth minus the doubled corner bits.
    expect(removed).toBeLessThan(cornerArea(3) * 320);
    expect(removed).toBeGreaterThan(cornerArea(3) * 300);
  });

  it("the edge is found again after the box is made taller (it follows the model)", () => {
    const r = rebuild(withFeature(box("30"), { type: "fillet", edges: [front], size: "5" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    expect(100 * 60 * 30 - vol(r.bodies[0]!)).toBeCloseTo(facetedCornerArea(5) * 100, 3);
  });

  it("an inside (concave) edge ADDS material: step block on a plate", () => {
    const part = box();
    part.sketches.push({ id: "Sketch001", plane: { base: "face", offset: 0, face: { feature: "Extrude001", role: "end", index: "0" } }, entities: [rect(0, 0, 50, 60)], constraints: [] });
    part.features.push({ id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "20", direction: "normal", operation: "join" });
    const stepped = rebuild(part, drawing).bodies[0]!;
    // The inside edge: along Y at x = 50, z = 20.
    const inner = lineEdgeNear(stepped, { x: 50, y: -30, z: 20 }); // drawing Y is -Y in 3D
    const r = rebuild(withFeature(part, { type: "fillet", edges: [edgeRefOf(inner)], size: "4" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    expect(vol(r.bodies[0]!) - vol(stepped)).toBeCloseTo(facetedCornerArea(4) * 60, 3);
  });

  it("round-trips through the file format", () => {
    const f = withFeature(box(), { type: "chamfer", mode: "angle", edges: [front], size: "5", angle: "30" });
    const back = parsePart(JSON.parse(JSON.stringify(f)))!;
    expect(back.features[1]).toEqual({ ...f.features[1], suppressed: false });
  });
});

describe("fillet / chamfer on circle rims", () => {
  // 60 x 60 x 60 cube with a Ø30 x 20 boss on top.
  const drawing = [rect(0, 0, 60, 60)];
  function cubeBoss(): PartData {
    const part = emptyPart();
    part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "60", direction: "normal", operation: "new" });
    part.sketches.push({ id: "Sketch001", plane: { base: "face", offset: 0, face: { feature: "Extrude001", role: "end", index: "0" } }, entities: [new Circle({ x: 30, y: 30 }, 15).serialize()], constraints: [] });
    part.features.push({ id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "20", direction: "normal", operation: "join" });
    return part;
  }
  const base = rebuild(cubeBoss(), drawing).bodies[0]!;
  const rims = blendEdges(base).filter((e) => e.kind === "circle");
  const topRim = rims.find((e) => Math.abs(e.at.z - 80) < 1e-6)!;
  const baseRim = rims.find((e) => Math.abs(e.at.z - 60) < 1e-6)!;

  it("the boss's top rim and its base rim are blendable circles", () => {
    expect(rims).toHaveLength(2);
    expect(topRim && baseRim).toBeTruthy();
  });

  it("fillet R3 on the top rim cuts a ring (Pappus volume)", () => {
    const r = rebuild(withFeature(cubeBoss(), { type: "fillet", edges: [edgeRefOf(topRim)], size: "3" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    const expected = 2 * Math.PI * (15 - cornerCentroid(3)) * cornerArea(3);
    expect((vol(base) - vol(r.bodies[0]!)) / expected).toBeCloseTo(1, 1);
  });

  it("fillet R3 where the boss meets the cube ADDS a ring", () => {
    const r = rebuild(withFeature(cubeBoss(), { type: "fillet", edges: [edgeRefOf(baseRim)], size: "3" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    const expected = 2 * Math.PI * (15 + cornerCentroid(3)) * cornerArea(3);
    expect((vol(r.bodies[0]!) - vol(base)) / expected).toBeCloseTo(1, 1);
    // The round is ONE torus face. It runs tangentially into the cube top
    // and the boss side, so it makes no edges -- also after the body is
    // processed again (a tangent seam would otherwise break into pieces).
    const b = r.bodies[0]!;
    expect(b.faces.filter((f) => f.geom.kind === "torus")).toHaveLength(1);
    const ringEdges = (body: Body): unknown[] =>
      body.edges.filter((e) => e.geom.kind === "arc" && e.geom.center.z > 59.9 && e.geom.center.z < 63.1);
    expect(ringEdges(b)).toHaveLength(0);
    const again = polygonsToBody(b.id, b.feature, bodyToPolygons(b, 0), b.faces);
    expect(ringEdges(again)).toHaveLength(0);
    expect(again.edges.filter((e) => e.geom.kind !== "arc" && e.geom.kind !== "line")).toHaveLength(0);
  });

  it("chamfer 2 on the top rim", () => {
    const r = rebuild(withFeature(cubeBoss(), { type: "chamfer", mode: "equal", edges: [edgeRefOf(topRim)], size: "2" }), drawing);
    expect(r.status.get("Fillet001")).toEqual({ ok: true });
    const expected = 2 * Math.PI * (15 - 2 / 3) * 2; // triangle area 2, centroid 2/3 in
    expect((vol(base) - vol(r.bodies[0]!)) / expected).toBeCloseTo(1, 1);
  });
});
