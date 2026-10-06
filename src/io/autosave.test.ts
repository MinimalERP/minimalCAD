import { describe, expect, it, vi, beforeEach } from "vitest";

interface FakeResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/** Same minimal chainable-and-thenable stand-in as io/cloudDrawings.test.ts's
 *  own makeChain -- see that file for why every method just returns the
 *  builder itself. */
function makeChain<T>(result: FakeResult<T>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    insert: () => builder,
    update: () => builder,
    delete: () => builder,
    single: () => builder,
    maybeSingle: () => builder,
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

const { loadAutosave, writeAutosave, clearAutosave, resetAutosaveSession } = await import("./autosave");

beforeEach(() => {
  mockFrom.mockReset();
  mockInvoke.mockReset();
  resetAutosaveSession();
});

describe("loadAutosave", () => {
  it("returns null (not an error) when the account has never autosaved", async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: null }));
    const result = await loadAutosave();
    expect(result).toEqual({ ok: true, value: null });
  });

  it("validates and returns the stored snapshot", async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: { id: "row-1", document: { entities: [], constraints: [] }, updated_at: "2026-01-02T00:00:00Z" },
        error: null,
      }),
    );
    const result = await loadAutosave();
    expect(result).toEqual({
      ok: true,
      value: { snapshot: { entities: [], constraints: [] }, updatedAt: "2026-01-02T00:00:00Z" },
    });
  });

  it("rejects a malformed stored document", async () => {
    mockFrom.mockReturnValue(
      makeChain({ data: { id: "row-1", document: "garbage", updated_at: "2026-01-01T00:00:00Z" }, error: null }),
    );
    const result = await loadAutosave();
    expect(result.ok).toBe(false);
  });

  it("propagates a query error", async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: { message: "network error" } }));
    const result = await loadAutosave();
    expect(result).toEqual({ ok: false, error: "network error" });
  });
});

describe("writeAutosave / clearAutosave", () => {
  it("writes the one slot through the cad function (the server finds or makes the row)", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, value: { id: "row-1" } }, error: null });
    const snapshot = { entities: [{ type: "line" }], constraints: [] };
    expect(await writeAutosave(snapshot)).toEqual({ ok: true, value: undefined });
    expect(mockInvoke).toHaveBeenCalledWith("cad", { body: { action: "drawing-save", autosave: true, document: snapshot } });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("surfaces the underlying error on failure", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: false, message: "Sign in first" }, error: null });
    expect(await writeAutosave({ entities: [], constraints: [] })).toEqual({ ok: false, error: "Sign in first" });
  });

  it("clears the slot through the cad function", async () => {
    mockInvoke.mockResolvedValue({ data: { ok: true, value: {} }, error: null });
    expect(await clearAutosave()).toEqual({ ok: true, value: undefined });
    expect(mockInvoke).toHaveBeenCalledWith("cad", { body: { action: "drawing-delete", autosave: true } });
  });
});
