/**
 * MinimalCAD Web
 * ui/cloudPanel.ts
 *
 * Thin, always-statically-imported shim in front of ui/cloudPanelImpl.ts --
 * see that module's header comment for the full reason (bundle size for
 * users who never touch cloud features, and a Rollup tree-shaking
 * correctness issue triggered by @supabase/supabase-js's dependency graph
 * being reachable from the same chunk as unrelated toolbar.ts code).
 *
 * Deliberately duplicates the tiny "is Supabase configured" check from
 * lib/supabaseClient.ts rather than importing it from there: importing
 * anything from that module -- even just this one boolean helper -- would
 * statically pull in its `import { createClient } from "@supabase/supabase-js"`
 * line too, defeating the point of this split. Two lines of duplication is
 * cheaper than depending on tree-shaking to prune it back out, especially
 * given the tree-shaking bug this split exists to route around.
 */

import type { Engine } from "../engine/engine";

function isSupabaseConfigured(): boolean {
  return (
    import.meta.env.VITE_SUPABASE_URL !== undefined &&
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY !== undefined || import.meta.env.VITE_SUPABASE_ANON_KEY !== undefined)
  );
}

let impl: typeof import("./cloudPanelImpl") | null = null;

/** No-ops if the cloud panel was never mounted (Supabase unconfigured, or
 *  called before initCloudUi's dynamic import has resolved -- which in
 *  practice never happens, since that import starts synchronously at app
 *  init and any user action fast enough to race it couldn't have a tab
 *  switch to react to yet regardless). Call after the active tab changes
 *  (new/close/switch) so an already-open panel redraws against whichever
 *  tab's cloud identity/drawings are now current, instead of showing the
 *  outgoing tab's stale state. */
export function refreshCloudPanel(): void {
  impl?.refreshCloudPanelIfOpen();
}

/** True while the active tab is a file of a stock item (opened from the
 *  item master, or saved onto an item): the toolbar's Save then writes it
 *  back to that item instead of downloading a file. False until the cloud
 *  panel has loaded, and whenever cloud features are not configured. */
export function activeTabIsLinkedToItem(): boolean {
  return impl?.activeTabIsLinkedToItem() ?? false;
}

/** Saves the active tab back to the item file it is linked to. */
export function saveActiveTabToItem(): void {
  impl?.saveActiveTabToItem();
}

/** Adds a "Cloud" button to the toolbar and lazily loads the real panel --
 *  a no-op if Supabase isn't configured, so an unconfigured/offline
 *  checkout shows no cloud UI at all rather than a broken one.
 *  `getActiveEngine` is called fresh on every use (never cached as one fixed
 *  Engine) so the panel always acts on whichever tab is currently active. */
export function initCloudUi(toolbarRoot: HTMLElement, getActiveEngine: () => Engine, requestRedraw: () => void): void {
  if (!isSupabaseConfigured()) return;

  void import("./cloudPanelImpl").then((mod) => {
    impl = mod;
    mod.mountCloudUi(toolbarRoot, getActiveEngine, requestRedraw);
  });
}
