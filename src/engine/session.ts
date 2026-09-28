/**
 * MinimalCAD Web
 * engine/session.ts
 *
 * One "tab" = one independent TabSession: its own Engine (document, undo
 * history, selection, running command) plus its own Viewport (so each tab
 * remembers its own pan/zoom independently). Everything else -- the single
 * <canvas>, CommandBar, toolbar, cloud panel -- is shared UI chrome owned by
 * main.ts, repointed at whichever session is currently active rather than
 * duplicated per tab (see ui/canvasView.ts's setActiveSession()).
 *
 * Deliberately NOT a class with its own behavior: a session is just the
 * bundle of state a tab needs, identical in shape every time -- main.ts
 * (which already owns the array of sessions and "which one is active")
 * is where switching/closing/renaming logic actually lives.
 */

import { generateId } from "../core/id";
import { Viewport } from "./viewport";
import { Engine } from "./engine";
import type { CommandBar } from "../ui/commandBar";
import type { PlaneRef } from "../part/types";

/** Which toolset a tab is showing -- see workspace/workspace.ts. The
 *  existing 2D app is simply the "drafting" workspace. */
export type Workspace = "drafting" | "model" | "sketch";

/** A 3D part sketch open for editing: its own Engine+Viewport, so every 2D
 *  command/osnap/grip works on it unchanged. Written back into
 *  Document.part on Finish Sketch. */
export interface SketchEdit {
  readonly sketchId: string;
  readonly plane: PlaneRef;
  readonly engine: Engine;
  readonly viewport: Viewport;
}

export interface TabSession {
  readonly id: string;
  name: string;
  readonly viewport: Viewport;
  readonly engine: Engine;
  workspace: Workspace;
  sketch: SketchEdit | null;
}

// Numbers new tabs "Untitled 1", "Untitled 2", ... for the lifetime of the
// page -- deliberately never reused/decremented on close, same reasoning as
// io/saveLoad.ts's timestamped default filenames: a stable, ever-increasing
// counter is simpler than tracking which small integers are "free".
let untitledCounter = 0;

/** Builds one new tab, ready to become active immediately -- its Viewport is
 *  already homed (resetView()) using whatever canvas size is available yet
 *  (Viewport.resetView() itself falls back to a sane default height if the
 *  canvas hasn't been laid out for the first time -- see its own comment). */
export function createTabSession(
  getCanvasWidth: () => number,
  getCanvasHeight: () => number,
  commandBar: CommandBar,
  requestRedraw: () => void,
  onCommandChanged: () => void,
): TabSession {
  untitledCounter++;
  const { viewport, engine } = createEngine(getCanvasWidth, getCanvasHeight, commandBar, requestRedraw, onCommandChanged);
  return { id: generateId(), name: `Untitled ${untitledCounter}`, viewport, engine, workspace: "drafting", sketch: null };
}

/** One homed Viewport + the Engine that owns it -- a tab's main drawing, or
 *  a part sketch being edited (workspace/workspace.ts). */
export function createEngine(
  getCanvasWidth: () => number,
  getCanvasHeight: () => number,
  commandBar: CommandBar,
  requestRedraw: () => void,
  onCommandChanged: () => void,
): { viewport: Viewport; engine: Engine } {
  const viewport = new Viewport(getCanvasWidth, getCanvasHeight);
  viewport.resetView();
  const engine = new Engine(viewport, commandBar, requestRedraw, onCommandChanged);
  return { viewport, engine };
}
