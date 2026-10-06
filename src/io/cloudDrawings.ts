/**
 * MinimalCAD Web
 * io/cloudDrawings.ts
 *
 * Thin data-access layer over the `cad_drawings` table of the MinimalERP
 * database this app shares (its migration 20261026000100_cad.sql) --
 * create/list/fetch/rename/delete a person's own cloud drawing, and save
 * the current Document to one. Reads are scoped to the signed-in user
 * purely by Row Level Security: this layer never filters by user id
 * itself, it relies on Postgres hiding rows that aren't the caller's.
 * Writes go through the "cad" Edge Function (io/cloudApi.ts), which acts
 * as the signed-in person -- a browser cannot write the table at all.
 *
 * Returns a Result-shaped value (never throws) so UI code can show a toast
 * on failure the same way io/saveLoad.ts's local Open already does for a
 * malformed file, rather than needing a try/catch at every call site.
 */

import { getSupabaseClient } from "../lib/supabaseClient";
import { callCad } from "./cloudApi";
import { validateDocumentSnapshot } from "./fileFormat";
import type { DocumentSnapshot } from "../core/document";

export interface CloudDrawingSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface CloudDrawing extends CloudDrawingSummary {
  snapshot: DocumentSnapshot;
}

export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface DrawingRow {
  id: string;
  name: string;
  document: unknown;
  updated_at: string;
}

function describeError(error: { message: string } | null): string {
  return error?.message ?? "Unknown error";
}

/** Lists the signed-in user's drawings, most recently updated first --
 *  RLS's own "select own drawings" policy is what makes this the current
 *  user's drawings and nothing else. */
export async function listDrawings(): Promise<CloudResult<CloudDrawingSummary[]>> {
  const { data, error } = await getSupabaseClient()
    .from("cad_drawings")
    .select("id, name, updated_at")
    .eq("is_autosave", false) // the autosave slot is io/autosave.ts's, not a drawing to list
    .order("updated_at", { ascending: false });

  if (error) return { ok: false, error: describeError(error) };
  const rows = (data ?? []) as Pick<DrawingRow, "id" | "name" | "updated_at">[];
  return { ok: true, value: rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })) };
}

/** Fetches one drawing's full document -- validated the same way a local
 *  .jcad file's contents are (see fileFormat.ts's validateDocumentSnapshot),
 *  since a jsonb column is opaque storage from Postgres's own perspective
 *  and could in principle hold anything a client wrote to it. */
export async function fetchDrawing(id: string): Promise<CloudResult<CloudDrawing>> {
  const { data, error } = await getSupabaseClient()
    .from("cad_drawings")
    .select("id, name, document, updated_at")
    .eq("id", id)
    .single();

  if (error) return { ok: false, error: describeError(error) };
  const row = data as DrawingRow;

  const parsed = validateDocumentSnapshot(row.document);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  return { ok: true, value: { id: row.id, name: row.name, snapshot: parsed.snapshot, updatedAt: row.updated_at } };
}

/** Creates a new cloud drawing from the current Document. Like every
 *  change, it goes through the "cad" Edge Function (see io/cloudApi.ts):
 *  the database lets a browser read its own drawings, never write them. */
export async function createDrawing(name: string, snapshot: DocumentSnapshot): Promise<CloudResult<CloudDrawingSummary>> {
  const result = await callCad<{ id: string; name: string; updated_at: string }>("drawing-save", { name, document: snapshot });
  if (!result.ok) return result;
  return { ok: true, value: { id: result.value.id, name: result.value.name, updatedAt: result.value.updated_at } };
}

/** Overwrites an existing drawing's document -- last-write-wins, same
 *  whole-document-replace model as local Open/Save already use. */
export async function updateDrawing(id: string, snapshot: DocumentSnapshot): Promise<CloudResult<void>> {
  const result = await callCad<unknown>("drawing-save", { id, document: snapshot });
  return result.ok ? { ok: true, value: undefined } : result;
}

export async function renameDrawing(id: string, name: string): Promise<CloudResult<void>> {
  const result = await callCad<unknown>("drawing-rename", { id, name });
  return result.ok ? { ok: true, value: undefined } : result;
}

export async function deleteDrawing(id: string): Promise<CloudResult<void>> {
  const result = await callCad<unknown>("drawing-delete", { id });
  return result.ok ? { ok: true, value: undefined } : result;
}
