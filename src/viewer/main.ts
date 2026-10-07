/**
 * MinimalCAD Web
 * viewer/main.ts
 *
 * The view-only page (view.html): shows one saved drawing, to be looked at
 * and printed on the shop floor -- a finger or the mouse moves it, a pinch
 * or the wheel zooms, and that is all. It is framed by the page that has
 * the file (MinimalERP's item master, in a browser or its Android app) and
 * is handed the drawing by message (viewer/protocol.ts); it signs in to
 * nothing and saves nothing.
 */

import type { Point } from "../core/types";
import { Viewport } from "../engine/viewport";
import { BACKGROUND, ViewedFile } from "./viewedFile";
import { VIEWER, readHostMessage } from "./protocol";

const canvas = document.getElementById("view-canvas") as HTMLCanvasElement;
const note = document.getElementById("view-note") as HTMLElement;
const ctx = canvas.getContext("2d")!;
const viewport = new Viewport(
  () => canvas.clientWidth,
  () => canvas.clientHeight,
);

let file: ViewedFile | null = null;
let queued = false;

function say(text: string): void {
  note.textContent = text;
  note.hidden = text === "";
}

function render(): void {
  queued = false;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.save();
  ctx.scale(dpr, dpr);
  if (file === null) {
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
  } else {
    file.paint(ctx, viewport, width, height);
  }
  ctx.restore();
}

function redraw(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(render);
}

function fit(): void {
  if (file !== null) viewport.zoomExtents(file.bounds());
  redraw();
}

/** Zooms by `factor` keeping the world point under `at` (canvas px) still. */
function zoomAt(at: Point, factor: number): void {
  const zoom = Math.min(2000, Math.max(0.005, viewport.zoom * factor));
  const world = viewport.screenToWorld(at);
  viewport.zoom = zoom;
  viewport.panOffset = { x: at.x - world.x * zoom, y: at.y - world.y * zoom };
  redraw();
}

// --- moving the drawing: one pointer pans, two pinch; the wheel zooms ---

const pointers = new Map<number, Point>();
let lastTap = 0;

function local(e: PointerEvent | WheelEvent): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, local(e));
  if (pointers.size === 1 && e.pointerType === "touch") {
    if (e.timeStamp - lastTap < 300) fit(); // a double tap fits the drawing again
    lastTap = e.timeStamp;
  }
});
canvas.addEventListener("pointermove", (e) => {
  const before = pointers.get(e.pointerId);
  if (before === undefined) return;
  const now = local(e);
  if (pointers.size === 1) {
    viewport.panOffset = { x: viewport.panOffset.x + now.x - before.x, y: viewport.panOffset.y + now.y - before.y };
    pointers.set(e.pointerId, now);
    redraw();
    return;
  }
  const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
  pointers.set(e.pointerId, now);
  if (other === undefined) return;
  const was = Math.hypot(before.x - other.x, before.y - other.y);
  const is = Math.hypot(now.x - other.x, now.y - other.y);
  const midWas = { x: (before.x + other.x) / 2, y: (before.y + other.y) / 2 };
  const mid = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
  viewport.panOffset = { x: viewport.panOffset.x + mid.x - midWas.x, y: viewport.panOffset.y + mid.y - midWas.y };
  if (was > 1) zoomAt(mid, is / was);
  else redraw();
});
const lift = (e: PointerEvent): void => {
  pointers.delete(e.pointerId);
};
canvas.addEventListener("pointerup", lift);
canvas.addEventListener("pointercancel", lift);
canvas.addEventListener("dblclick", fit);
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAt(local(e), Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);
document.getElementById("view-fit")?.addEventListener("click", fit);
new ResizeObserver(() => render()).observe(canvas);

// --- the framing page: it hands the drawing over, and asks for the PDF ---

const host: Window = window.parent;

function tell(to: string, message: Record<string, unknown>, transfer: Transferable[] = []): void {
  host.postMessage({ source: VIEWER, ...message }, to, transfer);
}

window.addEventListener("message", (e) => {
  if (e.source !== host) return;
  const message = readHostMessage(e.data);
  if (message === null) return;
  const origin = e.origin === "null" ? "*" : e.origin;
  if (message.type === "hello") {
    tell(origin, { type: "ready" });
    return;
  }
  if (message.type === "open") {
    const opened = ViewedFile.open(message.document);
    if (!opened.ok) {
      file = null;
      say(opened.message);
      redraw();
      tell(origin, { type: "problem", message: opened.message });
      return;
    }
    file = opened.file;
    say("");
    render(); // sized before the fit
    fit();
    tell(origin, { type: "opened", kind: file.kind });
    return;
  }
  if (file === null) {
    tell(origin, { type: "pdf", id: message.id, error: "No drawing is open" });
    return;
  }
  file.pdf(message.scale).then(
    ({ bytes, warning }) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      tell(origin, { type: "pdf", id: message.id, bytes: buffer, warning }, [buffer]);
    },
    (problem: unknown) => tell(origin, { type: "pdf", id: message.id, error: problem instanceof Error ? problem.message : String(problem) }),
  );
});

say("Loading…");
render();
// The framing page may be at any address (the ERP's own site, or a
// developer's machine): it is told only that this page is ready, and the
// drawing is taken only from the page that made this frame.
tell("*", { type: "ready" });
