/**
 * MinimalCAD Web
 * ui/toolbar.ts
 *
 * Icon-only toolbar (ui/toolIcons.ts's procedural glyphs, ported from the
 * desktop app's ui/tool_icons.py), grouped Draw / Modify / constraints /
 * dimensions in the same order as the desktop app. File actions live in the
 * File menu at the command bar's lower-right corner. A button's accessible
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
  horizontal: "Horizontal - keep a line level",
  vertical: "Vertical - keep a line upright",
  parallel: "Parallel - keep a line parallel to another",
  perpendicular: "Perpendicular - keep a line square to another",
  equal: "Equal - keep two lines the same length, or two circles the same size",
  coincident: "Coincident - keep a point on another point",
  pdfexport: "Export PDF",
};

// Matches the desktop app's ui/toolbar.py section order (Draw / Modify /
// constraints / Dimension) -- restricted to commands this web port
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
  ],
  ["constrain", "horizontal", "vertical", "parallel", "perpendicular", "equal", "coincident"],
  ["linear", "aligned", "angular", "diameter", "radius", "leader"],
];

/** 2D commands offered while editing a 3D part sketch -- geometry that makes
 *  profiles, plus the modify tools and dimensions. Text/library/PDF are
 *  drafting-only. */
const SKETCH_GROUPS: readonly (readonly string[])[] = [
  ["line", "arc", "rectangle", "circle", "ellipse"],
  ["trim", "offset", "mirror", "fillet", "chamfer", "move", "copy", "rotate", "join", "explode"],
  ["constrain", "horizontal", "vertical", "parallel", "perpendicular", "equal", "coincident"],
  ["linear", "aligned", "angular", "diameter", "radius"],
];

/** 3D-workspace actions (handled by the lazily-loaded model module). */
export type ModelAction = "newsketch" | "workplane" | "extrude" | "revolve" | "hole" | "pattern" | "circpattern" | "mirror3d" | "fillet" | "chamfer" | "rotate3d" | "line3d" | "sheetmetal" | "measure" | "measureangle" | "measuredist" | "measureedge" | "measureface" | "viewfront" | "viewtop" | "viewright" | "viewiso" | "fit";

/** Drawing-tab actions (handled by the lazily-loaded drawing module). */
export type DrawingToolAction = "sheet" | "baseview" | "projview" | "sectionview" | "moveview" | "editview" | "deleteview" | "print" | "fit";

/** Annotation tools offered on a drawing sheet. */
const DRAWING_GROUPS: readonly (readonly string[])[] = [
  ["linear", "aligned", "angular", "diameter", "radius", "leader", "text"],
  ["line", "circle", "move", "copy", "trim"],
];

/** What the toolbar needs from the workspace controller -- kept as a narrow
 *  interface so this module never imports any 3D code. */
export interface ToolbarWorkspaceHost {
  switchTo(workspace: "drafting" | "model"): void;
  prepareModel(): void;
  finishSketch(): void;
  /** Leave 2D editing of a drawing that belongs to a 3D model. */
  finish2d(): void;
  modelAction(action: ModelAction): void;
  /** Document content was replaced/undone outside a command (Open, Undo...). */
  documentChanged(): void;
  /** Open (or switch to) this model's drawing tab. */
  openDrawing(): void;
  drawingAction(action: DrawingToolAction): void;
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
  commandBarRoot: HTMLElement,
  getActiveEngine: () => Engine,
  requestRedraw: () => void,
  host: ToolbarWorkspaceHost,
): ToolbarHandle {
  root.innerHTML = "";

  // Workspace switcher (2D | 3D), or the sketch banner while editing one.
  const switcher = group(root, "ws-switcher");
  const btn2d = textButton(switcher, "2D", "2D drafting workspace", () => host.switchTo("drafting"));
  const btn3d = textButton(switcher, "3D", "3D view of the same model (orbit, extrude...)", () => host.switchTo("model"));
  // Download and evaluate the lazy 3D bundle on hover/focus so the first
  // click doesn't have to wait for the network and module initialization.
  btn3d.addEventListener("pointerenter", () => host.prepareModel(), { once: true });
  btn3d.addEventListener("focus", () => host.prepareModel(), { once: true });
  const finish2dBtn = textButton(switcher, "✓ Finish 2D", "Finish editing the 2D drawing and return to 3D", () =>
    host.finish2d(),
  );
  finish2dBtn.classList.add("finish-sketch");
  const drawingBtn = textButton(switcher, "Drawing", "2D drawing of this model (views, dimensions, title block) in its own tab", () =>
    host.openDrawing(),
  );
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

  // --- 3D model ---
  const model = group(root, "ws-group");
  addUtilityButton(model, "newsketch", "New Sketch - pick a plane or a flat face (each one is a new sketch)", () =>
    host.modelAction("newsketch"),
  );
  addUtilityButton(model, "workplane", "Work Plane - offset / rotate a plane, like a saved UCS (WP)", () =>
    host.modelAction("workplane"),
  );
  addUtilityButton(model, "line3d", "3D Line (L) - click points in 3D, snapping to the solid; close a flat loop to extrude it off its own plane", () =>
    host.modelAction("line3d"),
  );
  addUtilityButton(model, "extrude", "Extrude (E) - push a closed shape out into a solid, or cut with it", () => host.modelAction("extrude"));
  addUtilityButton(model, "sheetmetal", "Sheet Metal (SM) - fold a flat blank along its bend lines: material, thickness, Up / Down, angle", () =>
    host.modelAction("sheetmetal"),
  );
  addUtilityButton(model, "revolve", "Revolve (R) - spin a closed shape round an axis line", () => host.modelAction("revolve"));
  addUtilityButton(model, "hole", "Hole (H) - click a face, place centres, set Ø / depth / c'bore / c'sink", () =>
    host.modelAction("hole"),
  );
  addUtilityButton(model, "fillet3d", "Fillet (F) - round off edges: click edges, or a face for all its edges", () =>
    host.modelAction("fillet"),
  );
  addUtilityButton(model, "chamfer3d", "Chamfer (CH) - bevel edges: click edges, or a face for all its edges", () =>
    host.modelAction("chamfer"),
  );
  addUtilityButton(model, "pattern", "Rectangular Pattern (PAT) - repeat features in rows and columns", () => host.modelAction("pattern"));
  addUtilityButton(model, "circpattern", "Circular Pattern (CPAT) - repeat features round an axis", () => host.modelAction("circpattern"));
  addUtilityButton(model, "mirror3d", "Mirror (MIR) - copy features across a plane", () => host.modelAction("mirror3d"));
  addUtilityButton(model, "rotate3d", "Rotate Body (RO) - turn solids about X / Y / Z, an edge, or a round face's axis", () =>
    host.modelAction("rotate3d"),
  );
  addMeasureButton(model, host);
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

  // --- Part sketch (2D tools on a sketch plane) ---
  const sketch = group(root, "ws-group");
  addCommandGroups(sketch, SKETCH_GROUPS, getActiveEngine, requestRedraw);
  addUtilityButton(sketch, "undo", "Undo", () => getActiveEngine().undoAction());
  addUtilityButton(sketch, "redo", "Redo", () => getActiveEngine().redoAction());
  addUtilityButton(sketch, "zoomextents", "Zoom Extents", () => getActiveEngine().zoomExtents());

  // --- Drawing tab (sheet, views, annotations) ---
  const drawingBanner = group(root, "ws-sketch-banner");
  const drawingLabelEl = document.createElement("span");
  drawingLabelEl.className = "ws-sketch-label";
  drawingBanner.appendChild(drawingLabelEl);
  drawingBanner.appendChild(gap());
  const drawing = group(root, "ws-group");
  addUtilityButton(drawing, "sheet", "Sheet - paper size, 1st / 3rd angle, title block", () => host.drawingAction("sheet"));
  addUtilityButton(drawing, "baseview", "Base View - pick front / top / side / iso and a scale, click to place", () =>
    host.drawingAction("baseview"),
  );
  addUtilityButton(drawing, "projview", "Projected View - click a view, then place views around it", () =>
    host.drawingAction("projview"),
  );
  addUtilityButton(drawing, "sectionview", "Section View - click a view where to cut, then place the section beside it", () =>
    host.drawingAction("sectionview"),
  );
  addUtilityButton(drawing, "moveview", "Move View (projected views stay in line)", () => host.drawingAction("moveview"));
  addUtilityButton(drawing, "editview", "Edit View - scale, hidden lines, label", () => host.drawingAction("editview"));
  addUtilityButton(drawing, "deleteview", "Delete View (and the views projected from it)", () => host.drawingAction("deleteview"));
  drawing.appendChild(gap());
  addCommandGroups(drawing, DRAWING_GROUPS, getActiveEngine, requestRedraw);
  addUtilityButton(drawing, "undo", "Undo", () => getActiveEngine().undoAction());
  addUtilityButton(drawing, "redo", "Redo", () => getActiveEngine().redoAction());
  addUtilityButton(drawing, "zoomextents", "Zoom to the sheet", () => host.drawingAction("fit"));
  drawing.appendChild(gap());

  // Cloud UI mounts once into its own group (mounting it twice isn't safe).
  const cloud = group(root, "ws-group");
  initCloudUi(cloud, getActiveEngine, requestRedraw);

  const visible: Record<Workspace, HTMLElement[]> = {
    drafting: [switcher, drafting, cloud],
    model: [switcher, model, cloud],
    sketch: [sketchBanner, sketch],
    drawing: [drawingBanner, drawing],
  };
  const all = [switcher, sketchBanner, drafting, model, sketch, drawingBanner, drawing, cloud];

  const fileMenu = buildFileMenu(commandBarRoot, getActiveEngine, requestRedraw, host);

  function setWorkspace(workspace: Workspace, sketchLabel = "", modelLinked = false): void {
    for (const el of all) el.hidden = !visible[workspace].includes(el);
    finish2dBtn.hidden = !(workspace === "drafting" && modelLinked);
    drawingBtn.hidden = !(workspace === "model" || modelLinked);
    drawingLabelEl.textContent = workspace === "drawing" ? sketchLabel : "";
    btn2d.classList.toggle("active", workspace === "drafting");
    btn3d.classList.toggle("active", workspace === "model");
    sketchLabelEl.textContent = workspace === "sketch" ? sketchLabel : "";
    fileMenu.setWorkspace(workspace);
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

function buildFileMenu(
  commandBarRoot: HTMLElement,
  getActiveEngine: () => Engine,
  requestRedraw: () => void,
  host: ToolbarWorkspaceHost,
): { setWorkspace(workspace: Workspace): void } {
  const wrapper = document.createElement("div");
  wrapper.className = "file-menu-wrap";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "file-menu-trigger";
  trigger.textContent = "File ▾";
  trigger.title = "File options";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  preventFocusSteal(trigger);
  wrapper.appendChild(trigger);

  const menu = document.createElement("div");
  menu.className = "file-menu-popover";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.appendChild(menu);

  const close = (): void => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const position = (): void => {
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 6)}px`;
  };
  trigger.addEventListener("click", () => {
    if (!menu.hidden) {
      close();
      return;
    }
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    position();
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Node && !menu.contains(target) && !wrapper.contains(target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      close();
      trigger.focus();
    }
  });
  window.addEventListener("resize", () => {
    if (!menu.hidden) position();
  });

  const addItem = (label: string, workspaces: Workspace[], onClick: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-menu-item";
    button.textContent = label;
    button.setAttribute("role", "menuitem");
    button.dataset.workspaces = workspaces.join(" ");
    preventFocusSteal(button);
    button.addEventListener("click", () => {
      close();
      onClick();
    });
    menu.appendChild(button);
  };

  const canSaveOpen: Workspace[] = ["drafting", "model", "drawing"];
  addItem("Save", canSaveOpen, () => {
    const filename = promptFilename("Save Drawing", "jcad");
    if (filename !== null) saveDocumentToFile(getActiveEngine().document, filename);
  });
  addItem("Open", canSaveOpen, () => {
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
      if (parseResult.skippedCount > 0) showToast(`${parseResult.skippedCount} unsupported entity type(s) were skipped.`);
    });
  });

  const draftingOnly: Workspace[] = ["drafting"];
  addItem("Insert Drawing", draftingOnly, () => {
    void pickAndReadDocumentFile().then((result) => {
      if (result === null) return;
      if (!result.ok) {
        showToast(`Could not import drawing: ${result.error}`);
        return;
      }
      const { entities: incoming, skippedCount } = parseEntities(result.snapshot.entities);
      if (incoming.length === 0) return;
      const engine = getActiveEngine();
      if (engine.document.getEntities().length > 0) placeBeside(engine.document.getBounds(), incoming);
      engine.undo.push(engine.document.toDict());
      for (const entity of incoming) engine.document.addEntity(entity);
      engine.selection.clear();
      engine.zoomExtents();
      if (skippedCount > 0) showToast(`${skippedCount} unsupported entity type(s) were skipped.`);
    });
  });
  addItem("Import DXF", draftingOnly, () => {
    void pickAndReadDxfFile().then((result) => {
      if (result === null) {
        showToast("Could not open file: not a valid DXF file");
        return;
      }
      const engine = getActiveEngine();
      engine.document.clear();
      for (const entity of result.entities) engine.document.addEntity(entity);
      engine.undo.clear();
      engine.zoomExtents();
      engine.clearCloudDrawing();
      host.documentChanged();
      requestRedraw();
      if (result.warnings.length > 0) showToast(result.warnings.join(" — "), 8000);
    });
  });
  addItem("Export DXF", draftingOnly, () => {
    const filename = promptFilename("Export DXF", "dxf");
    if (filename !== null) void exportDxfToFile(getActiveEngine().document, filename);
  });
  addItem("Export PDF", draftingOnly, () => getActiveEngine().commandManager.startCommand("pdfexport"));
  addItem("Insert from Library", draftingOnly, () => getActiveEngine().commandManager.startCommand("insertlib"));
  addItem("Save to Library", draftingOnly, () => getActiveEngine().commandManager.startCommand("savelib"));
  addItem("Print Drawing to PDF", ["drawing"], () => host.drawingAction("print"));

  commandBarRoot.appendChild(wrapper); // placed after ORTHO at the bottom-right
  return {
    setWorkspace: (workspace) => {
      for (const button of menu.querySelectorAll<HTMLButtonElement>(".file-menu-item")) {
        button.hidden = !button.dataset.workspaces?.split(" ").includes(workspace);
      }
      const available = [...menu.querySelectorAll<HTMLButtonElement>(".file-menu-item")].some((button) => !button.hidden);
      wrapper.hidden = !available;
      close();
    },
  };
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

/** Measure: the button runs the last-used kind; ▾ lists them all. */
function addMeasureButton(root: HTMLElement, host: ToolbarWorkspaceHost): void {
  addUtilityButton(root, "measure3d", "Measure - angle between faces, distance, edge length / radius, face area (MEA)", () => host.modelAction("measure"));
  const more = document.createElement("button");
  more.type = "button";
  more.className = "measure-more";
  more.textContent = "▾";
  more.title = "Choose what to measure";
  preventFocusSteal(more);
  root.appendChild(more);
  const menu = document.createElement("div");
  menu.className = "file-menu-popover";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.appendChild(menu);
  const items: [string, ModelAction][] = [
    ["Angle between faces / edges", "measureangle"],
    ["Distance between points", "measuredist"],
    ["Edge length / radius", "measureedge"],
    ["Face area", "measureface"],
  ];
  for (const [label, action] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "file-menu-item";
    b.textContent = label;
    b.setAttribute("role", "menuitem");
    preventFocusSteal(b);
    b.addEventListener("click", () => {
      menu.hidden = true;
      host.modelAction(action);
    });
    menu.appendChild(b);
  }
  more.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    if (menu.hidden) return;
    const r = more.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left - 120, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.bottom + 4}px`;
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Node && !menu.contains(e.target) && e.target !== more) menu.hidden = true;
  });
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
