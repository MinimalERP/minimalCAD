/**
 * MinimalCAD Web
 * io/autosave.ts
 *
 * One reserved "Autosave" slot per signed-in account, stored as an ordinary
 * row in the `cad_drawings` table flagged is_autosave=true (MinimalERP's
 * migration 20261026000100_cad.sql keeps it to one per person). Silently
 * overwritten periodically and on tab-hide by ui/autosaveController.ts;
 * loadAutosave() is what backs the "Restore your last session?" prompt
 * shown once at startup.
 *
 * The slot is read straight from the table (Row Level Security shows a
 * person only their own row) and written through the "cad" Edge Function
 * (io/cloudApi.ts), which finds or creates the one row server-side -- so
 * this module no longer needs to remember which row is "mine".
 */

import { getSupabaseClient } from "../lib/supabaseClient";
import { callCad } from "./cloudApi";
import { validateDocumentSnapshot } from "./fileFormat";
import type { DocumentSnapshot } from "../core/document";

export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string };

function describeError(error: { message: string } | null): string {
  return error?.message ?? "Unknown error";
}

/** Fetches the signed-in user's autosave slot, if one exists yet -- resolves
 *  `{ ok: true, value: null }` (not an error) when there simply isn't one,
 *  e.g. an account that has never autosaved. */
export async function loadAutosave(): Promise<CloudResult<{ snapshot: DocumentSnapshot; updatedAt: string } | null>> {
  const { data, error } = await getSupabaseClient()
    .from("cad_drawings")
    .select("id, document, updated_at")
    .eq("is_autosave", true)
    .maybeSingle();

  if (error) return { ok: false, error: describeError(error) };
  if (data === null) return { ok: true, value: null };

  const row = data as { id: string; document: unknown; updated_at: string };
  const parsed = validateDocumentSnapshot(row.document);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: { snapshot: parsed.snapshot, updatedAt: row.updated_at } };
}

/** Overwrites the autosave slot with the current document, creating it on
 *  first use. Best-effort by design: a failed autosave doesn't interrupt or
 *  alert the user mid-work (their real Save is unaffected either way) --
 *  callers generally fire-and-forget this. */
export async function writeAutosave(snapshot: DocumentSnapshot): Promise<CloudResult<void>> {
  const result = await callCad<unknown>("drawing-save", { autosave: true, document: snapshot });
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Deletes the autosave slot -- called when the user explicitly discards the
 *  restore prompt, so the same stale content isn't offered again next time. */
export async function clearAutosave(): Promise<CloudResult<void>> {
  const result = await callCad<unknown>("drawing-delete", { autosave: true });
  return result.ok ? { ok: true, value: undefined } : result;
}

/** Kept for ui/autosaveController.ts, which calls it on sign-out: there is
 *  no per-tab memory of "which row is mine" left to forget (the server finds
 *  the slot by who is signed in). */
export function resetAutosaveSession(): void {
  // nothing to reset
}
