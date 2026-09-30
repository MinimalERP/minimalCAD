/**
 * MinimalCAD Web
 * commands/manager.ts
 *
 * Ported from command_manager.py. Commands are singletons -- one instance
 * per registered name, built once, reused across every invocation; all
 * per-use state lives in instance fields reset by start().
 */

import type { Point } from "../core/types";
import type { Command } from "./types";
import type { Engine } from "../engine/engine";
import { COMMAND_REGISTRY, NON_REPEATABLE } from "./registry";

function buildAliasTable(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
    for (const alias of entry.aliases) {
      aliases[alias] = name;
    }
  }
  return aliases;
}

const ALIASES = buildAliasTable();

export class CommandManager {
  private commands = new Map<string, Command>();
  currentCommand: Command | null = null;
  currentName = "READY";
  private lastCommandName: string | null = null;

  // Commands are singletons (see this file's own header comment), so a
  // command instance's own identity can't distinguish "still the same
  // in-progress use" from "the same command started over from scratch" --
  // e.g. finishing one Line and immediately starting a fresh Line reuses the
  // exact same LineCommand object. Fired on every startCommand()/cancel(),
  // regardless of what command (if any) is involved, so UI-side state that
  // outlives a single command use -- currently: canvasView.ts's touch
  // point-pick candidate -- has one reliable place to reset from instead of
  // needing to be threaded through every call site that can start or end a
  // command (there are several: toolbar buttons, Escape, grip commands
  // finishing, trim.ts, repeat-last, typed command names...).
  constructor(
    engine: Engine,
    private onCommandChanged?: () => void,
  ) {
    for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
      this.commands.set(name, entry.factory(engine));
    }
  }

  startCommand(name: string): boolean {
    const key = name.toLowerCase();
    const command = this.commands.get(key);
    if (command === undefined) return false;

    if (this.currentCommand !== null) {
      this.currentCommand.cancel();
    }

    this.currentCommand = command;
    this.currentName = key.toUpperCase();
    if (!NON_REPEATABLE.has(key)) {
      this.lastCommandName = key;
    }

    command.start();
    this.onCommandChanged?.();
    return true;
  }

  /** Runs a command that isn't in the registry (e.g. a drawing sheet's
   *  Base View) -- same lifecycle as startCommand, never repeatable. */
  startCustom(name: string, command: Command): void {
    if (this.currentCommand !== null) this.currentCommand.cancel();
    this.currentCommand = command;
    this.currentName = name.toUpperCase();
    command.start();
    this.onCommandChanged?.();
  }

  repeatLast(): boolean {
    if (this.lastCommandName === null) return false;
    return this.startCommand(this.lastCommandName);
  }

  tryStartFromText(text: string): boolean {
    const key = text.trim().toLowerCase();
    if (key === "") return false;
    const resolved = ALIASES[key] ?? key;
    return this.startCommand(resolved);
  }

  cancel(): void {
    if (this.currentCommand !== null) {
      this.currentCommand.cancel();
    }
    this.currentCommand = null;
    this.currentName = "READY";
    this.onCommandChanged?.();
  }

  leftClick(pt: Point): void {
    this.currentCommand?.leftClick(pt);
  }

  rightClick(pt: Point): void {
    this.currentCommand?.rightClick(pt);
  }

  mouseMove(pt: Point): void {
    this.currentCommand?.mouseMove(pt);
  }

  keyPress(key: string): void {
    this.currentCommand?.keyPress(key);
  }

  textInput(text: string): void {
    this.currentCommand?.textInput?.(text);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.currentCommand?.draw(ctx);
  }
}
