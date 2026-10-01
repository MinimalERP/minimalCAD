/**
 * MinimalCAD Web
 * ui/overlayMode.ts
 *
 * How much of the "numbers on the drawing" overlay is shown: each shape's
 * own sizes, the constraint lines with their distances, and the geometric
 * constraint tags. On a drawing of many small entities all of it at once
 * is clutter, so the command bar's CONS button (next to ORTHO) steps
 * through:
 *
 *   ALL  everything            SEL  only the selected / just-drawn shape's
 *   OFF  nothing
 *
 * It only changes what is DRAWN: constraints go on holding either way.
 * One setting for the whole app, remembered between visits.
 */

export type OverlayMode = "all" | "selected" | "off";

const KEY = "minimalcad.overlayMode";
const ORDER: readonly OverlayMode[] = ["all", "selected", "off"];

function load(): OverlayMode {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (v === "all" || v === "selected" || v === "off") return v;
  } catch {
    // Storage blocked (private window): just use the default.
  }
  return "all";
}

let mode: OverlayMode = load();

export function overlayMode(): OverlayMode {
  return mode;
}

export function setOverlayMode(next: OverlayMode): void {
  mode = next;
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    // Not remembered, but it still applies now.
  }
}

/** Steps ALL -> SEL -> OFF -> ALL; returns the new mode. */
export function cycleOverlayMode(): OverlayMode {
  setOverlayMode(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!);
  return mode;
}

export const OVERLAY_LABEL: Record<OverlayMode, string> = { all: "CONS: ALL", selected: "CONS: SEL", off: "CONS: OFF" };
