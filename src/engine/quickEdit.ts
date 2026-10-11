/**
 * MinimalCAD Web
 * engine/quickEdit.ts
 *
 * Ported from graphics/quick_edit.py's QuickEditController: when exactly one
 * Line or Text is the sole selection and no command is running, plain digit/
 * math keystrokes at the READY prompt edit that entity's one live property
 * (length for a Line, text height for a Text) directly, without invoking a
 * full command or grabbing a grip. Enter applies the typed value; Backspace
 * edits the in-progress buffer. Kept as a standalone controller Engine owns
 * directly (not a Command/BaseCommand) since its activation trigger --
 * "sole eligible entity selected and no command running" -- is structurally
 * different from a Command's explicit startCommand() activation, exactly as
 * the Python source's own header comment explains.
 *
 * A Dimension (a leader too) is edited the same way as a Text: its one live
 * property is its text height, and its arrows, gaps and shoulder follow in
 * proportion. The size typed is also what the next dimensions start at.
 * Circle already has grip-drag resize (commands/grips/circleResizeGrip.ts).
 */

import type { Engine } from "./engine";
import { Line } from "../entities/line";
import { Text } from "../entities/text";
import { Dimension } from "../entities/dimension";
import { evalNumber } from "../input/dynamicInput";

// Characters accepted into the live length/size quick-edit buffer -- plain
// numbers plus the same basic arithmetic dynamic_input.ts's evalNumber() understands.
const QUICK_EDIT_CHARS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "*", "/", "(", ")"]);

type QuickEditTarget = Line | Text | Dimension;

function isQuickEditable(entity: unknown): entity is QuickEditTarget {
  return entity instanceof Line || entity instanceof Text || entity instanceof Dimension;
}

/** (status-bar label, human hint noun, current value) for `target`'s live property. */
function info(target: QuickEditTarget): { label: string; hint: string; value: number } {
  if (target instanceof Line) {
    const dx = target.endPoint.x - target.startPoint.x;
    const dy = target.endPoint.y - target.startPoint.y;
    return { label: "LENGTH", hint: "length", value: Math.hypot(dx, dy) };
  }
  if (target instanceof Dimension) return { label: "DIM SIZE", hint: "text size", value: target.textHeight };
  return { label: "SIZE", hint: "text size", value: target.height };
}

export class QuickEditController {
  private buffer = "";

  constructor(private engine: Engine) {}

  /** Returns the sole selected Line/Text eligible for live property editing
   *  straight from the command bar, or null if nothing/multiple things are
   *  selected, the selection is some other entity type, or a command is
   *  currently running and already owns the keyboard. */
  target(): QuickEditTarget | null {
    if (this.engine.commandManager.currentCommand !== null) return null;
    const selected = this.engine.selection.getEntities();
    if (selected.length !== 1) return null;
    const entity = selected[0]!;
    return isQuickEditable(entity) ? entity : null;
  }

  hasBuffer(): boolean {
    return this.buffer !== "";
  }

  /** Re-syncs the command bar's status line with the current quick-edit
   *  target (or back to READY if there isn't one). Call any time the
   *  selection changes. */
  refreshStatus(): void {
    this.buffer = "";
    const target = this.target();
    if (target === null) {
      this.engine.commandBar.setReady();
      return;
    }
    const { label, hint, value } = info(target);
    this.engine.commandBar.setStatus(label, `${value.toFixed(2)} (type a new ${hint}, Enter to apply)`);
  }

  /** Appends a typed character to the live buffer if `ch` is an accepted
   *  quick-edit character. Returns true if consumed. */
  handleChar(ch: string, target: QuickEditTarget): boolean {
    if (!QUICK_EDIT_CHARS.has(ch)) return false;
    this.buffer += ch;
    this.updateDisplay(target);
    return true;
  }

  /** Removes the last typed character from the live buffer. Returns true if
   *  there was anything to remove. */
  backspace(target: QuickEditTarget): boolean {
    if (this.buffer === "") return false;
    this.buffer = this.buffer.slice(0, -1);
    this.updateDisplay(target);
    return true;
  }

  private updateDisplay(target: QuickEditTarget): void {
    const { label, value } = info(target);
    this.engine.commandBar.setStatus(label, `${value.toFixed(2)} -> ${this.buffer}`);
  }

  /** Applies the typed buffer as a new length (Line, resized symmetrically
   *  about its own midpoint) or a new text height (Text). */
  submit(target: QuickEditTarget): void {
    const raw = this.buffer;
    this.buffer = "";
    if (raw === "") return;

    const value = evalNumber(raw);
    const { label } = info(target);
    if (value === null || value <= 0) {
      this.engine.commandBar.setStatus(label, "Invalid - enter a positive number");
      return;
    }

    if (target instanceof Line) {
      const dx = target.endPoint.x - target.startPoint.x;
      const dy = target.endPoint.y - target.startPoint.y;
      const curLen = Math.hypot(dx, dy);
      if (curLen === 0) return;
      const midX = (target.startPoint.x + target.endPoint.x) / 2;
      const midY = (target.startPoint.y + target.endPoint.y) / 2;
      const ux = dx / curLen;
      const uy = dy / curLen;
      const half = Math.max(value, 0.01) / 2;
      this.engine.undo.push(this.engine.document.toDict());
      target.startPoint = { x: midX - ux * half, y: midY - uy * half };
      target.endPoint = { x: midX + ux * half, y: midY + uy * half };
    } else if (target instanceof Dimension) {
      this.engine.undo.push(this.engine.document.toDict());
      target.textHeight = value;
      this.engine.dimScale = target.data.scale as number;
    } else {
      this.engine.undo.push(this.engine.document.toDict());
      target.height = Math.max(value, 0.01);
    }

    this.refreshStatus();
    this.engine.requestRedraw();
  }
}
