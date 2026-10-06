/**
 * MinimalCAD Web
 * commands/saveLib.ts
 *
 * Ported from commands/save_library.py: type a name, save the current
 * selection (or the whole drawing if nothing is selected) as a reusable
 * part. No Table in this web port yet, so nothing library-specific to
 * preview while active -- matches the desktop source, which has no
 * draw()/preview override either.
 *
 * Storage differs from the desktop app: parts live as rows in Supabase's
 * `parts` table (io/cloudParts.ts, supabase/migrations/0003_parts.sql)
 * instead of standalone .jcad files in a filesystem folder, since the
 * browser has no filesystem and this app supports multiple accounts. A
 * per-owner unique name constraint reproduces the desktop app's refusal to
 * silently overwrite an existing part name -- surfaced here as the same
 * friendly "already exists" error io/cloudParts.ts already translates it
 * to, rather than a separate pre-check against a fetched name list (the
 * database is the single source of truth either way, so a second local
 * check would just be a race-prone, purely cosmetic duplicate of it).
 *
 * @supabase/supabase-js is NEVER statically imported here -- commands/
 * registry.ts (and everything it imports) is part of the always-loaded
 * main bundle, constructed eagerly for every command at startup (see
 * commands/manager.ts), so pulling that dependency in at module scope
 * would defeat ui/cloudPanel.ts's whole reason for existing (see its own
 * header comment). io/cloudParts.ts is loaded via a dynamic import()
 * instead, only once this command actually runs -- Vite/Rollup code-splits
 * it into the same lazily-loaded chunk ui/cloudPanelImpl.ts already uses.
 */

import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import { BaseCommand } from "./base";

function isSupabaseConfigured(): boolean {
  return (
    import.meta.env.VITE_SUPABASE_URL !== undefined &&
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY !== undefined || import.meta.env.VITE_SUPABASE_ANON_KEY !== undefined)
  );
}

export class SaveLibCommand extends BaseCommand {
  private entitiesToSave: Entity[] = [];
  private scopeNote = "";
  private busy = false;
  // Bumped on every start()/cancel() so a still-in-flight async result from
  // a *previous* activation can recognize it's stale and discard itself --
  // CommandManager reuses one singleton instance per registered command
  // name (see commands/manager.ts), it doesn't construct a fresh one per
  // invocation.
  private generation = 0;

  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    this.generation++;
    this.busy = false;

    if (!isSupabaseConfigured()) {
      this.commandBar.setStatus("SAVE TO LIBRARY", "Cloud isn't configured");
      this.commandBar.disableInput();
      return;
    }

    const selected = this.engine.selection.getEntities();
    if (selected.length > 0) {
      this.entitiesToSave = selected;
      this.scopeNote = `${selected.length} selected`;
    } else {
      this.entitiesToSave = this.document.getEntities();
      this.scopeNote = "whole drawing";
    }

    this.commandBar.setStatus("SAVE TO LIBRARY", `Item part no. / file name: (${this.scopeNote})`);
    this.commandBar.enableInput("text");
  }

  textInput(text: string): void {
    if (this.busy) return;
    const name = text.trim();
    if (name === "") {
      this.commandBar.setStatus("SAVE TO LIBRARY", "Invalid name");
      return;
    }
    if (this.entitiesToSave.length === 0) {
      this.commandBar.setStatus("SAVE TO LIBRARY", "Nothing to save - document is empty");
      return;
    }

    this.busy = true;
    const generation = this.generation;
    const snapshot = { entities: this.entitiesToSave.map((e) => e.serialize()), constraints: [] };

    void import("../io/cloudParts").then(({ createPart }) => {
      void createPart(name, snapshot).then((result) => {
        if (generation !== this.generation) return; // command was cancelled/restarted meanwhile
        this.busy = false;
        if (!result.ok) {
          this.commandBar.setStatus("SAVE TO LIBRARY", result.error);
          return;
        }
        // Matches save_library.py exactly: no separate success message,
        // just return to READY -- the command bar itself going quiet is
        // the cue that it worked.
        this.engine.cancelCommand();
      });
    });
  }

  cancel(): void {
    this.generation++;
    this.busy = false;
    this.entitiesToSave = [];
    this.commandBar.setReady();
  }
}
