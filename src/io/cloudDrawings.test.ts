import { describe, expect, it, vi, beforeEach } from "vitest";

interface FakeResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/** A minimal stand-in for supabase-js's chainable-and-thenable
 *  PostgrestFilterBuilder: every chain method (select/order/eq/insert/
 *  update/delete/single) returns the same object, and awaiting it resolves
 *  to the configured {data, error} -- exactly the shape io/cloudDrawings.ts
 *  destructures after each chain, regardless of exactly which methods were
 *  called along the way. */
function makeChain<T>(result: FakeResult<T>) {
  const builder = {
    select: () => builder,
    order: () => builder,
    eq: () => builder,
    insert: () => builder,
    update: () => builder,
    delete: () => builder,
    single: () => builder,
    then<TResult1 = FakeResult<T>, TResult2 = never>(
      onfulfilled?: ((value: FakeResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  return builder;
}

const mockFrom = vi.fn();
const mockInvoke = vi.fn();

vi.mock("../lib/supabaseClient", () => ({
  getSupabaseClient: () => ({ from: mockFrom, functions: { invoke: mockInvoke } }),
}));

// Imported after the mock so cloudDrawings.ts picks up the mocked module.
const { listDrawings, fetchDrawing, createDrawing, updateDrawing, renameDrawing, deleteDrawing } = await import(
  "./cloudDrawings"
);

beforeEach(() => {
  mockFrom.mockReset();
  mockInvoke.mockReset();
});

describe("listDrawings", () => {
  it("maps rows to CloudDrawingSummary[], newest first (as returned)", async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: [
          { id: "1", name: "Bracket", updated_at: "2026-01-02T00:00:00Z" },
          { id: "2", name: "Plate", updated_at: "2026-01-01T00:00:00Z" },
        ],
        error: null,
      }),
    );

    const result = await listDrawings();
    expect(result).toEqual({
      ok: true,
      value: [
        { id: "1", name: "Bracket", updatedAt: "2026-01-02T00:00:00Z" },
        { id: "2", name: "Plate", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    expect(mockFrom).toHaveBeenCalledWith("cad_drawings");
  });

  it("returns an error result (never throws) when the query fails", async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: { message: "network error" } }));
    const result = await listDrawings();
    expect(result).toEqual({ ok: false, error: "network error" });
  });

  it("treats a null data response as an empty list", async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: null }));
    const result = await listDrawings();
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe("fetchDrawing", () => {
  it("validates the jsonb document column the same way a local file is validated", async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: {
          id: "1",
          name: "Bracket",
          document: { entities: [{ type: "line" }], constraints: [] },
          updated_at: "2026-01-02T00:00:00Z",
        },
        error: null,
      }),
    );

    const result = await fetchDrawing("1");
    expect(result).toEqual({
      ok: true,
      value: {
        id: "1",
        name: "Bracket",
        snapshot: { entities: [{ type: "line" }], constraints: [] },
        updatedAt: "2026-01-02T00:00:00Z",
      },
    });
  });

  it("rejects a malformed document payload instead of handing back garbage", async () => {
    mockFrom.mockReturnValue(
      makeChain({ data: { id: "1", name: "Bad", document: "not an object", updated_at: "2026-01-01T00:00:00Z" }, error: null }),
    );
    const result = await fetchDrawing("1");
    expect(result.ok).toBe(false);
  });

  it("propagates a query error", async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: { message: "not found" } }));
    const result = await fetchDrawing("missing");
    expect(result).toEqual({ ok: false, error: "not found" });
  });
});

describe("writes go through the cad function, never to the table", () => {
  const snapshot = { entities: [], constraints: [] };

  it("createDrawing returns the new row's id/name/updatedAt", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, value: { id: "new-id", name: "Untitled", updated_at: "2026-01-03T00:00:00Z" } }, error: null });
    const result = await createDrawing("Untitled", snapshot);
    expect(result).toEqual({ ok: true, value: { id: "new-id", name: "Untitled", updatedAt: "2026-01-03T00:00:00Z" } });
    expect(mockInvoke).toHaveBeenCalledWith("cad", { body: { action: "drawing-save", name: "Untitled", document: snapshot } });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("update / rename / delete resolve ok, each with its own action", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, value: {} }, error: null });
    expect(await updateDrawing("1", snapshot)).toEqual({ ok: true, value: undefined });
    expect(await renameDrawing("1", "New name")).toEqual({ ok: true, value: undefined });
    expect(await deleteDrawing("1")).toEqual({ ok: true, value: undefined });
    expect(mockInvoke.mock.calls.map((c) => (c[1] as { body: { action: string } }).body.action)).toEqual(["drawing-save", "drawing-rename", "drawing-delete"]);
  });

  it("a refusal from the server is the error shown; so is not reaching it", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: false, message: "That drawing no longer exists" }, error: null });
    expect(await updateDrawing("1", snapshot)).toEqual({ ok: false, error: "That drawing no longer exists" });
    mockInvoke.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    expect(await deleteDrawing("1")).toEqual({ ok: false, error: "Failed to fetch" });
  });
});
