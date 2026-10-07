/**
 * MinimalCAD Web
 * commands/editText.ts
 *
 * Ported from commands/edit_text.py: contextual one-shot gesture that edits
 * an existing Text entity's string content, or a Dimension's displayed
 * label, in place. Entered directly by ui/canvasView.ts on a double-click
 * that lands on a Text or Dimension entity -- not reachable via the typed
 * command line, mirroring commands/grips/*'s "begin() only" convention
 * (see commands/types.ts's GripCommand). No Table in this web port yet
 * (see entities/registry.ts), so there's no per-cell editing case here.
 *
 * For a Dimension, editing overrides its auto-computed measurement string
 * (entities/dimension.ts's textOverride via setTextOverride()) -- or, for
 * a Leader, its free-form text directly -- via getDisplayText()/
 * setTextOverride(), so the same gesture that renames a plain Text label
 * also lets a user append "TYP", swap in a fraction, or otherwise
 * hand-annotate any dimension's text.
 *
 * Simpler than the Python source here: Python needed a one-off Qt signal
 * connect/disconnect dance to route the command bar's Enter key to this
 * command instead of the normal numeric text_input() path; this port's
 * textInput() is already called generically for every submission while the
 * command is active (see commands/text.ts's own identical simplification).
 */

import type { Engine } from "../engine/engine";
import type { Entity } from "../entities/entity";
import type { GripCommand } from "./types";
import { BaseCommand } from "./base";
import { Dimension } from "../entities/dimension";
import { Text } from "../entities/text";

type Editable = Text | Dimension;

export class EditTextCommand extends BaseCommand implements GripCommand {
  private entity: Editable | null = null;

  constructor(engine: Engine) {
    super(engine);
  }

  /** Generic no-arg entry point required by CommandManager -- this command
   *  only does something once armed via begin() (see ui/canvasView.ts's
   *  double-click handler), so a bare start() just leaves it inert. */
  start(): void {
    this.entity = null;
    this.commandBar.setStatus("EDIT TEXT", "Double-click a text or dimension to edit it");
  }

  /** Arms the gesture for `entity`, pre-filling its current displayed
   *  string for editing. No-ops for anything that isn't a Text or
   *  Dimension (defensive -- callers already filter, see canvasView.ts). */
  begin(entity: Entity): void {
    if (!(entity instanceof Text || entity instanceof Dimension)) return;
    this.entity = entity;
    const current = entity instanceof Dimension ? entity.getDisplayText() : entity.text;
    this.commandBar.setStatus("EDIT TEXT", "Edit text, Enter to apply");
    this.commandBar.enableInput("text");
    this.commandBar.setTextToEdit(current);
  }

  textInput(text: string): void {
    if (this.entity === null) return;
    const clean = text.trim();
    if (!clean) {
      this.commandBar.setStatus("EDIT TEXT", "Text can't be empty");
      return;
    }

    this.undo.push(this.document.toDict());
    if (this.entity instanceof Dimension) {
      this.entity.setTextOverride(clean);
    } else {
      this.entity.text = clean;
    }

    this.entity = null;
    this.engine.selection.clear();
    this.engine.cancelCommand();
    this.engine.requestRedraw();
  }

  cancel(): void {
    this.entity = null;
    this.commandBar.setReady();
  }
}
