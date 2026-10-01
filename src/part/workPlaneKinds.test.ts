import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { rebuild } from "./rebuild";
import { emptyPart, modelPlaneKind, parsePart } from "./types";
import type { ModelPlaneRef, PartData, WorkPlane } from "./types";
import type { Body, Face } from "./kernel/types";
import { faceCentre, midFrame, modelPlane, parallelFrame, pointsFrame, tangentFrame } from "./workPlane";
import { cross, dot } from "./vec3";

const drawing = (e: Entity[]): Record<string, unknown>[] => e.map((x) => x.serialize());
const rect = (w: number, h: number): Entity[] => [
  new Line({ x: 0, y: 0 }, { x: w, y: 0 }),
  new Line({ x: w, y: 0 }, { x: w, y: -h }),
  new Line({ x: w, y: -h }, { x: 0, y: -h }),
  new Line({ x: 0, y: -h }, { x: 0, y: 0 }),
];
const extrude = (distance: string): PartData => ({
  ...emptyPart(),
  features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance, direction: "normal", operation: "new" }],
});
/** A 40 x 30 x 10 block, and a Ø20 x 50 upright shaft. */
const BLOCK = drawing(rect(40, 30));
const SHAFT = drawing([new Circle({ x: 0, y: 0 }, 10)]);
const flat = (body: Body, pick: (n: { x: number; y: number; z: number }) => boolean): Face =>
  body.faces.find((f) => f.geom.kind === "plane" && pick(f.geom.normal))!;
const rightHanded = (f: { u: { x: number; y: number; z: number }; v: { x: number; y: number; z: number }; n: { x: number; y: number; z: number } }): void => {
  expect(dot(cross(f.u, f.v), f.n)).toBeCloseTo(1);
};

describe("plane tangent to a round face", () => {
  const body = rebuild(extrude("50"), SHAFT).bodies[0]!;
  const round = body.faces.find((f) => f.geom.kind === "cylinder")!;

  it("touches the shaft at the angle, horizontal along the axis, normal pointing out", () => {
    const { frame, centerAt } = tangentFrame(body, round, 0, 0);
    expect(frame.n).toMatchObject({ x: 1, y: 0, z: 0 }); // a vertical shaft's zero is +X
    expect(Math.abs(frame.u.z)).toBeCloseTo(1); // along the axis
    expect(frame.origin.x).toBeCloseTo(10); // on the surface
    expect(frame.origin.z).toBeCloseTo(0); // level with the model origin
    expect(centerAt.z).toBeCloseTo(25); // drawn at the middle of the shaft's length
    rightHanded(frame);
    const quarter = tangentFrame(body, round, 90, 0).frame;
    expect(quarter.n.y).toBeCloseTo(1);
    expect(quarter.origin.y).toBeCloseTo(10);
  });

  it("a negative offset sinks it into the shaft (a flat / keyway seat)", () => {
    const { frame } = tangentFrame(body, round, 0, -3);
    expect(frame.origin.x).toBeCloseTo(7);
  });

  it("follows the shaft through a rebuild; a sketch on it cuts a flat", () => {
    const wp: WorkPlane = { id: "WorkPlane001", base: "XY", axis: "u", offset: "-2", angle: "0", on: { face: round.ref, tangent: true } };
    const part: PartData = {
      ...extrude("50"),
      planes: [wp],
      sketches: [{ id: "Sketch001", plane: { base: "WorkPlane001", offset: 0 }, entities: drawing([
        new Line({ x: 12, y: -15 }, { x: 28, y: -15 }),
        new Line({ x: 28, y: -15 }, { x: 28, y: 15 }),
        new Line({ x: 28, y: 15 }, { x: 12, y: 15 }),
        new Line({ x: 12, y: 15 }, { x: 12, y: -15 }),
      ]), constraints: [] }],
      features: [...extrude("50").features, { id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "10", direction: "normal", operation: "cut" }],
    };
    const r = rebuild(part, SHAFT);
    expect(r.planes.get("WorkPlane001")?.error).toBeUndefined();
    expect(r.planes.get("WorkPlane001")!.frame!.origin.x).toBeCloseTo(8);
    expect(r.status.get("Extrude002")).toEqual({ ok: true });
    // The flat: nothing left beyond x = 8 where the sketch covered the shaft.
    const p = r.bodies[0]!.mesh.positions;
    let far = -Infinity;
    for (let i = 0; i < p.length; i += 3) if (p[i + 2]! > 13 && p[i + 2]! < 27) far = Math.max(far, p[i]!);
    expect(far).toBeLessThan(8 + 1e-6);
  });
});

describe("planes from flat faces and points", () => {
  const body = rebuild(extrude("10"), BLOCK).bodies[0]!;
  const top = flat(body, (n) => n.z > 0.9);
  const bottom = flat(body, (n) => n.z < -0.9);
  const side = flat(body, (n) => n.x > 0.9);

  it("parallel: the face's own sketch frame, moved out by the offset", () => {
    const { frame, centerAt } = parallelFrame(body, top, 5);
    expect(frame.n.z).toBeCloseTo(1);
    expect(frame.origin.z).toBeCloseTo(15);
    expect(centerAt).toMatchObject({ x: 20, z: 15 });
    expect(faceCentre(body, top).y).toBeCloseTo(15);
    rightHanded(frame);
  });

  it("mid: halfway between two parallel faces; refuses faces that aren't", () => {
    const m = midFrame({ body, face: top }, { body, face: bottom }, 0);
    expect(typeof m).toBe("object");
    if (typeof m === "string") return;
    expect(m.frame.origin.z).toBeCloseTo(5);
    expect(m.frame.n.z).toBeCloseTo(1); // faces the way the first face does
    expect(midFrame({ body, face: top }, { body, face: side }, 0)).toMatch(/not parallel/);
    expect(midFrame({ body, face: top }, { body, face: top }, 0)).toMatch(/same plane/);
  });

  it("points: through all three, horizontal from the first toward the second", () => {
    const p = pointsFrame([{ x: 0, y: 0, z: 10 }, { x: 40, y: 0, z: 10 }, { x: 40, y: 30, z: 0 }], 0);
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.frame.u).toMatchObject({ x: 1, y: 0, z: 0 });
    for (const q of [{ x: 0, y: 0, z: 10 }, { x: 40, y: 0, z: 10 }, { x: 40, y: 30, z: 0 }]) {
      expect(dot({ x: q.x - p.frame.origin.x, y: q.y - p.frame.origin.y, z: q.z - p.frame.origin.z }, p.frame.n)).toBeCloseTo(0);
    }
    rightHanded(p.frame);
    expect(pointsFrame([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }], 0)).toMatch(/one line/);
  });

  it("every kind resolves through modelPlane, rebuilds, and round-trips", () => {
    const refs: ModelPlaneRef[] = [
      { face: top.ref, parallel: true },
      { face: top.ref, face2: bottom.ref },
      { points: [{ x: 0, y: 0, z: 10 }, { x: 40, y: 0, z: 10 }, { x: 40, y: 30, z: 0 }] },
    ];
    expect(refs.map(modelPlaneKind)).toEqual(["parallel", "mid", "points"]);
    const planes: WorkPlane[] = refs.map((on, i) => ({ id: `WorkPlane00${i + 1}`, base: "XY", axis: "u", offset: "0", angle: "0", on }));
    const r = rebuild({ ...extrude("10"), planes }, BLOCK);
    for (const wp of planes) {
      expect(r.planes.get(wp.id)?.frame).not.toBeNull();
      expect(typeof modelPlane(wp.on!, r.bodies, 0, 0)).toBe("object");
    }
    expect(parsePart(JSON.parse(JSON.stringify({ ...emptyPart(), planes })))!.planes).toEqual(planes);
    // The block grows: the mid plane stays in the middle.
    expect(rebuild({ ...extrude("30"), planes }, BLOCK).planes.get("WorkPlane002")!.frame!.origin.z).toBeCloseTo(15);
  });
});
