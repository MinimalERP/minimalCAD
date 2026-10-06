/**
 * MinimalCAD Web
 * ui/cloudPanelImpl.ts
 *
 * The Cloud panel: a single toggleable panel (appended to <body>, same
 * pattern as ui/toast.ts's lazily-created element). Signed out, it is a
 * sign-in form -- the SAME sign-in as MinimalERP: this app uses MinimalERP's
 * database, and (served from the same origin) a person signed in there is
 * already signed in here. Signed in, it shows:
 *
 *   - the PARTS LIBRARY, which is the company's item master in MinimalERP:
 *     every stock item, searchable by part number or name, and each item's
 *     CAD files. Open a file into this tab (it stays linked: Save writes it
 *     back to the item), Insert one into the current drawing, or save this
 *     drawing onto an item as a new file. Items are made, and files are
 *     deleted, in MinimalERP -- never from here.
 *   - MY DRAWINGS: a person's own cloud drawings, not tied to any item.
 *
 * Entirely additive -- local Save/Open (io/saveLoad.ts) and DXF
 * Export/Import (io/dxf.ts) are untouched.
 *
 * All user-controlled strings (names, email) are set via
 * `textContent`/`value`, never interpolated into innerHTML, so a file named
 * e.g. "<img onerror=...>" can't inject markup into this page.
 *
 * Split out from ui/cloudPanel.ts (the tiny shim toolbar.ts actually
 * imports) so this module -- and the @supabase/supabase-js dependency
 * graph it pulls in -- only ever loads via a dynamic import() behind
 * cloudPanel.ts's own env-var check. Two independent reasons: (1) a user
 * who never touches cloud features shouldn't pay for downloading
 * auth/postgrest/realtime client code at all, and (2) a Vite 5.4.21/Rollup
 * production build was observed to mis-tree-shake toolbar.ts's *unrelated*
 * call sites (refreshCloudPanel()/initCloudUi()) down to nothing --
 * confirmed by bisection to appear only once supabase-js's ~46-module
 * dependency graph was statically reachable from the same chunk -- and
 * disappear once it was isolated behind a dynamic import() chunk boundary
 * instead. Revisit this split if a future Vite/Rollup upgrade is confirmed
 * to no longer need it.
 */

import type { Engine } from "../engine/engine";
import { signIn, signOut, onAuthStateChange } from "../lib/auth";
import type { AuthUser } from "../lib/auth";
import { listDrawings, fetchDrawing, createDrawing, updateDrawing, renameDrawing, deleteDrawing } from "../io/cloudDrawings";
import type { CloudDrawingSummary } from "../io/cloudDrawings";
import { listCompanies, pickCompany, rememberCompany, listItems, listItemFiles, fetchItemFile, saveItemFile, itemLabel } from "../io/cloudParts";
import type { Company, LibraryItem, ItemFileSummary } from "../io/cloudParts";
import { parseEntities, placeBeside } from "../core/document";
import { showToast } from "./toast";
import { drawIcon } from "./toolIcons";

let currentUser: AuthUser | null = null;

let panelEl: HTMLDivElement | null = null;
let cloudButtonEl: HTMLButtonElement | null = null;
let cloudIconCanvas: HTMLCanvasElement | null = null;
// Called fresh at every use (never cached as one fixed Engine) so this panel
// always reads/writes whichever tab (engine/session.ts) is currently active
// -- including "which cloud drawing / item file is this tab's Save tied to",
// which lives on the Engine itself (see engine/engine.ts's cloudDrawingId
// and itemFile) rather than as module state here.
let getActiveEngineRef: (() => Engine) | null = null;
let requestRedrawRef: (() => void) | null = null;

// Same cyan as #command-bar .prompt-label in style.css (the "READY"/status
// text color) -- reused here, not redefined independently, so the Cloud
// icon's signed-in indicator always matches it even if that color changes.
const SIGNED_IN_COLOR = "#00ffff";

/** `#/item-file/<id>` in the address: MinimalERP's "Open in MinimalCAD"
 *  link. Taken once at startup and opened as soon as someone is signed in. */
let pendingItemFileId: string | null = (() => {
  const m = /^#\/item-file\/([0-9a-fA-F-]{36})$/.exec(window.location.hash);
  return m ? (m[1] as string) : null;
})();

/** Redraws the panel in place if it's currently open -- called by
 *  cloudPanel.ts's shim after the active tab changes (new/close/switch), so
 *  an already-open panel picks up the newly-active tab's cloud identity and
 *  "active" highlight instead of showing the outgoing tab's. */
export function refreshCloudPanelIfOpen(): void {
  if (panelEl !== null && !panelEl.hidden) refreshAndRender();
}

/** The active tab is linked to a file of a stock item (opened from it, or
 *  saved onto it): the toolbar's Save then writes it back there. */
export function activeTabIsLinkedToItem(): boolean {
  return getActiveEngineRef?.().itemFile != null;
}

/** Saves the active tab back to the item file it is linked to. */
export function saveActiveTabToItem(): void {
  const engine = getActiveEngineRef?.();
  if (engine === undefined || engine.itemFile === null) return;
  saveLinked(engine);
}

/** Adds a "Cloud" button to the toolbar and builds the (initially hidden)
 *  panel. Called by cloudPanel.ts's shim only after it has already
 *  confirmed Supabase is configured -- see this module's own header
 *  comment for why that check lives there instead of here. */
export function mountCloudUi(toolbarRoot: HTMLElement, getActiveEngine: () => Engine, requestRedraw: () => void): void {
  getActiveEngineRef = getActiveEngine;
  requestRedrawRef = requestRedraw;

  const gapEl = document.createElement("div");
  gapEl.className = "toolbar-gap";
  toolbarRoot.appendChild(gapEl);

  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.title = "Cloud";
  btn.setAttribute("aria-label", "Cloud");
  const canvas = document.createElement("canvas");
  drawIcon("cloud", canvas);
  btn.appendChild(canvas);
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    if (panelEl === null) return;
    panelEl.hidden = !panelEl.hidden;
    if (!panelEl.hidden) refreshAndRender();
  });
  toolbarRoot.appendChild(btn);
  cloudButtonEl = btn;
  cloudIconCanvas = canvas;

  panelEl = document.createElement("div");
  panelEl.id = "cloud-panel";
  panelEl.hidden = true;
  document.body.appendChild(panelEl);

  // Auto-close on any tap/click outside the panel (and outside the toggle
  // button itself, which already has its own open/close toggle above) --
  // on a narrow/tablet layout the toolbar can wrap enough rows that this
  // fixed-position panel (see style.css) visually covers the Cloud button
  // that opened it, leaving no way to close it otherwise. pointerdown
  // (not click) matches the immediate close-on-touch-down feel of a normal
  // dropdown/popover, and fires alongside -- never instead of -- whatever
  // canvasView.ts's own pointer handling does with that same touch, since
  // this listener never calls preventDefault()/stopPropagation().
  document.addEventListener("pointerdown", (e) => {
    if (panelEl === null || panelEl.hidden) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (panelEl.contains(target) || cloudButtonEl?.contains(target) === true) return;
    panelEl.hidden = true;
  });

  onAuthStateChange((user) => {
    const changed = (user?.id ?? null) !== (currentUser?.id ?? null);
    currentUser = user;
    if (cloudIconCanvas !== null) {
      drawIcon("cloud", cloudIconCanvas, user !== null ? SIGNED_IN_COLOR : undefined);
    }
    if (changed) {
      // another person (or nobody): nothing of the last one's company is kept
      companies = [];
      company = null;
      cachedItems = [];
      cachedFiles = [];
      cachedDrawings = [];
    }
    // a link from MinimalERP: show the sign-in form if nobody is signed in, else open the file
    if (pendingItemFileId !== null && panelEl !== null && user === null) panelEl.hidden = false;
    if (pendingItemFileId !== null && user !== null) openPendingItemFile();
    if (panelEl !== null && !panelEl.hidden) refreshAndRender();
  });
}

let cachedDrawings: CloudDrawingSummary[] = [];
let companies: Company[] = [];
let company: Company | null = null;
let cachedItems: LibraryItem[] = [];
let cachedFiles: ItemFileSummary[] = [];
// Live-filter query for the library list -- kept across a refreshAndRender()
// (e.g. after a save) so the search box doesn't silently reset itself out
// from under whatever the user was in the middle of typing.
let itemsQuery = "";

/** At most this many items are drawn at once (an item master runs to
 *  thousands): the search narrows it. */
const ITEMS_SHOWN = 40;

function refreshAndRender(): void {
  const user = currentUser;
  if (user === null) {
    render();
    return;
  }
  void Promise.all([listDrawings(), listCompanies()]).then(async ([drawingsResult, companiesResult]) => {
    if (drawingsResult.ok) cachedDrawings = drawingsResult.value;
    else showToast(`Could not load drawings: ${drawingsResult.error}`);

    if (companiesResult.ok) {
      companies = companiesResult.value;
      company = pickCompany(companies, user.id);
    } else showToast(`Could not load your companies: ${companiesResult.error}`);

    if (company !== null) await loadLibrary(company);
    render();
  });
}

async function loadLibrary(of: Company): Promise<void> {
  const [itemsResult, filesResult] = await Promise.all([listItems(of.id), listItemFiles(of.id)]);
  if (itemsResult.ok) cachedItems = itemsResult.value;
  else showToast(`Could not load the items: ${itemsResult.error}`);
  if (filesResult.ok) cachedFiles = filesResult.value;
  else showToast(`Could not load the items' files: ${filesResult.error}`);
}

function render(): void {
  if (panelEl === null) return;
  panelEl.replaceChildren();

  const header = document.createElement("div");
  header.className = "cloud-panel-header";
  header.textContent = "MinimalERP Cloud";
  panelEl.appendChild(header);

  if (currentUser === null) {
    panelEl.appendChild(buildAuthForm());
    return;
  }

  // Fetched fresh on every render() (never cached) so this always reflects
  // whichever tab is currently active -- see this module's own header
  // comment on getActiveEngineRef.
  const engine = getActiveEngineRef!();

  panelEl.appendChild(buildAccountBar(engine, currentUser));

  const libraryHeader = document.createElement("div");
  libraryHeader.className = "cloud-panel-header";
  libraryHeader.textContent = "Parts Library — item master";
  panelEl.appendChild(libraryHeader);

  panelEl.appendChild(buildCompanyBar());
  if (company !== null) {
    panelEl.appendChild(buildLinkedBar(engine));
    panelEl.appendChild(buildItemsSearchBar(engine));

    // Held in its own persistent container (rather than rebuilt as part of a
    // full render()) so typing in the search box above only ever replaces
    // THIS element's children on each keystroke -- see buildItemsSearchBar's
    // input handler -- instead of tearing down and rebuilding the search
    // input itself, which would drop keyboard focus (and the caret) after
    // every single character typed.
    itemsListEl = document.createElement("div");
    itemsListEl.className = "cloud-panel-section cloud-panel-list";
    panelEl.appendChild(itemsListEl);
    renderItemsListInto(engine, itemsListEl);
  }

  const drawingsHeader = document.createElement("div");
  drawingsHeader.className = "cloud-panel-header";
  drawingsHeader.textContent = "My Drawings";
  panelEl.appendChild(drawingsHeader);

  panelEl.appendChild(buildSaveBar(engine));
  panelEl.appendChild(buildDrawingsList(engine));
}

function buildAuthForm(): HTMLElement {
  const form = document.createElement("div");
  form.className = "cloud-panel-section";

  const note = document.createElement("div");
  note.className = "cloud-panel-status";
  note.textContent =
    pendingItemFileId !== null
      ? "Sign in with your MinimalERP email and password to open that item's drawing."
      : "Sign in with your MinimalERP email and password: the parts library is your company's item master.";

  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.placeholder = "Email";
  emailInput.autocomplete = "email";

  const passwordInput = document.createElement("input");
  passwordInput.type = "password";
  passwordInput.placeholder = "Password";
  passwordInput.autocomplete = "current-password";

  const statusEl = document.createElement("div");
  statusEl.className = "cloud-panel-status";

  const buttonRow = document.createElement("div");
  buttonRow.className = "cloud-panel-row";

  // Sign in only: accounts are made in MinimalERP (by invitation), not here.
  const signInBtn = document.createElement("button");
  signInBtn.textContent = "Sign In";
  signInBtn.addEventListener("mousedown", (e) => e.preventDefault());
  const submit = () => {
    void signIn(emailInput.value, passwordInput.value).then((result) => {
      statusEl.textContent = result.ok ? "" : result.error;
    });
  };
  signInBtn.addEventListener("click", submit);
  passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  buttonRow.append(signInBtn);
  form.append(note, emailInput, passwordInput, buttonRow, statusEl);
  return form;
}

function buildAccountBar(engine: Engine, user: AuthUser): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cloud-panel-section cloud-panel-row";

  const emailEl = document.createElement("span");
  emailEl.className = "cloud-panel-email";
  emailEl.textContent = user.email ?? "Signed in";

  const signOutBtn = document.createElement("button");
  signOutBtn.textContent = "Sign Out";
  signOutBtn.addEventListener("mousedown", (e) => e.preventDefault());
  signOutBtn.addEventListener("click", () => {
    void signOut().then(() => {
      engine.clearCloudDrawing();
      cachedDrawings = [];
    });
  });

  bar.append(emailEl, signOutBtn);
  return bar;
}

function buildSaveBar(engine: Engine): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cloud-panel-section cloud-panel-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = engine.cloudDrawingName;
  nameInput.placeholder = "Drawing name";

  const saveBtn = document.createElement("button");
  saveBtn.textContent = engine.cloudDrawingId === null ? "Save to Cloud" : "Save";
  saveBtn.addEventListener("mousedown", (e) => e.preventDefault());
  saveBtn.addEventListener("click", () => {
    const snapshot = engine.document.toDict();
    const name = nameInput.value.trim() || "Untitled";

    const afterSave = () => {
      engine.cloudDrawingName = name;
      showToast(`Saved "${name}" to the cloud.`);
      refreshAndRender();
    };

    if (engine.cloudDrawingId === null) {
      void createDrawing(name, snapshot).then((result) => {
        if (!result.ok) {
          showToast(`Could not save: ${result.error}`);
          return;
        }
        engine.cloudDrawingId = result.value.id;
        afterSave();
      });
    } else {
      const id = engine.cloudDrawingId;
      void updateDrawing(id, snapshot).then((result) => {
        if (!result.ok) {
          showToast(`Could not save: ${result.error}`);
          return;
        }
        // The name field may have been edited since this drawing was opened
        // -- treat a changed name here as a rename, not a silent no-op.
        if (name !== engine.cloudDrawingName) {
          void renameDrawing(id, name).then(() => afterSave());
        } else {
          afterSave();
        }
      });
    }
  });

  const saveAsNewBtn = document.createElement("button");
  saveAsNewBtn.textContent = "Save As New";
  saveAsNewBtn.title = "Create a new cloud drawing instead of overwriting the current one";
  saveAsNewBtn.addEventListener("mousedown", (e) => e.preventDefault());
  saveAsNewBtn.addEventListener("click", () => {
    const snapshot = engine.document.toDict();
    const name = nameInput.value.trim() || "Untitled";
    void createDrawing(name, snapshot).then((result) => {
      if (!result.ok) {
        showToast(`Could not save: ${result.error}`);
        return;
      }
      engine.cloudDrawingId = result.value.id;
      engine.cloudDrawingName = name;
      showToast(`Saved "${name}" as a new cloud drawing.`);
      refreshAndRender();
    });
  });

  bar.append(nameInput, saveBtn, saveAsNewBtn);
  return bar;
}

function buildDrawingsList(engine: Engine): HTMLElement {
  const list = document.createElement("div");
  list.className = "cloud-panel-section cloud-panel-list";

  if (cachedDrawings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cloud-panel-status";
    empty.textContent = "No cloud drawings yet.";
    list.appendChild(empty);
    return list;
  }

  for (const drawing of cachedDrawings) {
    list.appendChild(buildDrawingRow(engine, drawing));
  }
  return list;
}

function buildDrawingRow(engine: Engine, drawing: CloudDrawingSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = "cloud-panel-row cloud-panel-drawing-row";
  if (drawing.id === engine.cloudDrawingId) row.classList.add("active");

  const nameEl = document.createElement("span");
  nameEl.className = "cloud-panel-drawing-name";
  nameEl.textContent = drawing.name;
  nameEl.title = new Date(drawing.updatedAt).toLocaleString();

  const openBtn = document.createElement("button");
  openBtn.textContent = "Open";
  openBtn.title = "Replaces this tab's drawing with the selected cloud drawing";
  openBtn.addEventListener("mousedown", (e) => e.preventDefault());
  openBtn.addEventListener("click", () => {
    if (requestRedrawRef === null) return;
    void fetchDrawing(drawing.id).then((result) => {
      if (!result.ok) {
        showToast(`Could not open drawing: ${result.error}`);
        return;
      }
      const parseResult = engine.document.restoreFromDict(result.value.snapshot);
      engine.undo.clear();
      engine.zoomExtents();
      engine.cloudDrawingId = result.value.id;
      engine.cloudDrawingName = result.value.name;
      requestRedrawRef!();
      render();
      if (parseResult.skippedCount > 0) {
        showToast(`${parseResult.skippedCount} unsupported entity type(s) were skipped.`);
      }
    });
  });

  const renameBtn = document.createElement("button");
  renameBtn.textContent = "Rename";
  renameBtn.addEventListener("mousedown", (e) => e.preventDefault());
  renameBtn.addEventListener("click", () => {
    const nextName = window.prompt("Rename drawing", drawing.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (trimmed === "" || trimmed === drawing.name) return;
    void renameDrawing(drawing.id, trimmed).then((result) => {
      if (!result.ok) {
        showToast(`Could not rename: ${result.error}`);
        return;
      }
      if (drawing.id === engine.cloudDrawingId) engine.cloudDrawingName = trimmed;
      refreshAndRender();
    });
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("mousedown", (e) => e.preventDefault());
  deleteBtn.addEventListener("click", () => {
    if (!window.confirm(`Delete "${drawing.name}"? This cannot be undone.`)) return;
    void deleteDrawing(drawing.id).then((result) => {
      if (!result.ok) {
        showToast(`Could not delete: ${result.error}`);
        return;
      }
      if (drawing.id === engine.cloudDrawingId) engine.clearCloudDrawing();
      refreshAndRender();
    });
  });

  row.append(nameEl, openBtn, renameBtn, deleteBtn);
  return row;
}

// --- Parts Library = MinimalERP's item master ---
//
// The desktop app's commands/save_library.py/insert_library.py keep each
// part as a standalone .jcad file in a folder. Here the library is the
// company's stock items, and a part is a CAD file ON an item (see
// io/cloudParts.ts): MinimalERP's item form shows the very same files.

/** Which company's items the library shows: its name, or a chooser when the
 *  sign-in belongs to several. */
function buildCompanyBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cloud-panel-section cloud-panel-row";

  if (company === null) {
    const none = document.createElement("div");
    none.className = "cloud-panel-status";
    none.textContent = "This sign-in has no company in MinimalERP yet.";
    bar.appendChild(none);
    return bar;
  }
  if (companies.length === 1) {
    const nameEl = document.createElement("span");
    nameEl.className = "cloud-panel-email";
    nameEl.textContent = company.name;
    bar.appendChild(nameEl);
    return bar;
  }

  const select = document.createElement("select");
  select.className = "cloud-panel-company";
  select.title = "Company";
  for (const c of companies) {
    const option = document.createElement("option");
    option.value = c.id;
    option.textContent = c.name;
    option.selected = c.id === company.id;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    const chosen = companies.find((c) => c.id === select.value);
    if (chosen === undefined) return;
    company = chosen;
    rememberCompany(chosen.id);
    cachedItems = [];
    cachedFiles = [];
    void loadLibrary(chosen).then(render);
  });
  bar.appendChild(select);
  return bar;
}

/** What this tab is tied to: the item file it was opened from or saved
 *  onto, with the Save that writes it back. */
function buildLinkedBar(engine: Engine): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cloud-panel-section cloud-panel-row";

  const link = engine.itemFile;
  const text = document.createElement("span");
  text.className = "cloud-panel-drawing-name";
  if (link === null) {
    text.classList.add("cloud-panel-status");
    text.textContent = "This tab is not an item's file. Open one below, or Save here onto an item.";
    bar.appendChild(text);
    return bar;
  }
  text.textContent = `This tab: ${link.itemLabel} / ${link.name}`;

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.title = "Saves this tab over that file: MinimalERP's item has it at once";
  saveBtn.addEventListener("mousedown", (e) => e.preventDefault());
  saveBtn.addEventListener("click", () => saveLinked(engine));

  bar.append(text, saveBtn);
  return bar;
}

/** Saves the tab over the item file it is linked to. */
function saveLinked(engine: Engine): void {
  const link = engine.itemFile;
  if (link === null) return;
  void saveItemFile({ companyId: link.companyId, itemId: link.itemId, id: link.id, name: link.name, snapshot: engine.document.toDict() }).then((result) => {
    if (!result.ok) {
      showToast(`Could not save: ${result.error}`);
      return;
    }
    engine.undo.markClean();
    showToast(`Saved to ${link.itemLabel} / ${link.name}.`);
    if (panelEl !== null && !panelEl.hidden) refreshAndRender();
  });
}

/** The persistent container renderItemsListInto() redraws in place -- see
 *  render()'s own comment on why this can't just be a fresh element each time. */
let itemsListEl: HTMLDivElement | null = null;

function buildItemsSearchBar(engine: Engine): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cloud-panel-section";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "cloud-panel-search";
  searchInput.placeholder = "Search items by part number or name...";
  searchInput.value = itemsQuery;
  searchInput.addEventListener("input", () => {
    itemsQuery = searchInput.value;
    if (itemsListEl !== null) renderItemsListInto(engine, itemsListEl);
  });

  bar.appendChild(searchInput);
  return bar;
}

/** The items the search leaves, those with files first (they are what one
 *  usually comes for), then by name. */
function itemsToShow(): LibraryItem[] {
  const query = itemsQuery.trim().toLowerCase();
  const withFiles = new Set(cachedFiles.map((f) => f.itemId));
  const matches = query === "" ? cachedItems : cachedItems.filter((i) => (i.code ?? "").toLowerCase().includes(query) || i.name.toLowerCase().includes(query));
  return [...matches].sort((a, b) => Number(withFiles.has(b.id)) - Number(withFiles.has(a.id)) || a.name.localeCompare(b.name));
}

function renderItemsListInto(engine: Engine, container: HTMLDivElement): void {
  container.replaceChildren();
  const items = itemsToShow();

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cloud-panel-status";
    empty.textContent =
      cachedItems.length === 0 ? "No stock items yet: create them in MinimalERP." : `No item matches "${itemsQuery.trim()}".`;
    container.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, ITEMS_SHOWN)) container.appendChild(buildItemBlock(engine, item));

  if (items.length > ITEMS_SHOWN) {
    const more = document.createElement("div");
    more.className = "cloud-panel-status";
    more.textContent = `+${items.length - ITEMS_SHOWN} more items — type to narrow.`;
    container.appendChild(more);
  }
}

/** One item: its name, "Save here", and a row for each of its files. */
function buildItemBlock(engine: Engine, item: LibraryItem): HTMLElement {
  const block = document.createElement("div");
  block.className = "cloud-panel-item";

  const head = document.createElement("div");
  head.className = "cloud-panel-row cloud-panel-drawing-row";

  const nameEl = document.createElement("span");
  nameEl.className = "cloud-panel-drawing-name cloud-panel-item-name";
  nameEl.textContent = itemLabel(item);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save here";
  saveBtn.title = "Saves this drawing (or the selection, if something is selected) onto this item as a new file";
  saveBtn.addEventListener("mousedown", (e) => e.preventDefault());
  saveBtn.addEventListener("click", () => saveOntoItem(engine, item));

  head.append(nameEl, saveBtn);
  block.appendChild(head);

  for (const file of cachedFiles.filter((f) => f.itemId === item.id)) block.appendChild(buildFileRow(engine, item, file));
  return block;
}

function buildFileRow(engine: Engine, item: LibraryItem, file: ItemFileSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = "cloud-panel-row cloud-panel-drawing-row cloud-panel-file-row";
  if (engine.itemFile?.id === file.id) row.classList.add("active");

  const nameEl = document.createElement("span");
  nameEl.className = "cloud-panel-drawing-name";
  nameEl.textContent = file.name;
  nameEl.title = `Saved ${new Date(file.updatedAt).toLocaleString()}`;

  const openBtn = document.createElement("button");
  openBtn.textContent = "Open";
  openBtn.title = "Replaces this tab's drawing with this file; Save then writes back to it";
  openBtn.addEventListener("mousedown", (e) => e.preventDefault());
  openBtn.addEventListener("click", () => openItemFile(engine, file.id, itemLabel(item)));

  const insertBtn = document.createElement("button");
  insertBtn.textContent = "Insert";
  insertBtn.title = "Merges this file into the current canvas beside the existing drawing";
  insertBtn.addEventListener("mousedown", (e) => e.preventDefault());
  insertBtn.addEventListener("click", () => insertItemFile(engine, file.id));

  row.append(nameEl, openBtn, insertBtn);
  return row;
}

/** Loads a file of an item into the tab and ties the tab to it. */
function openItemFile(engine: Engine, fileId: string, label: string | undefined): void {
  void fetchItemFile(fileId).then((result) => {
    if (!result.ok) {
      showToast(`Could not open the file: ${result.error}`);
      return;
    }
    const file = result.value;
    const parseResult = engine.document.restoreFromDict(file.snapshot);
    engine.undo.clear();
    engine.zoomExtents();
    engine.clearCloudDrawing();
    const item = cachedItems.find((i) => i.id === file.itemId);
    engine.itemFile = {
      id: file.id,
      companyId: file.companyId,
      itemId: file.itemId,
      itemLabel: label ?? (item !== undefined ? itemLabel(item) : "Item"),
      name: file.name,
    };
    requestRedrawRef?.();
    if (panelEl !== null && !panelEl.hidden) render();
    showToast(`Opened ${engine.itemFile.itemLabel} / ${file.name}. Save writes it back to the item.`);
    if (parseResult.skippedCount > 0) showToast(`${parseResult.skippedCount} unsupported entity type(s) were skipped.`);
  });
}

/** The file MinimalERP's "Open in MinimalCAD" link names, once someone is
 *  signed in. The address is cleaned so a reload does not open it again
 *  over whatever has been drawn since. */
function openPendingItemFile(): void {
  const id = pendingItemFileId;
  const engine = getActiveEngineRef?.();
  if (id === null || engine === undefined) return;
  pendingItemFileId = null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  void fetchItemFile(id).then(async (result) => {
    if (!result.ok) {
      showToast(`Could not open the file: ${result.error}`);
      return;
    }
    // its item's name, for the tab's "This tab: ..." line (the library may not be loaded yet)
    const items = await listItems(result.value.companyId);
    const item = items.ok ? items.value.find((i) => i.id === result.value.itemId) : undefined;
    rememberCompany(result.value.companyId);
    openItemFile(engine, id, item !== undefined ? itemLabel(item) : undefined);
  });
}

function insertItemFile(engine: Engine, fileId: string): void {
  void fetchItemFile(fileId).then((result) => {
    if (!result.ok) {
      showToast(`Could not insert the file: ${result.error}`);
      return;
    }
    const { entities: incoming, skippedCount } = parseEntities(result.value.snapshot.entities);
    if (incoming.length === 0) return;

    // Same placement logic as Insert Drawing (ui/toolbar.ts) -- offset
    // clear of the existing content so a repeated Insert click (the
    // desktop app's "comma to insert & continue" flow) drops each copy
    // beside the last instead of stacking them on top of each other.
    if (engine.document.getEntities().length > 0) {
      placeBeside(engine.document.getBounds(), incoming);
    }

    engine.undo.push(engine.document.toDict());
    for (const entity of incoming) engine.document.addEntity(entity);
    engine.selection.clear();
    engine.zoomExtents();
    requestRedrawRef?.();
    if (skippedCount > 0) {
      showToast(`${skippedCount} unsupported entity type(s) were skipped.`);
    }
  });
}

/**
 * "Save here" on an item: a new file on it. The whole drawing is saved and
 * the tab becomes that file (so the next Save writes back to it) -- unless
 * something is selected, when only the selection is saved (the desktop
 * app's Save to Library rule) and the tab stays what it was.
 */
function saveOntoItem(engine: Engine, item: LibraryItem): void {
  const of = company;
  if (of === null) return;

  const selected = engine.selection.getEntities();
  const selectionOnly = selected.length > 0;
  if (!selectionOnly && engine.document.getEntities().length === 0) {
    showToast("Nothing to save -- the drawing is empty.");
    return;
  }

  const taken = new Set(cachedFiles.filter((f) => f.itemId === item.id).map((f) => f.name));
  const suggested = taken.has("Part") ? "Drawing" : "Part";
  const typed = window.prompt(`File name on ${itemLabel(item)}${selectionOnly ? ` (${selected.length} selected)` : ""}`, suggested);
  if (typed === null) return;
  const name = typed.trim();
  if (name === "") return;
  if (taken.has(name)) {
    showToast(`${itemLabel(item)} already has a file named "${name}". Open it and Save to write over it.`);
    return;
  }

  const snapshot = selectionOnly ? { entities: selected.map((e) => e.serialize()), constraints: [] } : engine.document.toDict();
  void saveItemFile({ companyId: of.id, itemId: item.id, name, snapshot }).then((result) => {
    if (!result.ok) {
      showToast(`Could not save: ${result.error}`);
      return;
    }
    if (!selectionOnly) {
      engine.clearCloudDrawing();
      engine.itemFile = { id: result.value.id, companyId: of.id, itemId: item.id, itemLabel: itemLabel(item), name: result.value.name };
      engine.undo.markClean();
    }
    showToast(`Saved "${name}" on ${itemLabel(item)}.`);
    refreshAndRender();
  });
}
