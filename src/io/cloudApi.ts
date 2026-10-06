/**
 * MinimalCAD Web
 * io/cloudApi.ts
 *
 * The two ways this app talks to the MinimalERP database it shares:
 *
 *   - READS go straight to a table through the Supabase client; Row Level
 *     Security decides which rows come back (a company's items and their
 *     CAD files for its people, a person's own drawings for that person).
 *   - WRITES never touch a table: the database grants a browser SELECT and
 *     nothing else. Every change is sent to the `cad` Edge Function
 *     (supabase/functions/cad in the MinimalERP repository), which checks
 *     who is asking and what they may do, then makes the change.
 *
 * Returns a Result-shaped value (never throws), like every io/cloud* module.
 */

import { getSupabaseClient } from "../lib/supabaseClient";

export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** One change, sent to the `cad` Edge Function. */
export async function callCad<T>(action: string, body: Record<string, unknown>): Promise<CloudResult<T>> {
  try {
    const { data, error } = await getSupabaseClient().functions.invoke("cad", { body: { action, ...body } });
    if (error) return { ok: false, error: (error as { message?: string }).message ?? "Could not reach the server" };
    const answer = data as { ok?: boolean; value?: T; message?: string } | null;
    if (answer?.ok === true) return { ok: true, value: answer.value as T };
    return { ok: false, error: answer?.message ?? "The server refused the change" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach the server" };
  }
}

/** PostgREST answers at most this many rows per request. */
const PAGE = 1000;

/**
 * Every row of a query, however many: asks page after page until one comes
 * back short. `page(from, to)` must apply `.range(from, to)` to the query
 * (and a stable `.order(...)`, or pages could overlap).
 */
export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<CloudResult<T[]>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { ok: false, error: error.message };
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return { ok: true, value: rows };
  }
}
