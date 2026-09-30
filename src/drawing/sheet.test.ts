import { describe, expect, it } from "vitest";
import { Circle } from "../entities/circle";
import { rebuild } from "../part/rebuild";
import { emptyPart } from "../part/types";
import { exportSheetPdf } from "../io/pdf";
import type { SheetView } from "./sheet";
import type { Orient } from "./orientCube";
import { faceOn, turn } from "./orientCube";
import { ORIENTATIONS, PAPER_SIZE, ViewCache, formatScale, isoAxes, relativeName, reproject, shadeColor, newSheet, orientationName, paintSheet, parseScale, parseSheets, projectedAxes, sheetGraphics } from "./sheet";

const front: Pick<SheetView, "dir" | "up"> = ORIENTATIONS.front;

/** A PDF's page content stream, inflated if compressed. */
async function pdfContent(bytes: Uint8Array): Promise<string> {
  // Byte-exact (TextDecoder's "latin1" is really windows-1252).
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const start = raw.indexOf("stream\n") + 7;
  const end = raw.lastIndexOf("\nendstream");
  if (!raw.includes("/FlateDecode")) return raw.slice(start, end);
  const body = Uint8Array.from(raw.slice(start, end), (c) => c.charCodeAt(0) & 0xff);
  const out = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
  return new TextDecoder("latin1").decode(out);
}

describe("projected views", () => {
  it("first angle: top view goes BELOW the front, left view on the RIGHT", () => {
    expect(orientationName(projectedAxes(front, "down", "first"))).toBe("Top");
    expect(orientationName(projectedAxes(front, "right", "first"))).toBe("Left");
    expect(orientationName(projectedAxes(front, "left", "first"))).toBe("Right");
    expect(orientationName(projectedAxes(front, "up", "first"))).toBe("Bottom");
  });

  it("third angle: top view ABOVE the front, right view on the right", () => {
    expect(orientationName(projectedAxes(front, "up", "third"))).toBe("Top");
    expect(orientationName(projectedAxes(front, "right", "third"))).toBe("Right");
    expect(orientationName(projectedAxes(front, "left", "third"))).toBe("Left");
    expect(orientationName(projectedAxes(front, "down", "third"))).toBe("Bottom");
  });
});

describe("iso projected views", () => {
  it("off the front view's upper-right corner: the standard SE iso", () => {
    const a = isoAxes(front, 1, 1);
    const iso = ORIENTATIONS.iso.dir;
    expect(a.dir.x).toBeCloseTo(iso.x, 12);
    expect(a.dir.y).toBeCloseTo(iso.y, 12);
    expect(a.dir.z).toBeCloseTo(iso.z, 12);
  });
});

describe("scales", () => {
  it("parse and format like a drawing writes them", () => {
    expect(parseScale("1:2")).toBe(0.5);
    expect(parseScale("2:1")).toBe(2);
    expect(parseScale("0.2")).toBe(0.2);
    expect(parseScale("x")).toBeNull();
    expect(formatScale(0.5)).toBe("1:2");
    expect(formatScale(1)).toBe("1:1");
    expect(formatScale(5)).toBe("5:1");
  });
});

describe("sheet", () => {
  const shaft = (): ReturnType<typeof rebuild>["bodies"] => {
    const part = emptyPart();
    part.features.push({ id: "Extrude001", type: "extrude", sketch: "Drawing", profiles: "all", distance: "80", direction: "normal", operation: "new" });
    part.features.push({
      id: "Hole001",
      type: "hole",
      placement: "radial",
      face: { feature: "Extrude001", role: "side", index: "0.0.0" },
      centers: [0, 45, 90, 135].map((a) => ({ x: 40, y: a })),
      diameter: "10",
      depth: "5",
      extent: "through",
      style: "plain",
    });
    return rebuild(part, [new Circle({ x: 0, y: 0 }, 20).serialize()]).bodies;
  };

  it("round-trips through Document.sheets, dropping junk", () => {
    const s = newSheet();
    s.paper = "A2";
    s.projection = "third";
    s.title.title = "SHAFT";
    const back = parseSheets(JSON.parse(JSON.stringify([s, 7, { id: 3 }])));
    expect(back).toHaveLength(1);
    expect(back[0]!.paper).toBe("A2");
    expect(back[0]!.projection).toBe("third");
    expect(back[0]!.title.title).toBe("SHAFT");
  });

  it("views of the crossing-holes shaft: placed where asked, at scale, in reasonable time", () => {
    const bodies = shaft();
    const s = newSheet();
    s.views.push({ id: "View1", ...ORIENTATIONS.front, scale: 1, x: 80, y: 120, hiddenLines: true, label: "FRONT VIEW" });
    const side = projectedAxes(ORIENTATIONS.front, "right", "first");
    s.views.push({ id: "View2", ...side, scale: 1, x: 160, y: 120, parent: "View1", hiddenLines: true, label: "LEFT VIEW" });
    const t0 = performance.now();
    const g = sheetGraphics(s, bodies, new ViewCache());
    expect(performance.now() - t0).toBeLessThan(5000);
    const box = g.views.find((v) => v.id === "View1")!.box;
    // Ø40 x 80 shaft at 1:1, centred on (80, 120) paper = (80, -120) world.
    expect(box[2] - box[0]).toBeCloseTo(40, 3);
    expect(box[3] - box[1]).toBeCloseTo(80, 3);
    expect((box[0] + box[2]) / 2).toBeCloseTo(80, 6);
    expect((box[1] + box[3]) / 2).toBeCloseTo(-120, 6);
    // Snappable geometry exists for dimensioning.
    expect(g.snap.length).toBeGreaterThan(8);
    // Hidden lines are there (the holes' bores).
    expect(g.prims.some((p) => "pen" in p && p.pen === "hidden")).toBe(true);
  });

  it("title block carries the fields, scale and projection", () => {
    const s = newSheet();
    s.title = { ...s.title, title: "SHAFT", drawingNo: "MC-001", material: "EN8" };
    s.views.push({ id: "View1", ...ORIENTATIONS.front, scale: 0.5, x: 80, y: 120, hiddenLines: true, label: "FRONT VIEW" });
    const texts = sheetGraphics(s, [], new ViewCache())
      .prims.filter((p) => p.kind === "text")
      .map((p) => (p.kind === "text" ? p.text : ""));
    for (const t of ["SHAFT", "MC-001", "EN8", "1:2", "1ST ANGLE"]) expect(texts).toContain(t);
  });

  it("a shaded view: one outline per flat patch, far to near, edges on top; prints small", async () => {
    const bodies = shaft();
    const s = newSheet();
    s.views.push({ id: "View1", ...ORIENTATIONS.iso, scale: 1, x: 100, y: 110, hiddenLines: false, style: "shaded", label: "ISO VIEW" });
    const g = sheetGraphics(s, bodies, new ViewCache());
    const patches = g.prims.filter((p) => p.kind === "shade");
    const triangles = bodies.reduce((n, b) => n + b.mesh.indices.length / 3, 0);
    expect(patches.length).toBeGreaterThan(20);
    expect(patches.length).toBeLessThan(triangles / 4); // merged, not per triangle
    const firstLine = g.prims.findIndex((p) => "pen" in p && p.pen === "visible");
    const lastPatch = g.prims.map((p) => p.kind).lastIndexOf("shade");
    expect(lastPatch).toBeLessThan(firstLine); // edges drawn over the shading
    expect(g.prims.some((p) => "pen" in p && p.pen === "hidden")).toBe(false);
    const bytes = await exportSheetPdf(297, 210, (ctx, vp) => paintSheet(ctx, vp, s, g, { paper: null, ink: "#000", minWidth: 0, shade: (v) => shadeColor([236, 238, 242], v) }), []);
    const text = await pdfContent(bytes);
    expect(text).toMatch(/\d\.\d{3} \d\.\d{3} \d\.\d{3} rg/);
    expect(text).toContain("\nB*\n");
    expect(bytes.length).toBeLessThan(150_000); // compressed: easy to email
  });

  it("prints as a true-size PDF page (A4 and A2)", async () => {
    for (const paper of ["A4", "A2"] as const) {
      const s = newSheet();
      s.paper = paper;
      const g = sheetGraphics(s, [], new ViewCache());
      const bytes = await exportSheetPdf(PAPER_SIZE[paper].w, PAPER_SIZE[paper].h, (ctx, vp) => paintSheet(ctx, vp, s, g, { paper: null, ink: "#000", minWidth: 0, shade: () => "#ccc" }), []);
      const text = new TextDecoder("latin1").decode(bytes) + (await pdfContent(bytes));
      const pt = (mm: number): string => ((mm * 72) / 25.4).toFixed(3);
      expect(text.startsWith("%PDF-1.4")).toBe(true);
      expect(text).toContain(`/MediaBox [0 0 ${pt(PAPER_SIZE[paper].w)} ${pt(PAPER_SIZE[paper].h)}]`);
      // Border drawn at its real 0.7 mm weight.
      expect(text).toContain(`${((0.7 * 72) / 25.4).toFixed(3)} w`);
    }
  });
});

describe("orientation cube + the main view", () => {
  const name = (o: { dir: { x: number; y: number; z: number }; up: { x: number; y: number; z: number } }): string => orientationName(o);

  it("tumbles and rolls reach every side; four rolls come back", () => {
    let o = { dir: ORIENTATIONS.front.dir, up: ORIENTATIONS.front.up } as Orient;
    expect(name(turn(o, "right"))).toBe("Right");
    expect(name(turn(o, "left"))).toBe("Left");
    expect(name(turn(o, "up"))).toBe("Top");
    expect(name(turn(o, "down"))).toBe("Bottom");
    for (let i = 0; i < 4; i++) o = turn(o, "cw");
    expect(name(o)).toBe("Front");
    // One roll: still looking at the front, but turned on the paper.
    const rolled = turn(o, "cw");
    expect(rolled.dir).toEqual(ORIENTATIONS.front.dir);
    expect(rolled.up.x).toBeCloseTo(-1, 12);
  });

  it("clicking a face looks straight at it, keeping a sensible up", () => {
    const front = { dir: ORIENTATIONS.front.dir, up: ORIENTATIONS.front.up } as Orient;
    expect(name(faceOn(front, ORIENTATIONS.top.dir))).toBe("Top");
    expect(name(faceOn(front, ORIENTATIONS.bottom.dir))).toBe("Bottom");
    expect(name(faceOn(front, ORIENTATIONS.right.dir))).toBe("Right");
  });

  it("the chosen side is the FRONT: projected views are named from it", () => {
    // Part turned so its right side is the main view.
    const base: SheetView = { id: "View1", ...ORIENTATIONS.right, scale: 1, x: 100, y: 120, hiddenLines: true, label: "FRONT VIEW" };
    const below: SheetView = { id: "View2", ...projectedAxes(base, "down", "first"), scale: 1, x: 100, y: 50, parent: "View1", hiddenLines: true, label: "X" };
    expect(relativeName(below, base)).toBe("TOP VIEW");
    const beside: SheetView = { id: "View3", ...projectedAxes(base, "right", "first"), scale: 1, x: 180, y: 120, parent: "View1", hiddenLines: true, label: "X" };
    expect(relativeName(beside, base)).toBe("LEFT VIEW");
  });

  it("switching 1st -> 3rd angle keeps places and swaps which view each is", () => {
    const base: SheetView = { id: "View1", ...ORIENTATIONS.front, scale: 1, x: 100, y: 120, hiddenLines: true, label: "FRONT VIEW" };
    const right: SheetView = { id: "View2", ...projectedAxes(base, "right", "first"), scale: 1, x: 180, y: 120, parent: "View1", hiddenLines: true, label: "LEFT VIEW" };
    const below: SheetView = { id: "View3", ...projectedAxes(base, "down", "first"), scale: 1, x: 100, y: 40, parent: "View1", hiddenLines: true, label: "TOP VIEW" };
    const next = reproject([base, right, below], "third");
    expect(next.map((v) => v.label)).toEqual(["FRONT VIEW", "RIGHT VIEW", "BOTTOM VIEW"]);
    expect(next.map((v) => [v.x, v.y])).toEqual([[100, 120], [180, 120], [100, 40]]);
    expect(name(next[1]!)).toBe("Right");
  });
});
