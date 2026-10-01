import { describe, expect, it } from "vitest";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import type { Entity } from "../entities/entity";
import { Document } from "./document";
import { constraintError, enforceConstraints } from "./constraints";
import type { Constraint } from "./constraints";
import { makeTestEngine } from "../testUtils/fakeEngine";
import { ConstrainGeometryCommand } from "../commands/constrainGeometry";
import { rebuild } from "../part/rebuild";
import { emptyPart } from "../part/types";
import type { PartData } from "../part/types";
import { projectBodiesWithSources } from "../part/project";
import { modelEdgeRef, modelRefResolver } from "../part/sketchRefs";
import { faceFrameOf } from "../part/rebuild";

const doc = (...entities: Entity[]): Document => {
  const d = new Document();
  for (const e of entities) d.addEntity(e);
  return d;
};
const con = (c: Partial<Constraint> & Pick<Constraint, "driven_entity_id">): Constraint => ({
  id: Math.random().toString(16).slice(2),
  driven_feature: "mid",
  ref_entity_id: "",
  ref_feature: "edge",
  target: 0,
  ...c,
});
const len = (l: Line): number => Math.hypot(l.endPoint.x - l.startPoint.x, l.endPoint.y - l.startPoint.y);

describe("constraints are live", () => {
  it("a distance holds when its reference is moved", () => {
    const wall = new Line({ x: 0, y: 0 }, { x: 0, y: -100 });
    const hole = new Circle({ x: 30, y: -20 }, 5);
    const d = doc(wall, hole);
    d.constraints = [con({ driven_entity_id: hole.id!, driven_feature: "center", ref_entity_id: wall.id!, target: 30 })];
    expect(enforceConstraints(d)).toBe(false); // already holds
    wall.move(15, 0);
    expect(enforceConstraints(d)).toBe(true);
    expect(hole.center.x).toBeCloseTo(45);
    expect(hole.center.y).toBeCloseTo(-20); // only as far as it had to
    // Dragging the hole itself: it slides back onto its line.
    hole.move(-12, 7);
    enforceConstraints(d);
    expect(hole.center.x).toBeCloseTo(45);
    expect(hole.center.y).toBeCloseTo(-13);
  });

  it("a chain settles: a shape measured from a constrained shape follows it", () => {
    const wall = new Line({ x: 0, y: 0 }, { x: 0, y: -100 });
    const a = new Circle({ x: 20, y: -20 }, 3);
    const b = new Circle({ x: 50, y: -20 }, 3);
    const d = doc(wall, a, b);
    d.constraints = [
      con({ driven_entity_id: b.id!, driven_feature: "center", ref_entity_id: a.id!, ref_feature: "center", target: 30 }),
      con({ driven_entity_id: a.id!, driven_feature: "center", ref_entity_id: wall.id!, target: 20 }),
    ];
    wall.move(10, 0);
    enforceConstraints(d);
    expect(a.center.x).toBeCloseTo(30);
    expect(Math.hypot(b.center.x - a.center.x, b.center.y - a.center.y)).toBeCloseTo(30);
    expect((d.constraints as Constraint[]).every((c) => (constraintError(d, c) ?? 1) < 1e-6)).toBe(true);
  });

  it("horizontal / vertical turn a line about its middle, keeping its length", () => {
    const l = new Line({ x: 0, y: 0 }, { x: 30, y: -40 });
    const d = doc(l);
    d.constraints = [con({ driven_entity_id: l.id!, kind: "horizontal" })];
    enforceConstraints(d);
    expect(l.startPoint.y).toBeCloseTo(l.endPoint.y);
    expect(len(l)).toBeCloseTo(50);
    expect(l.midpoint()).toMatchObject({ x: 15, y: -20 });
    (d.constraints as Constraint[])[0]!.kind = "vertical";
    enforceConstraints(d);
    expect(l.startPoint.x).toBeCloseTo(l.endPoint.x);
    expect(len(l)).toBeCloseTo(50);
  });

  it("parallel, perpendicular and equal follow their reference", () => {
    const ref = new Line({ x: 0, y: 0 }, { x: 40, y: -30 });
    const l = new Line({ x: 100, y: 0 }, { x: 100, y: -20 });
    const d = doc(ref, l);
    d.constraints = [con({ driven_entity_id: l.id!, ref_entity_id: ref.id!, kind: "parallel" }), con({ driven_entity_id: l.id!, ref_entity_id: ref.id!, kind: "equal" })];
    enforceConstraints(d);
    const dir = (x: Line): number[] => [(x.endPoint.x - x.startPoint.x) / len(x), (x.endPoint.y - x.startPoint.y) / len(x)];
    expect(Math.abs(dir(l)[0]! * dir(ref)[1]! - dir(l)[1]! * dir(ref)[0]!)).toBeLessThan(1e-9);
    expect(len(l)).toBeCloseTo(50);
    // Turn the reference: the line turns with it.
    ref.rotate(0, 0, 0.4);
    enforceConstraints(d);
    expect(Math.abs(dir(l)[0]! * dir(ref)[1]! - dir(l)[1]! * dir(ref)[0]!)).toBeLessThan(1e-9);
    (d.constraints as Constraint[])[0]!.kind = "perpendicular";
    enforceConstraints(d);
    expect(Math.abs(dir(l)[0]! * dir(ref)[0]! + dir(l)[1]! * dir(ref)[1]!)).toBeLessThan(1e-9);

    const big = new Circle({ x: 0, y: 0 }, 12);
    const small = new Circle({ x: 50, y: 0 }, 3);
    const d2 = doc(big, small);
    d2.constraints = [con({ driven_entity_id: small.id!, ref_entity_id: big.id!, ref_feature: "center", kind: "equal" })];
    enforceConstraints(d2);
    expect(small.radius).toBe(12);
  });

  it("coincident keeps a line's end on another's end", () => {
    const a = new Line({ x: 0, y: 0 }, { x: 50, y: 0 });
    const b = new Line({ x: 53, y: -2 }, { x: 80, y: -40 });
    const d = doc(a, b);
    d.constraints = [con({ driven_entity_id: b.id!, driven_feature: "start", ref_entity_id: a.id!, ref_point: "end", kind: "coincident" })];
    enforceConstraints(d);
    expect(b.startPoint).toMatchObject({ x: 50, y: 0 });
    expect(b.endPoint).toMatchObject({ x: 80, y: -40 }); // only that end moved
    a.endPoint = { x: 60, y: -10 };
    enforceConstraints(d);
    expect(b.startPoint).toMatchObject({ x: 60, y: -10 });
  });
});

describe("the constraint commands", () => {
  it("apply, and refuse one that can't hold with what is already there", () => {
    const engine = makeTestEngine();
    const l = new Line({ x: 0, y: 0 }, { x: 30, y: -40 });
    engine.document.addEntity(l);
    const hor = new ConstrainGeometryCommand(engine, "horizontal");
    hor.start();
    hor.leftClick({ x: 15, y: -20 });
    expect(l.startPoint.y).toBeCloseTo(l.endPoint.y);
    expect(engine.document.constraints).toHaveLength(1);
    // Vertical too can't hold: refused, nothing changes.
    const before = { ...l.startPoint };
    const ver = new ConstrainGeometryCommand(engine, "vertical");
    ver.start();
    ver.leftClick(l.midpoint());
    expect(engine.document.constraints).toHaveLength(1);
    expect((engine.document.getEntities()[0] as Line).startPoint).toMatchObject(before);
  });

  it("parallel to a line picked second", () => {
    const engine = makeTestEngine();
    const ref = new Line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const l = new Line({ x: 0, y: -50 }, { x: 60, y: -80 });
    engine.document.addEntity(ref);
    engine.document.addEntity(l);
    const cmd = new ConstrainGeometryCommand(engine, "parallel");
    cmd.start();
    cmd.leftClick(l.midpoint());
    cmd.leftClick({ x: 50, y: 0 });
    expect(l.startPoint.y).toBeCloseTo(l.endPoint.y);
    expect((engine.document.constraints as Constraint[])[0]).toMatchObject({ kind: "parallel", ref_entity_id: ref.id });
  });
});

describe("a sketch constraint follows the solid", () => {
  const rect = (w: number, h: number): Entity[] => [
    new Line({ x: 0, y: 0 }, { x: w, y: 0 }),
    new Line({ x: w, y: 0 }, { x: w, y: -h }),
    new Line({ x: w, y: -h }, { x: 0, y: -h }),
    new Line({ x: 0, y: -h }, { x: 0, y: 0 }),
  ];
  const block = (w: number): { part: PartData; ents: Record<string, unknown>[] } => ({
    part: { ...emptyPart(), features: [{ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "10", direction: "normal", operation: "new" }] },
    ents: rect(w, 40).map((e) => e.serialize()),
  });

  it("a hole held 15 from the block's far edge moves when the block gets longer", () => {
    // Make the constraint on the 60-long block's top face, against its far (x = 60) edge.
    const first = block(60);
    const built = rebuild(first.part, first.ents);
    const top = built.bodies[0]!.faces.find((f) => f.geom.kind === "plane" && f.geom.normal.z > 0.9)!;
    const frame = faceFrameOf(built.bodies, top.ref)!;
    const sources = projectBodiesWithSources(built.bodies, frame);
    const far = sources.find((s) => s.entity instanceof Line && Math.abs(s.entity.startPoint.x - 60) < 1e-9 && Math.abs(s.entity.endPoint.x - 60) < 1e-9)!;
    const ref = modelEdgeRef(far)!;
    expect(ref.faces).toHaveLength(2);
    const farLine = far.entity as Line;
    const hole = new Circle({ x: 45, y: -20 }, 4);
    // Signed 15 on the block's side of that edge.
    const side = (farLine.endPoint.y - farLine.startPoint.y) > 0 ? 1 : -1;
    const constraint: Constraint = {
      id: "c1",
      driven_entity_id: hole.id!,
      driven_feature: "center",
      ref_entity_id: "",
      ref_feature: "edge",
      target: 15 * side,
      ref_geom: { a: { ...farLine.startPoint }, b: { ...farLine.endPoint } },
      ref_model: ref,
    };
    // The resolver finds that same edge again in the built model.
    expect(modelRefResolver(sources)(constraint)).toBe(far.entity);

    const withSketch = (w: number): { part: PartData; ents: Record<string, unknown>[] } => {
      const b = block(w);
      return {
        ents: b.ents,
        part: {
          ...b.part,
          sketches: [{ id: "Sketch001", plane: { base: "face", offset: 0, face: top.ref }, entities: [hole.serialize()], constraints: [constraint] }],
          features: [...b.part.features, { id: "Extrude002", type: "extrude", sketch: "Sketch001", profiles: "all", distance: "5", direction: "reverse", operation: "cut" }],
        },
      };
    };
    const centreX = (w: number): number => {
      const { part, ents } = withSketch(w);
      const r = rebuild(part, ents);
      expect(r.status.get("Extrude002")).toEqual({ ok: true });
      return (r.sketches.get("Sketch001")!.entities[0] as Circle).center.x;
    };
    expect(centreX(60)).toBeCloseTo(45);
    expect(centreX(100)).toBeCloseTo(85); // still 15 from the far edge
    expect(centreX(50)).toBeCloseTo(35);
  });
});
