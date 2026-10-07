import { describe, expect, it } from "vitest";
import { ViewedFile } from "./viewedFile";
import { HOST, readHostMessage } from "./protocol";
import { ORIENTATIONS, newSheet, projectedAxes } from "../drawing/sheet";
import { Circle } from "../entities/circle";
import { emptyPart } from "../part/types";

const line = { type: "line", start: { x: 0, y: 0 }, end: { x: 100, y: 50 }, line_type: "solid", dxf_layer: "0", dxf_color: null, id: "a1" };

/** A PDF's page content stream, inflated if compressed. */
async function pdfContent(bytes: Uint8Array): Promise<string> {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const start = raw.indexOf("stream\n") + 7;
  const end = raw.lastIndexOf("\nendstream");
  if (!raw.includes("/FlateDecode")) return raw.slice(start, end);
  const packed = Uint8Array.from(raw.slice(start, end), (ch) => ch.charCodeAt(0));
  return new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate"))).text();
}

/** What a drawing tab saves: the sheet with its views and a copy of the model (a dia 40 x 80 shaft). */
export function shaftDrawing(): Record<string, unknown> {
  const part = emptyPart();
  part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "80", direction: "normal", operation: "new" });
  const sheet = newSheet();
  sheet.title.title = "SHAFT";
  sheet.views.push({ id: "View1", ...ORIENTATIONS.front, scale: 1, x: 80, y: 120, hiddenLines: true, label: "FRONT VIEW" });
  sheet.views.push({ id: "View2", ...projectedAxes(ORIENTATIONS.front, "right", "first"), scale: 1, x: 160, y: 120, parent: "View1", hiddenLines: true, label: "LEFT VIEW" });
  sheet.model = { name: "Shaft", part, entities: [new Circle({ x: 0, y: 0 }, 20).serialize()] };
  return { entities: [], constraints: [], sheets: [sheet], version: 1 };
}

describe("ViewedFile", () => {
  it("opens a plain 2D drawing and prints it as a PDF", async () => {
    const opened = ViewedFile.open({ entities: [line], constraints: [], version: 1 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.file.kind).toBe("drawing");
    expect(opened.file.bounds()).toEqual([0, 0, 100, 50]);
    const pdf = await opened.file.pdf("fit");
    expect(String.fromCharCode(...pdf.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(pdf.warning).toBeNull();
  });

  it("warns when a 1:1 page cannot hold the drawing", async () => {
    const wide = { ...line, end: { x: 900, y: 50 } };
    const opened = ViewedFile.open({ entities: [wide], constraints: [] });
    if (!opened.ok) throw new Error(opened.message);
    expect((await opened.file.pdf("1:1")).warning).not.toBeNull();
  });

  it("opens a drawing sheet at its paper size", async () => {
    const opened = ViewedFile.open({ entities: [], constraints: [], sheets: [newSheet()] });
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.file.kind).toBe("sheet");
    expect(opened.file.bounds()).toEqual([0, -210, 297, 0]);
    const pdf = await opened.file.pdf("fit");
    expect(String.fromCharCode(...pdf.bytes.subarray(0, 5))).toBe("%PDF-");
  });

  it("draws a saved drawing of a 3D model from the model kept in its sheet", async () => {
    const opened = ViewedFile.open(shaftDrawing());
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.file.kind).toBe("sheet");
    const bare = ViewedFile.open({ entities: [], constraints: [], sheets: [newSheet()] });
    if (!bare.ok) throw new Error(bare.message);
    // the views are on the page, not only the border and title block
    const page = await pdfContent((await opened.file.pdf("fit")).bytes);
    expect(page).toContain("(SHAFT)");
    expect(page).toContain("(FRONT VIEW)");
    const lines = (text: string): number => text.split("\n").filter((op) => / [lc]$/.test(op)).length;
    expect(lines(page)).toBeGreaterThan(lines(await pdfContent((await bare.file.pdf("fit")).bytes)) + 5);
  });

  it("says why a file with nothing to show is not shown", () => {
    expect(ViewedFile.open({ entities: [], constraints: [] })).toEqual({ ok: false, message: "This drawing is empty." });
    const model = ViewedFile.open({ entities: [], constraints: [], part: { features: [] } });
    expect(model.ok).toBe(false);
    if (!model.ok) expect(model.message).toMatch(/3D model with no drawing/);
    expect(ViewedFile.open("nonsense").ok).toBe(false);
  });
});

describe("readHostMessage", () => {
  it("takes only the framing page's own messages", () => {
    expect(readHostMessage({ source: HOST, type: "open", document: { entities: [] } })).toEqual({ source: HOST, type: "open", document: { entities: [] } });
    expect(readHostMessage({ source: HOST, type: "pdf", id: "7", scale: "1:1" })).toEqual({ source: HOST, type: "pdf", id: "7", scale: "1:1" });
    expect(readHostMessage({ source: HOST, type: "pdf", id: "7", scale: "huge" })).toEqual({ source: HOST, type: "pdf", id: "7", scale: "fit" });
    expect(readHostMessage({ source: HOST, type: "hello" })).toEqual({ source: HOST, type: "hello" });
    expect(readHostMessage({ source: "someone-else", type: "open" })).toBeNull();
    expect(readHostMessage({ source: HOST, type: "pdf" })).toBeNull();
    expect(readHostMessage(null)).toBeNull();
  });
});
