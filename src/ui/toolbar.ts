/**
 * MinimalCAD Web
 * ui/toolbar.ts
 *
 * Icon-only toolbar (ui/toolIcons.ts's procedural glyphs, ported from the
 * desktop app's ui/tool_icons.py), grouped Draw / Modify / Dimension in the
 * same order as the desktop's ui/toolbar.py, followed by non-command
 * utility actions (Undo/Redo/Zoom/Save/Open/DXF). A button's accessible
 * name and hover tooltip carry the text label + shortcut that used to be
 * the button's own visible text.
 *
 * Workspace-aware: every workspace's button set (2D drafting, 3D model,
 * part sketch) is built ONCE, each in its own display:contents group, and
 * setWorkspace() just shows the right groups -- so switching is instant and
 * the drafting set is exactly the original toolbar.
 */

import { COMMAND_REGISTRY } from "../commands/registry";
import type { Engine } from "../engine/engine";
import {
  saveDocumentToFile,
  pickAndReadDocumentFile,
  exportDxfToFile,
  pickAndReadDxfFile,
  promptFilename,
} from "../io/saveLoad";
import { parseEntities, placeBeside } from "../core/document";
import { showToast } from "./toast";
import { initCloudUi } from "./cloudPanel";
import { drawIcon } from "./toolIcons";
import type { Workspace } from "../engine/session";

const DISPLAY_NAMES: Record<string, string> = {
  line: "Line",
  circle: "Circle",
  arc: "Arc",
  ellipse: "Ellipse",
  rectangle: "Rectangle",
  move: "Move",
  copy: "Copy",
  rotate: "Rotate",
  polararray: "Polar Array",
  scale: "Scale",
  mirror: "Mirror",
  trim: "Trim",
  offset: "Offset",
  fillet: "Fillet",
  chamfer: "Chamfer",
  join: "Join",
  explode: "Explode",
  text: "Text",
  linear: "Linear Dim",
  aligned: "Aligned Dim",
  angular: "Angular Dim",
  diameter: "Diameter Dim",
  radius: "Radius Dim",
  leader: "Leader",
  insertlib: "Insert from Library",
  savelib: "Save to Library",
  constrain: "Constrain Distance",
  pdfexport: "Export PDF",
};

// Matches the desktop app's ui/toolbar.py section order (Draw / Modify /
// Dimension / File & Library) -- restricted to commands this web port
// actually has; entries the desktop has but this port doesn't yet (table,
// linetype) are simply absent until their features land, not stubbed.
const COMMAND_GROUPS: readonly (readonly string[])[] = [
  ["line", "arc", "rectangle", "circle", "ellipse", "text"],
  [
    "move",
    "copy",
    "rotate",
    "polararray",
    "trim",
    "offset",
    "mirror",
    "fillet",
    "chamfer",
    "join",
    "explode",
    "scale",
    "constrain",
  ],
  ["linear", "aligned", "angular", "diameter", "radius", "leader"],
  ["pdfexport", "insertlib", "savelib"],
];

/** 2D commands offered while editing a 3D part sketch -- geometry that makes
 *  profiles, plus the modify tools and dimensions. Text/library/PDF are
 *  drafting-only. */
const SKETCH_GROUPS: readonly (readonly string[])[] = [
  ["line", "arc", "rectangle", "circle", "ellipse"],
  ["trim", "offset", "mirror", "fillet", "chamfer", "move", "copy", "rotate", "join", "explode"],
  ["linear", "aligned", "angular", "diameter", "radius"],
];

/** 3D-workspace actions (handled by the lazily-loaded model module). */
export type ModelAction = "newsketch" | "workplane" | "extrude" | "hole" | "viewfront" | "viewtop" | "viewright" | "viewiso" | "fit";

/** What the toolbar needs from the workspace controller -- kept as a narrow
 *  interface so this module never imports any 3D code. */
export interface ToolbarWorkspaceHost {
  switchTo(workspace: "drafting" | "model"): void;
  finishSketch(): void;
  /** Leave 2D editing of a drawing that belongs to a 3D model. */
  finish2d(): void;
  modelAction(action: ModelAction): void;
  /** Document content was replaced/undone outside a command (Open, Undo...). */
  documentChanged(): void;
}

export interface ToolbarHandle {
  /** `modelLinked`: the 2D drawing feeds a 3D model, so offer Finish 2D. */
  setWorkspace(workspace: Workspace, sketchLabel?: string, modelLinked?: boolean): void;
}

function displayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name[0]!.toUpperCase() + name.slice(1);
}

/**
 * `getActiveEngine` is called fresh inside every handler below (never
 * captured as one fixed Engine) so every button always acts on whichever
 * tab (engine/session.ts) -- or part sketch being edited -- is currently
 * active, with no toolbar rebuild needed on a switch.
 */
export function buildToolbar(
  root: HTMLElement,
  getActiveEngine: () => Engine,
  requestRedraw: () => void,
  host: ToolbarWorkspaceHost,
): ToolbarHandle {
  root.innerHTML = "";

  // Workspace switcher (2D | 3D), or the sketch banner while editing one.
  const switcher = group(root, "ws-switcher");
  const btn2d = textButton(switcher, "2D", "2D drafting workspace", () => host.switchTo("drafting"));
  const btn3d = textButton(switcher, "3D", "3D view of the same model (orbit, extrude...)", () => host.switchTo("model"));
  const finish2dBtn = textButton(switcher, "✓ Finish 2D", "Finish editing the 2D drawing and return to 3D", () =>
    host.finish2d(),
  );
  finish2dBtn.classList.add("finish-sketch");
  switcher.appendChild(gap());

  const sketchBanner = group(root, "ws-sketch-banner");
  const finishBtn = textButton(sketchBanner, "✓ Finish Sketch", "Finish Sketch and return to 3D", () =>
    host.finishSketch(),
  );
  finishBtn.classList.add("finish-sketch");
  const sketchLabelEl = document.createElement("span");
  sketchLabelEl.className = "ws-sketch-label";
  sketchBanner.appendChild(sketchLabelEl);
  sketchBanner.appendChild(gap());

  const afterUndoRedo = (): void => {
    host.documentChanged();
    requestRedraw();
  };

  // --- 2D drafting: exactly the original toolbar ---
  const drafting = group(root, "ws-group");
  addCommandGroups(drafting, COMMAND_GROUPS, getActiveEngine, requestRedraw);
  addUtilityButton(drafting, "undo", "Undo", () => getActiveEngine().undoAction());
  addUtilityButton(drafting, "redo", "Redo", () => getActiveEngine().redoAction());
  drafting.appendChild(gap());
  addUtilityButton(drafting, "zoomextents", "Zoom Extents", () => getActiveEngine().zoomExtents());
  drafting.appendChild(gap());
  addFileButtons(drafting, getActiveEngine, host);
  addInsertDrawingButton(drafting, getActiveEngine);
  drafting.appendChild(gap());
  addDxfButtons(drafting, getActiveEngine, requestRedraw, host);

  // --- 3D model ---
  const model = group(root, "ws-group");
  addUtilityButton(model, "newsketch", "New Sketch - pick a plane (XY = the 2D drawing)", () =>
    host.modelAction("newsketch"),
  );
  addUtilityButton(model, "workplane", "Work Plane - offset / rotate a plane, like a saved UCS (WP)", () =>
    host.modelAction("workplane"),
  );
  addUtilityButton(model, "extrude", "Extrude", () => host.modelAction("extrude"));
  addUtilityButton(model, "hole", "Hole (H) - click a face, place centres, set Ø / depth / c'bore / c'sink", () =>
    host.modelAction("hole"),
  );
  model.appendChild(gap());
  addUtilityButton(model, "viewfront", "Front view", () => host.modelAction("viewfront"));
  addUtilityButton(model, "viewtop", "Top view", () => host.modelAction("viewtop"));
  addUtilityButton(model, "viewright", "Right view", () => host.modelAction("viewright"));
  addUtilityButton(model, "viewiso", "Isometric view", () => host.modelAction("viewiso"));
  addUtilityButton(model, "zoomextents", "Zoom to fit", () => host.modelAction("fit"));
  model.appendChild(gap());
  addUtilityButton(model, "undo", "Undo", () => {
    getActiveEngine().undoAction();
    afterUndoRedo();
  });
  addUtilityButton(model, "redo", "Redo", () => {
    getActiveEngine().redoAction();
    afterUndoRedo();
  });
  model.appendChild(gap());
  addFileButtons(model, getActiveEngine, host);

  // --- Part sketch (2D tools on a sketch plane) ---
  const sketch = group(root, "ws-group");
  addCommandGroups(sketch, SKETCH_GROUPS, getActiveEngine, requestRedraw);
  addUtilityButton(sketch, "undo", "Undo", () => getActiveEngine().undoAction());
  addUtilityButton(sketch, "redo", "Redo", () => getActiveEngine().redoAction());
  addUtilityButton(sketch, "zoomextents", "Zoom Extents", () => getActiveEngine().zoomExtents());

  // Cloud UI mounts once into its own group (mounting it twice isn't safe).
  const cloud = group(root, "ws-group");
  initCloudUi(cloud, getActiveEngine, requestRedraw);

  const visible: Record<Workspace, HTMLElement[]> = {
    drafting: [switcher, drafting, cloud],
    model: [switcher, model, cloud],
    sketch: [sketchBanner, sketch],
  };
  const all = [switcher, sketchBanner, drafting, model, sketch, cloud];

  function setWorkspace(workspace: Workspace, sketchLabel = "", modelLinked = false): void {
    for (const el of all) el.hidden = !visible[workspace].includes(el);
    finish2dBtn.hidden = !(workspace === "drafting" && modelLinked);
    btn2d.classList.toggle("active", workspace === "drafting");
    btn3d.classList.toggle("active", workspace === "model");
    sketchLabelEl.textContent = sketchLabel;
  }
  setWorkspace("drafting");
  return { setWorkspace };
}

function addCommandGroups(
  root: HTMLElement,
  groups: readonly (readonly string[])[],
  getActiveEngine: () => Engine,
  requestRedraw: () => void,
): void {
  for (const names of groups) {
    for (const name of names) {
      const entry = COMMAND_REGISTRY[name];
      if (entry === undefined || entry.aliases.length === 0) continue;
      const label = displayName(name);
      const btn = createIconButton(name, `${label} (${entry.aliases[0]!.toUpperCase()})`);
      btn.addEventListener("click", () => {
        getActiveEngine().commandManager.startCommand(name);
        requestRedraw();
      });
      root.appendChild(btn);
    }
    root.appendChild(gap());
  }
}

function addFileButtons(root: HTMLElement, getActiveEngine: () => Engine, host: ToolbarWorkspaceHost): void {
  addUtilityButton(root, "save", "Save", () => {
    const filename = promptFilename("Save Drawing", "jcad");
    if (filename === null) return;
    saveDocumentToFile(getActiveEngine().document, filename);
  });
  addUtilityButton(root, "open", "Open", () => {
    void pickAndReadDocumentFile().then((result) => {
      if (result === null) return;
      if (!result.ok) {
        showToast(`Could not open file: ${result.error}`);
        return;
      }
      const engine = getActiveEngine();
      const parseResult = engine.document.restoreFromDict(result.snapshot);
      engine.undo.clear();
      engine.zoomExtents();
      engine.clearCloudDrawing();
      host.documentChanged();
      if (parseResult.skippedCount > 0) {
        showToast(`${parseResult.skippedCount} unsupported entity type(s) were skipped.`);
      }
    });
  });
}

function addInsertDrawingButton(root: HTMLElement, getActiveEngine: () => Engine): void {
  addUtilityButton(root, "insertdrawing", "Insert Drawing (merge a .jcad file into this canvas)", () => {
    void pickAndReadDocumentFile().then((result) => {
      if (result === null) return;
      if (!result.ok) {
        showToast(`Could not import drawing: ${result.error}`);
        return;
      }
      const { entities: incoming, skippedCount } = parseEntities(result.snapshot.entities);
      if (incoming.length === 0) return;

      const engine = getActiveEngine();

      // Unlike Open/Import DXF (which replace the document), this merges
      // into whatever's already on screen -- offset clear of the existing
      // content's bounds so it doesn't land on top of it, matching the
      // desktop app's own Ctrl+A overlay-import (document.py's
      // placeBeside()). Deliberately does NOT call engine.clearCloudDrawing():
      // the current drawing's identity hasn't changed, it just has more in it.
      if (engine.document.getEntities().length > 0) {
        placeBeside(engine.document.getBounds(), incoming);
      }

      engine.undo.push(engine.document.toDict());
      for (const entity of incoming) engine.document.addEntity(entity);
      engine.selection.clear();
      engine.zoomExtents();
      if (skippedCount > 0) {
        showToast(`${skippedCount} unsupported entity type(s) were skipped.`);
      }
    });
  });
}

function addDxfButtons(
  root: HTMLElement,
  getActiveEngine: () => Engine,
  requestRedraw: () => void,
  host: ToolbarWorkspaceHost,
): void {
  addUtilityButton(root, "exportdxf", "Export DXF", () => {
    const filename = promptFilename("Export DXF", "dxf");
    if (filename === null) return;
    exportDxfToFile(getActiveEngine().document, filename);
  });
  addUtilityButton(root, "importdxf", "Import DXF", () => {
    void pickAndReadDxfFile().then((result) => {
      if (result === null) {
        showToast("Could not open file: not a valid DXF file");
        return;
      }
      const engine = getActiveEngine();
      // Matches Open's full-replace semantics (and the desktop app's own
      // import_dxf(), which repopulates document.entities in place) rather
      // than merging into whatever's currently on screen.
      engine.document.clear();
      for (const entity of result.entities) engine.document.addEntity(entity);
      engine.undo.clear();
      engine.zoomExtents();
      engine.clearCloudDrawing();
      host.documentChanged();
      requestRedraw();
      if (result.warnings.length > 0) {
        showToast(result.warnings.join(" — "), 8000);
      }
    });
  });
}

/** Builds an icon-only <button> (ui/toolIcons.ts glyph inside, no visible
 *  text) -- `title` doubles as both the hover tooltip and (via aria-label)
 *  the accessible name, matching the desktop toolbar's own icon-only
 *  buttons-with-tooltip convention. */
function createIconButton(iconName: string, title: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  const canvas = document.createElement("canvas");
  drawIcon(iconName, canvas);
  btn.appendChild(canvas);
  preventFocusSteal(btn);
  return btn;
}

function addUtilityButton(root: HTMLElement, iconName: string, title: string, onClick: () => void): void {
  const btn = createIconButton(iconName, title);
  btn.addEventListener("click", onClick);
  root.appendChild(btn);
}

/**
 * A <button> reclaims keyboard focus once its click handler finishes
 * (the browser's own "focus the activated control" step runs AFTER click
 * dispatch, overriding anything a handler focused first) -- silently
 * stealing focus back from the command bar's input field that
 * command.start() just focused, so subsequent typing goes nowhere. Calling
 * preventDefault() on the button's own mousedown (not click) suppresses
 * that default focus-grab while leaving the click event itself untouched.
 * Same failure mode ui/canvasView.ts already has to reassert past for
 * canvas clicks -- this is the toolbar's equivalent fix.
 */
function preventFocusSteal(btn: HTMLButtonElement): void {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
}

/** A display:contents wrapper, so its buttons flow in the toolbar exactly as
 *  if they were direct children, while the whole set can be hidden at once. */
function group(root: HTMLElement, className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  root.appendChild(el);
  return el;
}

function textButton(root: HTMLElement, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "ws-btn";
  btn.textContent = text;
  btn.title = title;
  preventFocusSteal(btn);
  btn.addEventListener("click", onClick);
  root.appendChild(btn);
  return btn;
}

function gap(): HTMLElement {
  const el = document.createElement("div");
  el.className = "toolbar-gap";
  return el;
}
