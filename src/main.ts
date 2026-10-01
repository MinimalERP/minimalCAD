/**
 * MinimalCAD Web
 * main.ts
 *
 * Entry point: real command architecture (Line, Circle), dynamic input via
 * the CommandBar, a toolbar, and multitab support -- several independent
 * drawings (engine/session.ts's TabSession, each its own Engine+Viewport)
 * can be open at once, switched via the tab strip (ui/tabBar.ts), while
 * sharing one <canvas>/CommandBar/toolbar/cloud-panel as UI chrome. Every
 * piece of shared chrome that used to receive one fixed Engine now receives
 * a `getActiveEngine` callback instead, called fresh on every use, so it
 * always acts on whichever tab is currently active without needing to be
 * rebuilt on every tab switch.
 */

import { OVERLAY_LABEL, cycleOverlayMode, overlayMode } from "./ui/overlayMode";
import "./style.css";
import { CanvasView } from "./ui/canvasView";
import { CommandBar } from "./ui/commandBar";
import { buildToolbar } from "./ui/toolbar";
import { buildTabBar } from "./ui/tabBar";
import type { TabBarHost, TabBar } from "./ui/tabBar";
import { buildMobileNumpad } from "./ui/mobileNumpad";
import { initAutosave } from "./ui/autosaveController";
import { refreshCloudPanel } from "./ui/cloudPanel";
import { createTabSession } from "./engine/session";
import type { TabSession } from "./engine/session";
import type { Engine } from "./engine/engine";
import { WorkspaceController } from "./workspace/workspace";

const canvasElOrNull = document.getElementById("cad-canvas");
if (!(canvasElOrNull instanceof HTMLCanvasElement)) {
  throw new Error("#cad-canvas element not found");
}
// Declared type (not just a narrowed union) so closures defined inside
// later function declarations (newSession() below) don't lose the
// narrowing TS only retains for values used directly at the narrowing
// point itself.
const canvasEl: HTMLCanvasElement = canvasElOrNull;
const toolbarEl = document.getElementById("toolbar");
if (toolbarEl === null) throw new Error("#toolbar element not found");
const tabBarEl = document.getElementById("tab-bar");
if (tabBarEl === null) throw new Error("#tab-bar element not found");
const commandBarEl = document.getElementById("command-bar");
if (commandBarEl === null) throw new Error("#command-bar element not found");
const glCanvasEl = document.getElementById("gl-canvas");
if (!(glCanvasEl instanceof HTMLCanvasElement)) throw new Error("#gl-canvas element not found");
const modelBrowserEl = document.getElementById("model-browser");
if (modelBrowserEl === null) throw new Error("#model-browser element not found");

const commandBar = new CommandBar(commandBarEl);

// CanvasView's requestRedraw is referenced by tab sessions before CanvasView
// exists -- both need each other (a session needs a redraw hook, CanvasView
// needs a session's document to render), so this closure defers the actual
// lookup until first use, by which point `view` below has already been
// assigned. Same deferral pattern as `tabBar` further down.
let view: CanvasView;
function requestRedraw(): void {
  view.requestRedraw();
}
// Fires on every command start/cancel, from wherever it happens (toolbar,
// Escape, a grip command finishing, trim.ts, repeat-last, ...) -- see
// CommandManager's own doc comment on this callback. Without this, a touch
// point-pick candidate frozen at the end of one command (see
// canvasView.ts's aim/confirm doc comment) stayed on screen after that
// command ended and got wrongly confirmed as the first point of whatever
// command ran next.
function onCommandChanged(): void {
  view.discardInFlightTouchPointPick();
}

// --- Tab sessions: one TabSession (engine/session.ts) per open drawing.
// `sessions` + `activeSessionId` are the entire source of truth for which
// tabs exist and which one is active -- ui/tabBar.ts is a pure view over
// them, and every other shared UI piece (toolbar, cloud panel, autosave)
// only ever asks getActiveEngine() rather than holding an Engine of its own. ---

const sessions: TabSession[] = [];
let activeSessionId = "";

function getActiveSession(): TabSession {
  const session = sessions.find((s) => s.id === activeSessionId);
  if (session === undefined) throw new Error("no active tab session");
  return session;
}

/** The Engine input goes to: the part sketch being edited, if any, else
 *  the tab's own drawing -- see workspace/workspace.ts. */
function getActiveEngine(): Engine {
  return workspace.activeEngine(getActiveSession());
}

/** The tab's own document owner (autosave/cloud always save the whole tab,
 *  never just a sketch being edited). */
function getTabEngine(): Engine {
  return getActiveSession().engine;
}

function newSession(): TabSession {
  return createTabSession(
    () => canvasEl.clientWidth,
    () => canvasEl.clientHeight,
    commandBar,
    requestRedraw,
    onCommandChanged,
  );
}

// The very first tab -- created up front since CanvasView's constructor
// (below) needs a concrete Engine/Viewport to render, not just a getter.
const firstSession = newSession();
sessions.push(firstSession);
activeSessionId = firstSession.id;

const workspace = new WorkspaceController({
  canvasEl,
  glCanvasEl,
  browserEl: modelBrowserEl,
  commandBar,
  getView: () => view,
  getSession: getActiveSession,
  requestRedraw,
  onCommandChanged,
  openDrawingTab,
  findSession: (id) => sessions.find((s) => s.id === id),
});

// Tab groups: a model tab and its drawing tab share a colour.
let nextGroup = 0;

/** Switches to `source`'s drawing tab, making one (right after it) if none. */
function openDrawingTab(source: TabSession): void {
  const existing = sessions.find((s) => s.drawingOf === source.id);
  if (existing !== undefined) {
    activateSession(existing.id);
    return;
  }
  source.group ??= nextGroup++;
  const drawing = newSession();
  drawing.workspace = "drawing";
  drawing.drawingOf = source.id;
  drawing.group = source.group;
  drawing.name = `${source.name} - Drawing`;
  sessions.splice(sessions.indexOf(source) + 1, 0, drawing);
  activateSession(drawing.id);
}

commandBar.addEventListener("inputSubmitted", (e) => {
  if (workspace.isModel()) {
    workspace.textInput((e as CustomEvent<string>).detail);
    return;
  }
  getActiveEngine().commandManager.textInput((e as CustomEvent<string>).detail);
  // A typed value always wins over a finger still down mid touch point-pick
  // preview -- see canvasView.ts's own doc comment on this method.
  view.discardInFlightTouchPointPick();
  view.requestRedraw();
});
commandBar.addEventListener("escapePressed", () => {
  if (workspace.isModel()) {
    workspace.escape();
    return;
  }
  getActiveEngine().cancelCommand();
  view.requestRedraw();
});
// Drives a live typing preview (e.g. TextCommand's ghost string) -- the
// command itself just reads commandBar.text() from its own draw().
commandBar.addEventListener("textChanged", () => view.requestRedraw());
// Whenever the command bar stops accepting text (between point-picks mid-
// command, or back at READY), hand keyboard focus back to the canvas so
// Escape/Delete/single-letter typed commands keep working -- see
// commandBar.ts's disableInput() doc comment.
commandBar.addEventListener("inputDisabled", () => (workspace.isModel() ? glCanvasEl : canvasEl).focus());
commandBar.addEventListener("orthoClicked", () => {
  getActiveEngine().toggleOrtho();
});
// CONS (next to ORTHO): how much of the sizes / constraints overlay shows.
const showOverlayMode = (): void => commandBar.setOverlay(OVERLAY_LABEL[overlayMode()], overlayMode() !== "off");
commandBar.addEventListener("overlayClicked", () => {
  cycleOverlayMode();
  showOverlayMode();
  requestRedraw();
});
showOverlayMode();

// Built before CanvasView so the toolbar's real, final layout (which may
// wrap to a second row -- there are enough commands now that it can) is
// already in the DOM before CanvasView's constructor sizes the canvas
// against it. The ResizeObserver in canvasView.ts's constructor is the
// actual belt-and-braces fix for any *later* layout-driven size change;
// this ordering just makes sure the very first sizing is already correct.
workspace.attachToolbar(buildToolbar(toolbarEl, getActiveEngine, () => view.requestRedraw(), workspace));

view = new CanvasView(canvasEl, firstSession.viewport, firstSession.engine);

initAutosave(getTabEngine, () => {
  view.requestRedraw();
  workspace.documentChanged();
});

// --- Tab bar wiring: activate/createNew/close/rename all funnel through
// here so `sessions`/`activeSessionId` stay the single source of truth. ---

let tabBar: TabBar;

function activateSession(id: string): void {
  if (id === activeSessionId) return;
  // Cancels whatever command was running on the OUTGOING tab so it doesn't
  // leave a stale "pick next point" prompt on a tab that's no longer
  // visible -- a no-op if that session was just removed by closeSession()
  // below (already gone from `sessions` by the time this runs).
  const outgoing = sessions.find((s) => s.id === activeSessionId);
  outgoing?.engine.cancelCommand();
  outgoing?.sketch?.engine.cancelCommand();

  activeSessionId = id;
  const session = getActiveSession();
  workspace.apply(session);
  commandBar.setReady();
  commandBar.setOrtho(session.engine.orthoEnabled);
  tabBar.refresh();
  refreshCloudPanel();
}

function createNewTab(): void {
  const session = newSession();
  sessions.push(session);
  activateSession(session.id);
}

/** True if `session`'s content differs from what a Save/cloud-Save would
 *  currently produce -- reuses Undo's own dirty flag (it's already exactly
 *  "has anything changed since the last save-equivalent point"), so closing
 *  a tab with real work in it always confirms first. */
function hasUnsavedChanges(session: TabSession): boolean {
  return session.engine.undo.dirty || (session.sketch?.engine.undo.dirty ?? false);
}

function closeSession(id: string): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const session = sessions[idx]!;

  if (hasUnsavedChanges(session) && !window.confirm(`Close "${session.name}"? Unsaved changes will be lost.`)) {
    return;
  }

  if (sessions.length === 1) {
    // Can't close the very last tab -- reset it to a fresh blank drawing
    // instead, so there's always at least one tab open.
    session.engine.document.clear();
    session.engine.undo.clear();
    session.engine.selection.clear();
    session.engine.clearCloudDrawing();
    session.engine.cancelCommand();
    session.viewport.resetView();
    session.sketch = null;
    session.workspace = "drafting";
    workspace.apply(session);
    view.requestRedraw();
    tabBar.refresh();
    refreshCloudPanel();
    return;
  }

  sessions.splice(idx, 1);
  if (id === activeSessionId) {
    // Activate a neighbor -- the tab immediately before the closed one if
    // there is one, otherwise whatever's now first.
    const next = sessions[Math.max(0, idx - 1)]!;
    activateSession(next.id);
  } else {
    tabBar.refresh();
  }
}

function renameSession(id: string, name: string): void {
  const session = sessions.find((s) => s.id === id);
  if (session === undefined) return;
  session.name = name;
  tabBar.refresh();
}

const tabBarHost: TabBarHost = {
  getSessions: () => sessions,
  getActiveId: () => activeSessionId,
  activate: activateSession,
  createNew: createNewTab,
  close: closeSession,
  rename: renameSession,
};
tabBar = buildTabBar(tabBarEl, tabBarHost);

const homeBtn = document.getElementById("home-btn");
if (homeBtn !== null) {
  // Same focus-steal prevention as toolbar buttons -- see ui/toolbar.ts's
  // preventFocusSteal() doc comment.
  homeBtn.addEventListener("mousedown", (e) => e.preventDefault());
  homeBtn.addEventListener("click", () => {
    if (workspace.isModel()) workspace.modelAction("fit");
    else getActiveEngine().zoomExtents();
  });
}

// Touch-only ESC/Enter/Undo/Redo/Delete/Ortho overlay, plus a numeric keypad
// (shown/hidden purely by CSS/CommandBar events -- nothing here decides
// visibility, see style.css's #mobile-touch-ui rule and mobileNumpad.ts).
// ESC/Enter don't reimplement cancellation/confirmation: dispatching a real
// 'keydown' at whichever element currently holds focus runs through the
// EXACT SAME listeners a physical key press would -- canvasView.ts's own
// onKeyDown when the canvas has focus (mid-command point-picking), or
// commandBar.ts's field handler when its input has focus (typed/dual-value
// entry) -- so there is nothing new to keep in sync with either. Neither
// button ever calls .focus() on anything, so tapping them never pops up the
// on-screen keyboard.
function dispatchSyntheticKey(key: string): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const mobileControls: [string, () => void][] = [
  [
    "mobile-undo",
    () => {
      getActiveEngine().undoAction();
      workspace.documentChanged();
    },
  ],
  [
    "mobile-redo",
    () => {
      getActiveEngine().redoAction();
      workspace.documentChanged();
    },
  ],
  ["mobile-delete", () => getActiveEngine().deleteSelected()],
  ["mobile-ortho", () => getActiveEngine().toggleOrtho()],
  ["mobile-escape", () => dispatchSyntheticKey("Escape")],
  ["mobile-enter", () => dispatchSyntheticKey("Enter")],
];
// Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) in every workspace -- 2D, sketch, 3D,
// drawing sheet. A text box with something typed in it keeps the browser's
// own undo for its text.
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  const redo = key === "y" || (key === "z" && e.shiftKey);
  if (key !== "z" && !redo) return;
  const t = e.target;
  if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value !== "") return;
  e.preventDefault();
  if (redo) getActiveEngine().redoAction();
  else getActiveEngine().undoAction();
  workspace.documentChanged();
  view.requestRedraw();
});

for (const [id, action] of mobileControls) {
  const btn = document.getElementById(id);
  if (btn === null) continue;
  // Same focus-steal prevention as toolbar/home buttons -- critical here
  // specifically so tapping ESC/Enter doesn't itself move focus away from
  // whatever element dispatchSyntheticKey above needs to target.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    action();
    view.requestRedraw();
  });
}

const mobileNumpadEl = document.getElementById("mobile-numpad");
if (mobileNumpadEl !== null) {
  buildMobileNumpad(mobileNumpadEl, commandBar);
}
