import { describe, expect, it } from "vitest";
import { parseDocumentJson, serializeDocument, validateDocumentSnapshot } from "./fileFormat";
import { Document } from "../core/document";
import { Line } from "../entities/line";

describe("parseDocumentJson", () => {
  it("returns an error (not a throw) for malformed JSON", () => {
    const result = parseDocumentJson("{not valid json");
    expect(result.ok).toBe(false);
  });

  it("returns an error for valid JSON that isn't a document object", () => {
    expect(parseDocumentJson("[1,2,3]").ok).toBe(false);
    expect(parseDocumentJson('"just a string"').ok).toBe(false);
    expect(parseDocumentJson("null").ok).toBe(false);
  });

  it("defaults missing entities/constraints arrays to empty rather than erroring", () => {
    const result = parseDocumentJson("{}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.entities).toEqual([]);
      expect(result.snapshot.constraints).toEqual([]);
    }
  });
});

describe("serializeDocument", () => {
  it("produces JSON that parseDocumentJson accepts back", () => {
    const doc = new Document();
    doc.addEntity(new Line({ x: 0, y: 0 }, { x: 1, y: 1 }));
    const json = serializeDocument(doc);
    const result = parseDocumentJson(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.entities).toHaveLength(1);
    }
  });

  it("matches the desktop app's exact .jcad shape: flat {entities, constraints, version}", () => {
    const doc = new Document();
    doc.addEntity(new Line({ x: 0, y: 0 }, { x: 1, y: 1 }));
    const parsed = JSON.parse(serializeDocument(doc));

    // Flat, not a nested {"document": {...}} envelope -- matches
    // file_io/jcad.py's save(): json.dump({**document.to_dict(), "version": 1}, ...)
    expect(Object.keys(parsed)).toEqual(["entities", "constraints", "version"]);
    expect(parsed.version).toBe(1);
  });

  it("is pretty-printed with 2-space indent, matching json.dump(..., indent=2)", () => {
    const doc = new Document();
    const json = serializeDocument(doc);
    expect(json).toContain("\n  \"entities\"");
  });
});

describe("validateDocumentSnapshot", () => {
  it("validates an already-parsed object the same way parseDocumentJson validates text -- the shape "
    + "io/cloudDrawings.ts's jsonb payloads and a local file's parsed JSON both go through", () => {
    const raw = { entities: [{ type: "line" }], constraints: [{ x: 1 }] };
    expect(validateDocumentSnapshot(raw)).toEqual({ ok: true, snapshot: raw });
  });

  it("rejects a non-object payload without needing a JSON.parse step first", () => {
    expect(validateDocumentSnapshot("just a string").ok).toBe(false);
    expect(validateDocumentSnapshot([1, 2, 3]).ok).toBe(false);
    expect(validateDocumentSnapshot(null).ok).toBe(false);
  });

  it("defaults missing entities/constraints to empty arrays, matching parseDocumentJson", () => {
    const result = validateDocumentSnapshot({});
    expect(result).toEqual({ ok: true, snapshot: { entities: [], constraints: [] } });
  });
});

describe("3D part passthrough", () => {
  it("omits part/sheets keys entirely for a pure-2D document", () => {
    const doc = new Document();
    doc.addEntity(new Line({ x: 0, y: 0 }, { x: 1, y: 1 }));
    const obj = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual(["constraints", "entities", "version"]);
  });

  it("round-trips part and sheets through save -> parse -> restore", () => {
    const part = { schema: 1, units: "mm", parameters: [], sketches: [], features: [{ id: "Extrude001" }] };
    const doc = new Document();
    doc.part = part;
    doc.sheets = [{ id: "Sheet1" }];
    const result = parseDocumentJson(serializeDocument(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = new Document();
    restored.restoreFromDict(result.snapshot);
    expect(restored.part).toEqual(part);
    expect(restored.sheets).toEqual([{ id: "Sheet1" }]);
  });

  it("ignores a malformed part value instead of failing the load", () => {
    const result = validateDocumentSnapshot({ entities: [], part: [1, 2] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.part).toBeUndefined();
  });

  it("snapshots are deep copies, so later part edits don't mutate undo history", () => {
    const doc = new Document();
    doc.part = { features: [] as unknown[] };
    const snap = doc.toDict();
    (doc.part as { features: unknown[] }).features.push({ id: "x" });
    expect((snap.part as { features: unknown[] }).features).toHaveLength(0);
  });
});
