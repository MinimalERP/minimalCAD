/**
 * MinimalCAD Web
 * viewer/protocol.ts
 *
 * What the view-only page and the page that frames it (MinimalERP's item
 * master) say to each other with postMessage. The framing page owns the
 * file and the buttons; this page only draws it and makes its PDF.
 *
 *   viewer -> host   { source: VIEWER, type: "ready" }                      when it can take a file, and again whenever asked
 *   host -> viewer   { source: HOST, type: "hello" }                        "are you ready?" (the first "ready" may have gone unheard)
 *   host -> viewer   { source: HOST, type: "open", document }               the parsed .jcad
 *   viewer -> host   { source: VIEWER, type: "opened", kind }               "sheet" | "drawing"
 *   viewer -> host   { source: VIEWER, type: "problem", message }           the file could not be shown
 *   host -> viewer   { source: HOST, type: "pdf", id, scale }               "fit" | "1:1"
 *   viewer -> host   { source: VIEWER, type: "pdf", id, bytes, warning }    or { ..., type: "pdf", id, error }
 */

export const VIEWER = "minimalcad-viewer";
export const HOST = "minimalcad-host";

export type HostMessage = { source: typeof HOST; type: "hello" } | { source: typeof HOST; type: "open"; document: unknown } | { source: typeof HOST; type: "pdf"; id: string; scale: "fit" | "1:1" };

/** A message from the framing page, or null for anything else. */
export function readHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.source !== HOST) return null;
  if (m.type === "hello") return { source: HOST, type: "hello" };
  if (m.type === "open") return { source: HOST, type: "open", document: m.document };
  if (m.type === "pdf" && typeof m.id === "string") return { source: HOST, type: "pdf", id: m.id, scale: m.scale === "1:1" ? "1:1" : "fit" };
  return null;
}
