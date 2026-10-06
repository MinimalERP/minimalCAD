/**
 * MinimalCAD Web
 * io/cloudParts.ts
 *
 * The Parts Library IS MinimalERP's item master. A "part" here is one CAD
 * file of a stock item: the company's items are made in MinimalERP, each
 * can hold any number of .jcad files (free names -- "Part", "Drawing",
 * "Flat pattern 3mm"...), and this module lists the items, lists and
 * fetches their files, and saves a file back onto its item.
 *
 * The desktop app's library (commands/save_library.py / insert_library.py)
 * was a folder of .jcad files; the first web version was a per-user `parts`
 * table. Now it is `item_cad_files` in the shared MinimalERP database
 * (its migration 20261026000100_cad.sql): the ERP's item form shows the
 * very same rows, so a file saved here is the item's file there.
 *
 *   - Reads go straight to the tables; Row Level Security shows a company's
 *     items and files to its people only.
 *   - Saves go through the "cad" Edge Function (io/cloudApi.ts), which
 *     requires the right to change masters in that company.
 *   - Nothing is deleted from here: a file is removed in MinimalERP.
 *
 * Same Result-shaped, never-throws design as io/cloudDrawings.ts.
 */

import { getSupabaseClient } from "../lib/supabaseClient";
import { callCad, selectAll } from "./cloudApi";
import type { CloudResult } from "./cloudApi";
import { validateDocumentSnapshot } from "./fileFormat";
import type { DocumentSnapshot } from "../core/document";

export type { CloudResult };

export interface Company {
  id: string;
  name: string;
}

/** A stock item of the company, as the library shows it. */
export interface LibraryItem {
  id: string;
  /** The part number, when the item has one. */
  code: string | null;
  name: string;
}

/** One CAD file of a stock item (without its drawing). */
export interface ItemFileSummary {
  id: string;
  itemId: string;
  name: string;
  updatedAt: string;
}

export interface ItemFile extends ItemFileSummary {
  companyId: string;
  snapshot: DocumentSnapshot;
}

/** What the Insert / Save to Library commands list and name: a file of an
 *  item, called "<part no.> / <file name>" (see partLabel below). */
export interface CloudPartSummary {
  id: string;
  name: string;
}

export interface CloudPart extends CloudPartSummary {
  snapshot: DocumentSnapshot;
}

// ---- which company -------------------------------------------------------

const COMPANY_KEY = "minimalcad-company";

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private window / blocked storage: fall back to the first company
  }
}

/** The companies the signed-in person belongs to (Row Level Security shows
 *  no others). */
export async function listCompanies(): Promise<CloudResult<Company[]>> {
  const { data, error } = await getSupabaseClient().from("companies").select("id, name").order("name");
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: (data ?? []) as Company[] };
}

/**
 * Which of `companies` the library shows: the one chosen here before, else
 * the one last opened in MinimalERP on this browser (both apps are served
 * from the same origin, so its `minimalerp-company-<user id>` note is
 * readable here), else the first. Null only when there are none.
 */
export function pickCompany(companies: readonly Company[], userId: string): Company | null {
  const wanted = [stored(COMPANY_KEY), stored(`minimalerp-company-${userId}`)];
  for (const id of wanted) {
    const found = companies.find((c) => c.id === id);
    if (found !== undefined) return found;
  }
  return companies[0] ?? null;
}

export function rememberCompany(companyId: string): void {
  try {
    window.localStorage.setItem(COMPANY_KEY, companyId);
  } catch {
    // not remembered: the default is picked again next time
  }
}

// ---- items and their files ----------------------------------------------

/** "101027520 — L Bracket", or just the name for an item without a part number. */
export function itemLabel(item: Pick<LibraryItem, "code" | "name">): string {
  return item.code !== null && item.code !== "" ? `${item.code} — ${item.name}` : item.name;
}

/** How a file is named in the Insert / Save to Library commands:
 *  "<part no. or item name> / <file name>". */
export function partLabel(item: Pick<LibraryItem, "code" | "name">, fileName: string): string {
  return `${item.code !== null && item.code !== "" ? item.code : item.name} / ${fileName}`;
}

/** Every active stock item of the company, by name. */
export async function listItems(companyId: string): Promise<CloudResult<LibraryItem[]>> {
  return selectAll<LibraryItem>((from, to) =>
    getSupabaseClient()
      .from("stock_items")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
      .order("id")
      .range(from, to),
  );
}

interface FileRow {
  id: string;
  item_id: string;
  name: string;
  updated_at: string;
}

/** Every CAD file of the company's items (names only, no drawings). */
export async function listItemFiles(companyId: string): Promise<CloudResult<ItemFileSummary[]>> {
  const result = await selectAll<FileRow>((from, to) =>
    getSupabaseClient()
      .from("item_cad_files")
      .select("id, item_id, name, updated_at")
      .eq("company_id", companyId)
      .order("name")
      .order("id")
      .range(from, to),
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.map((r) => ({ id: r.id, itemId: r.item_id, name: r.name, updatedAt: r.updated_at })) };
}

/** One file with its drawing -- validated the same way a local .jcad file's
 *  contents are, since a jsonb column could in principle hold anything. */
export async function fetchItemFile(id: string): Promise<CloudResult<ItemFile>> {
  const { data, error } = await getSupabaseClient()
    .from("item_cad_files")
    .select("id, company_id, item_id, name, document, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (data === null) return { ok: false, error: "That file is not on the item any more (or you are not signed in to its company)" };
  const row = data as FileRow & { company_id: string; document: unknown };

  const parsed = validateDocumentSnapshot(row.document);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    value: { id: row.id, companyId: row.company_id, itemId: row.item_id, name: row.name, updatedAt: row.updated_at, snapshot: parsed.snapshot },
  };
}

/**
 * Saves a drawing onto a stock item. With `id`, that file is saved over
 * (nothing of the old one is kept); without, a new file called `name` is
 * added to the item -- refused when the item already has one so named.
 */
export async function saveItemFile(args: {
  companyId: string;
  itemId: string;
  id?: string | undefined;
  name: string;
  snapshot: DocumentSnapshot;
}): Promise<CloudResult<ItemFileSummary>> {
  const result = await callCad<FileRow>("item-file-save", {
    companyId: args.companyId,
    itemId: args.itemId,
    ...(args.id !== undefined ? { id: args.id } : {}),
    name: args.name,
    document: args.snapshot,
  });
  if (!result.ok) return result;
  const r = result.value;
  return { ok: true, value: { id: r.id, itemId: r.item_id, name: r.name, updatedAt: r.updated_at } };
}

// ---- the library as the command line sees it ------------------------------
//
// commands/insertLib.ts and commands/saveLib.ts work with a flat list of
// names, as the desktop app's library folder did. Here each name is a file
// of an item: "<part no.> / <file name>".

/** The company the commands act on, and its items -- loaded once per call. */
async function libraryOf(): Promise<CloudResult<{ company: Company; items: LibraryItem[] }>> {
  const { data } = await getSupabaseClient().auth.getUser();
  if (!data.user) return { ok: false, error: "Sign in first (Cloud button) to use the company's parts library" };
  const companies = await listCompanies();
  if (!companies.ok) return companies;
  const company = pickCompany(companies.value, data.user.id);
  if (company === null) return { ok: false, error: "This sign-in has no company in MinimalERP" };
  const items = await listItems(company.id);
  if (!items.ok) return items;
  return { ok: true, value: { company, items: items.value } };
}

/** Every CAD file of the company's items, named "<part no.> / <file name>". */
export async function listParts(): Promise<CloudResult<CloudPartSummary[]>> {
  const library = await libraryOf();
  if (!library.ok) return library;
  const files = await listItemFiles(library.value.company.id);
  if (!files.ok) return files;
  const byId = new Map(library.value.items.map((i) => [i.id, i]));
  const parts = files.value.flatMap((f) => {
    const item = byId.get(f.itemId);
    return item === undefined ? [] : [{ id: f.id, name: partLabel(item, f.name) }]; // a file of an inactive item is not offered
  });
  return { ok: true, value: parts.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function fetchPart(id: string): Promise<CloudResult<CloudPart>> {
  const file = await fetchItemFile(id);
  if (!file.ok) return file;
  return { ok: true, value: { id: file.value.id, name: file.value.name, snapshot: file.value.snapshot } };
}

/**
 * Save to Library from the command line: `name` is "<part no.> / <file
 * name>" (or just the part number, for a file called "Part"). The item must
 * exist -- items are made in MinimalERP, never from here.
 */
export async function createPart(name: string, snapshot: DocumentSnapshot): Promise<CloudResult<CloudPartSummary>> {
  const slash = name.indexOf("/");
  const itemText = (slash === -1 ? name : name.slice(0, slash)).trim();
  const fileName = (slash === -1 ? "" : name.slice(slash + 1)).trim() || "Part";
  if (itemText === "") return { ok: false, error: "Type the item's part number, then / and a file name" };

  const library = await libraryOf();
  if (!library.ok) return library;
  const wanted = itemText.toLowerCase();
  const item =
    library.value.items.find((i) => (i.code ?? "").toLowerCase() === wanted) ?? library.value.items.find((i) => i.name.toLowerCase() === wanted);
  if (item === undefined) {
    return { ok: false, error: `No item "${itemText}" in ${library.value.company.name} - create it in MinimalERP first` };
  }

  const saved = await saveItemFile({ companyId: library.value.company.id, itemId: item.id, name: fileName, snapshot });
  if (!saved.ok) return saved;
  return { ok: true, value: { id: saved.value.id, name: partLabel(item, saved.value.name) } };
}
