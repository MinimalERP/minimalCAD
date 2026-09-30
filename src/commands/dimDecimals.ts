/**
 * MinimalCAD Web
 * commands/dimDecimals.ts
 *
 * DIMDEC (like AutoCAD's): decimal places for dimensions -- 0 to 4, or A
 * for auto (no trailing zeros: 25, 12.5). Sets it for new dimensions and
 * applies it to any dimensions already selected.
 */

import type { Engine } from "../engine/engine";
import { Dimension } from "../entities/dimension";
import { BaseCommand } from "./base";

export class DimDecimalsCommand extends BaseCommand {
  constructor(engine: Engine) {
    super(engine);
  }

  start(): void {
    const now = this.engine.dimPrecision;
    const shown = now === null ? "2" : now === "auto" ? "A" : String(now);
    this.commandBar.setStatus("DIMDEC", `Dimension decimals 0-4, or A for auto (no trailing zeros) <${shown}>`);
    this.commandBar.enableInput();
  }

  textInput(text: string): void {
    const t = text.trim().toLowerCase();
    if (t === "") {
      this.engine.cancelCommand();
      return;
    }
    let value: number | "auto";
    if (t === "a" || t === "auto") value = "auto";
    else if (/^[0-4]$/.test(t)) value = Number(t);
    else {
      this.commandBar.setStatus("DIMDEC", "Type 0, 1, 2, 3, 4 or A");
      return;
    }
    this.engine.dimPrecision = value;
    const picked = this.engine.selection.getEntities().filter((e): e is Dimension => e instanceof Dimension);
    if (picked.length > 0) {
      this.undo.push(this.document.toDict());
      for (const d of picked) {
        if (value === "auto") {
          delete d.data.precision;
          d.data.trim_zeros = 1;
        } else d.data.precision = value;
      }
    }
    this.engine.cancelCommand();
    this.engine.requestRedraw();
  }
}
