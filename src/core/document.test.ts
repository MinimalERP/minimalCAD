import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Document, boundsOf, originAlign, placeBeside, PLACEMENT_MARGIN } from "./document";
import { Line } from "../entities/line";
import { Circle } from "../entities/circle";
import { parseDocumentJson } from "../io/fileFormat";

const fixturePath = fileURLToPath(
  new URL("../../test-fixtures/desktop-export-sample.jcad", import.meta.url),
);
const fixtureText = readFileSync(fixturePath, "utf-8");

describe("Document", () => {
  it("round-trips embedded image references in JCAD snapshots", () => {
    const doc = new Document();
    doc.imageReferences.push({
      id: "image-1", name: "trace.png", dataUrl: "data:image/png;base64,aGVsbG8=",
      x: 1, y: 2, width: 30, height: 20, rotation: 12, opacity: 0.4, locked: true,
    });
    const restored = new Document();
    restored.restoreFromDict(JSON.parse(JSON.stringify(doc.toDict())));
    expect(restored.imageReferences).toEqual(doc.imageReferences);
  });

  it("addEntity/removeEntity/getBounds round-trip", () => {
    const doc = new Document();
    const a = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    const b = new Line({ x: 0, y: 0 }, { x: 0, y: 5 });
    doc.addEntity(a);
    doc.addEntity(b);
    expect(doc.getBounds()).toEqual([0, 0, 10, 5]);

    doc.removeEntity(a);
    expect(doc.getEntities()).toEqual([b]);
  });

  it("removeEntity purges constraints referencing the removed entity's id", () => {
    const doc = new Document();
    const a = new Line({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.addEntity(a);
    doc.constraints = [{ driven_entity_id: a.id, ref_entity_id: "other" }];
    doc.removeEntity(a);
    expect(doc.constraints).toEqual([]);
  });

  it("toDict()/restoreFromDict() round-trips a Document with a real Line", () => {
    const doc = new Document();
    doc.addEntity(new Line({ x: 1, y: 2 }, { x: 3, y: 4 }));
    const snapshot = doc.toDict();

    const doc2 = new Document();
    doc2.restoreFromDict(snapshot);
    expect(doc2.toDict()).toEqual(snapshot);
  });

  describe("loading a real desktop-app-exported file", () => {
    it("parses the JSON shape via parseDocumentJson", () => {
      const result = parseDocumentJson(fixtureText);
      expect(result.ok).toBe(true);
    });

    it("recovers every entity type currently registered, skips the rest", () => {
      const parsed = parseDocumentJson(fixtureText);
      if (!parsed.ok) throw new Error(parsed.error);

      const doc = new Document();
      const parseResult = doc.restoreFromDict(parsed.snapshot);

      // line, circle, arc, polyline, ellipse are all registered
      // (entities/registry.ts) -- nothing in this fixture is unsupported.
      expect(parseResult.entities).toHaveLength(6);
      expect(parseResult.skippedCount).toBe(0);
    });

    it("re-serializes recovered entities field-for-field identical to the source JSON", () => {
      const parsed = parseDocumentJson(fixtureText);
      if (!parsed.ok) throw new Error(parsed.error);

      const doc = new Document();
      doc.restoreFromDict(parsed.snapshot);

      const recognizedTypes = new Set(["line", "circle", "arc", "polyline", "ellipse"]);
      const sourceRecognized = parsed.snapshot.entities.filter((e) =>
        recognizedTypes.has(e.type as string),
      );
      expect(doc.entities).toHaveLength(sourceRecognized.length);

      for (const entity of doc.entities) {
        const source = sourceRecognized.find((s) => s.id === entity.id);
        expect(source).toBeDefined();
        expect(entity.serialize()).toEqual(source);
      }
    });

    it("carries the constraints array through untouched (opaque passthrough)", () => {
      const parsed = parseDocumentJson(fixtureText);
      if (!parsed.ok) throw new Error(parsed.error);

      const doc = new Document();
      doc.restoreFromDict(parsed.snapshot);
      expect(doc.constraints).toEqual(parsed.snapshot.constraints);
      expect(doc.constraints).toHaveLength(1);
    });
  });
});

describe("boundsOf/originAlign/placeBeside (Insert Drawing placement helpers)", () => {
  it("boundsOf combines multiple entities' bounding boxes", () => {
    const a = new Circle({ x: 0, y: 0 }, 5); // bounds [-5,-5,5,5]
    const b = new Circle({ x: 20, y: 10 }, 2); // bounds [18,8,22,12]
    expect(boundsOf([a, b])).toEqual([-5, -5, 22, 12]);
  });

  it("originAlign moves entities so their bbox's left edge is x=0 and bottom (max Y) is y=0", () => {
    const line = new Line({ x: 10, y: 20 }, { x: 30, y: 40 });
    originAlign([line]);
    expect(line.startPoint).toEqual({ x: 0, y: -20 });
    expect(line.endPoint).toEqual({ x: 20, y: 0 });
    const [x0, , , y1] = line.getBounds();
    expect(x0).toBe(0);
    expect(y1).toBe(0);
  });

  it("originAlign is a no-op when the bbox is already aligned", () => {
    const line = new Line({ x: 0, y: -10 }, { x: 10, y: 0 });
    originAlign([line]);
    expect(line.startPoint).toEqual({ x: 0, y: -10 });
    expect(line.endPoint).toEqual({ x: 10, y: 0 });
  });

  it("placeBeside moves entities to sit right of targetBounds with the placement margin, bottom-aligned", () => {
    const targetBounds: [number, number, number, number] = [0, 0, 100, 50];
    const incoming = new Line({ x: 0, y: 0 }, { x: 20, y: 10 }); // bounds [0,0,20,10]
    placeBeside(targetBounds, [incoming]);

    const [x0, , , y1] = incoming.getBounds();
    expect(x0).toBe(100 + PLACEMENT_MARGIN);
    expect(y1).toBe(50); // bottom (max Y) of incoming lines up with target's max Y
  });

  it("placeBeside keeps the incoming group's own internal layout, just translated", () => {
    const targetBounds: [number, number, number, number] = [0, 0, 10, 10];
    const a = new Line({ x: 0, y: 0 }, { x: 5, y: 0 });
    const b = new Line({ x: 0, y: 5 }, { x: 5, y: 5 });
    placeBeside(targetBounds, [a, b]);
    // b was 5 units above a before the move; that relative offset survives a pure translation.
    expect(b.startPoint.y - a.startPoint.y).toBe(5);
  });
});
