import { describe, expect, it, vi, beforeEach } from "vitest";

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

/** A chainable-and-thenable Postgrest stand-in: every builder method returns
 *  the builder, and awaiting it resolves to the configured {data, error}. */
function makeChain(result: FakeResult) {
  const builder = {
    select: () => builder,
    order: () => builder,
    eq: () => builder,
    range: () => builder,
    maybeSingle: () => builder,
    then<A = FakeResult, B = never>(ok?: ((v: FakeResult) => A | PromiseLike<A>) | null, bad?: ((r: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      return Promise.resolve(result).then(ok, bad);
    },
  };
  return builder;
}

/** What each table answers; a test sets the rows it needs. */
const tables: Record<string, FakeResult> = {};
const mockInvoke = vi.fn();
const mockGetUser = vi.fn();

vi.mock("../lib/supabaseClient", () => ({
  getSupabaseClient: () => ({
    from: (table: string) => makeChain(tables[table] ?? { data: [], error: null }),
    functions: { invoke: mockInvoke },
    auth: { getUser: mockGetUser },
  }),
}));

const { listParts, fetchPart, createPart, listItems, listItemFiles, fetchItemFile, saveItemFile, pickCompany, itemLabel, partLabel } = await import("./cloudParts");

const ACME = { id: "co-1", name: "Micro Components" };
const BRACKET = { id: "item-1", code: "101027520", name: "L Bracket" };
const WASHER = { id: "item-2", code: null, name: "Washer" };

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  mockInvoke.mockReset();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  tables["companies"] = { data: [ACME], error: null };
  tables["stock_items"] = { data: [BRACKET, WASHER], error: null };
  tables["item_cad_files"] = {
    data: [
      { id: "f-1", item_id: "item-1", name: "Part", updated_at: "2026-10-06T00:00:00Z" },
      { id: "f-2", item_id: "item-1", name: "Drawing", updated_at: "2026-10-06T00:00:00Z" },
      { id: "f-3", item_id: "item-2", name: "Part", updated_at: "2026-10-06T00:00:00Z" },
      { id: "f-9", item_id: "item-gone", name: "Part", updated_at: "2026-10-06T00:00:00Z" }, // its item is inactive: not listed
    ],
    error: null,
  };
});

describe("labels", () => {
  it("an item is its part number and name; a part is the part number (or the name) and the file", () => {
    expect(itemLabel(BRACKET)).toBe("101027520 — L Bracket");
    expect(itemLabel(WASHER)).toBe("Washer");
    expect(partLabel(BRACKET, "Drawing")).toBe("101027520 / Drawing");
    expect(partLabel(WASHER, "Part")).toBe("Washer / Part");
  });
});

describe("pickCompany", () => {
  it("takes the first when nothing is remembered, and none when there are none", () => {
    expect(pickCompany([ACME, { id: "co-2", name: "Vinay Enterprises" }], "user-1")).toEqual(ACME);
    expect(pickCompany([], "user-1")).toBeNull();
  });
});

describe("the item master as the library", () => {
  it("lists the company's items and their files", async () => {
    expect(await listItems("co-1")).toEqual({ ok: true, value: [BRACKET, WASHER] });
    const files = await listItemFiles("co-1");
    expect(files.ok && files.value[0]).toEqual({ id: "f-1", itemId: "item-1", name: "Part", updatedAt: "2026-10-06T00:00:00Z" });
  });

  it("listParts names every file by its item, and leaves out a file whose item is not listed", async () => {
    const result = await listParts();
    expect(result).toEqual({
      ok: true,
      value: [
        { id: "f-2", name: "101027520 / Drawing" },
        { id: "f-1", name: "101027520 / Part" },
        { id: "f-3", name: "Washer / Part" },
      ],
    });
  });

  it("listParts says to sign in when nobody is", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const result = await listParts();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Sign in/);
  });

  it("passes a table error through", async () => {
    tables["stock_items"] = { data: null, error: { message: "network down" } };
    expect(await listItems("co-1")).toEqual({ ok: false, error: "network down" });
  });
});

describe("fetching a file", () => {
  it("returns its drawing, validated like a local .jcad", async () => {
    tables["item_cad_files"] = {
      data: { id: "f-1", company_id: "co-1", item_id: "item-1", name: "Part", updated_at: "t", document: { entities: [{ type: "line" }], constraints: [] } },
      error: null,
    };
    const file = await fetchItemFile("f-1");
    expect(file.ok && file.value).toMatchObject({ id: "f-1", companyId: "co-1", itemId: "item-1", name: "Part", snapshot: { entities: [{ type: "line" }] } });
    const part = await fetchPart("f-1");
    expect(part.ok && part.value.snapshot.entities).toHaveLength(1);
  });

  it("says so when the file is gone", async () => {
    tables["item_cad_files"] = { data: null, error: null };
    const file = await fetchItemFile("f-x");
    expect(file.ok).toBe(false);
  });
});

describe("saving onto an item", () => {
  const snapshot = { entities: [], constraints: [] };

  it("goes through the cad function: a new file without an id, a save-over with it", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, value: { id: "f-7", item_id: "item-1", name: "Flat", updated_at: "t" } }, error: null });
    const made = await saveItemFile({ companyId: "co-1", itemId: "item-1", name: "Flat", snapshot });
    expect(made).toEqual({ ok: true, value: { id: "f-7", itemId: "item-1", name: "Flat", updatedAt: "t" } });
    expect(mockInvoke).toHaveBeenLastCalledWith("cad", { body: { action: "item-file-save", companyId: "co-1", itemId: "item-1", name: "Flat", document: snapshot } });

    await saveItemFile({ companyId: "co-1", itemId: "item-1", id: "f-7", name: "Flat", snapshot });
    expect(mockInvoke).toHaveBeenLastCalledWith("cad", { body: { action: "item-file-save", companyId: "co-1", itemId: "item-1", id: "f-7", name: "Flat", document: snapshot } });
  });

  it("shows the server's own refusal", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: false, message: 'This item already has a file named "Part"' }, error: null });
    expect(await saveItemFile({ companyId: "co-1", itemId: "item-1", name: "Part", snapshot })).toEqual({ ok: false, error: 'This item already has a file named "Part"' });
  });

  it("Save to Library by name: '<part no.> / <file>' finds the item; a bare part number saves a file called Part", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, value: { id: "f-8", item_id: "item-1", name: "Flat pattern", updated_at: "t" } }, error: null });
    const result = await createPart("101027520 / Flat pattern", snapshot);
    expect(result).toEqual({ ok: true, value: { id: "f-8", name: "101027520 / Flat pattern" } });
    expect(mockInvoke.mock.calls[0]?.[1]).toMatchObject({ body: { itemId: "item-1", name: "Flat pattern" } });

    await createPart("washer", snapshot); // by item name, any case
    expect(mockInvoke.mock.calls[1]?.[1]).toMatchObject({ body: { itemId: "item-2", name: "Part" } });
  });

  it("an item that does not exist is not made here: it says to create it in MinimalERP", async () => {
    const result = await createPart("NO-SUCH / Part", snapshot);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/create it in MinimalERP/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
