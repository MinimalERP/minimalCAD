import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { meshVolume } from "./kernel/extrude";
import { rebuild } from "./rebuild";
import { emptyPart, parsePart } from "./types";
import type { PartData, WorkPlane } from "./types";
import { hingeEdges, hingeRef, hingedFrame, modelPlane } from "./workPlane";
import { cross, dot } from "./vec3";

const rect = (w: number, h: number): Entity[] => [
  new Line({ x: 0, y: 0 }, { x: w, y: 0 }),
  new Line({ x: w, y: 0 }, { x: w, y: -h }),
  new Line({ x: w, y: -h }, { x: 0, y: -h }),
  new Line({ x: 0, y: -h }, { x: 0, y: 0 }),
];
const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
/** A 40 x 30 x 10 block on the ground. */
const block = (height = "10"): PartData => ({
  ...emptyPart(),
  features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: height, direction: "normal", operation: "new" }],
});
const ENTS = drawing(rect(40, 30));

/** The block's top face and its edge along X at y = 0. */
function topFrontHinge(part: PartData = block()) {
  const body = rebuild(part, ENTS).bodies[0]!;
  const top = body.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
  const edges = hingeEdges(body, top);
  const hinge = edges.find((e) => Math.abs(e.a.y) < 1e-9 && Math.abs(e.b.y) < 1e-9)!;
  return { body, top, edges, hinge };
}

describe("work plane hinged on a model edge", () => {
  it("a block's top face offers its four straight edges", () => {
    const { edges, hinge } = topFrontHinge();
    expect(edges).toHaveLength(4);
    expect(hinge.other?.geom.kind).toBe("plane");
  });

  it("0 degrees is the face itself; a positive angle lifts the side over the face", () => {
    const { hinge } = topFrontHinge();
    const flat = hingedFrame(hinge, 0, 0).frame;
    expect(flat.n.z).toBeCloseTo(1);
    expect(Math.abs(flat.u.x)).toBeCloseTo(1); // horizontal along the hinge
    expect(flat.v.y).toBeCloseTo(1); // "up" points into the face (the face lies at y > 0)
    expect(flat.origin).toMatchObject({ x: 0, y: 0, z: 10 }); // world origin dropped onto the hinge line
    const c = cross(flat.u, flat.v);
    expect(dot(c, flat.n)).toBeCloseTo(1); // right-handed

    const up = hingedFrame(hinge, 90, 0).frame;
    expect(up.v.z).toBeCloseTo(1); // stands up from the edge
    expect(Math.abs(up.n.y)).toBeCloseTo(1);
    const tilted = hingedFrame(hinge, 30, 5);
    expect(tilted.frame.v.z).toBeCloseTo(Math.sin(Math.PI / 6));
    expect(tilted.frame.v.y).toBeCloseTo(Math.cos(Math.PI / 6));
    // Offset moves it along its own normal; the display point is the hinge's middle, moved too.
    expect(dot(tilted.frame.origin, tilted.frame.n) - dot(hingedFrame(hinge, 30, 0).frame.origin, tilted.frame.n)).toBeCloseTo(5);
    expect(tilted.hingeAt.x).toBeCloseTo(20);
    // Flipped: the same plane tilted the other way (into the block).
    expect(hingedFrame(hinge, -30, 0).frame.v.z).toBeCloseTo(-Math.sin(Math.PI / 6));
  });

  it("rebuilds with the model: the plane follows the block's height, and a sketch on it extrudes square to it", () => {
    const { top, hinge } = topFrontHinge();
    const wp: WorkPlane = { id: "WorkPlane001", base: "XY", axis: "u", offset: "0", angle: "90", on: { face: top.ref, hinge: hingeRef(hinge) } };
    const part = (height: string): PartData => ({
      ...block(height),
      planes: [wp],
      sketches: [{ id: "Sketch001", plane: { base: "WorkPlane001", offset: 0 }, entities: drawing([new Circle({ x: 20, y: -8 }, 3)]), constraints: [] }],
      features: [...block(height).features, { id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "5", direction: "normal", operation: "new" }],
    });
    for (const [height, z] of [["10", 10], ["25", 25]] as const) {
      const r = rebuild(part(height), ENTS);
      const g = r.planes.get("WorkPlane001")!;
      expect(g.error).toBeUndefined();
      expect(g.frame!.origin.z).toBeCloseTo(z);
      expect(g.hingeAt!.z).toBeCloseTo(z);
      expect(r.status.get("Extrude002")).toEqual({ ok: true });
      // The peg: a 3 mm radius disc standing 8 above the hinge, pushed 5 along the plane's normal (along Y).
      const peg = r.bodies[1]!;
      const p = peg.mesh.positions;
      let zMin = Infinity;
      let yLo = Infinity;
      let yHi = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        zMin = Math.min(zMin, p[i + 2]!);
        yLo = Math.min(yLo, p[i + 1]!);
        yHi = Math.max(yHi, p[i + 1]!);
      }
      expect(zMin).toBeCloseTo(z + 5);
      expect(yHi - yLo).toBeCloseTo(5);
      expect(meshVolume(p, peg.mesh.indices)).toBeGreaterThan(Math.PI * 9 * 5 * 0.98);
    }
  });

  it("reports a plane whose face is gone, without breaking the rest", () => {
    const { top, hinge } = topFrontHinge();
    const wp: WorkPlane = { id: "WorkPlane001", base: "XY", axis: "u", offset: "0", angle: "30", on: { face: { ...top.ref, feature: "Gone" }, hinge: hingeRef(hinge) } };
    const r = rebuild({ ...block(), planes: [wp] }, ENTS);
    expect(r.planes.get("WorkPlane001")).toMatchObject({ frame: null, error: "The face this plane is on no longer exists" });
    expect(r.bodies).toHaveLength(1);
    expect(typeof modelPlane(wp.on!, r.bodies, 30, 0)).toBe("string");
  });

  it("round-trips through parsePart; a model plane missing its references is dropped", () => {
    const { top, hinge } = topFrontHinge();
    const wp: WorkPlane = { id: "WorkPlane001", base: "XY", axis: "u", offset: "2", angle: "-(d1)", on: { face: top.ref, hinge: hingeRef(hinge) } };
    expect(parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), planes: [wp] })))!.planes[0]).toEqual(wp);
    expect(parsePart({ planes: [{ id: "W", on: { face: top.ref } }] })!.planes).toHaveLength(0);
    expect(parsePart({ planes: [{ id: "W", base: "XZ", offset: 5 }] })!.planes[0]).toEqual({ id: "W", base: "XZ", offset: "5", angle: "0", axis: "u" });
  });
});
