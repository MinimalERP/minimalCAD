/**
 * MinimalCAD Web
 * view3d/featureDialog.ts
 *
 * Inventor-style feature dialog for 3D commands: a small NON-modal floating
 * panel (the 3D view stays clickable for picking faces/profiles/points) with
 * labelled fields + units, picture buttons for choices, a selection status
 * row, an error line, and OK / Cancel. Enter = OK, Esc = Cancel.
 *
 * Plain DOM, no framework; commands (view3d/commands/*) build one per run.
 */

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Inline SVG markup (20x20 viewBox) shown above the label. */
  icon?: string;
  title?: string;
}

export interface FieldHandle {
  set(text: string): void;
  setVisible(visible: boolean): void;
  setEnabled(enabled: boolean): void;
}

export interface ChoiceHandle<T extends string> {
  set(value: T): void;
  setVisible(visible: boolean): void;
}

export interface SelectionHandle {
  /** `done` styles it as satisfied (green) vs still needed (amber). */
  set(text: string, done: boolean): void;
  /** Marks it as the one the view is picking for right now. */
  setActive(active: boolean): void;
}

export class FeatureDialog {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private messageEl: HTMLDivElement;
  private okBtn: HTMLButtonElement;
  private closed = false;

  constructor(
    parent: HTMLElement,
    title: string,
    private handlers: { onOk: () => void; onCancel: () => void },
  ) {
    this.el = document.createElement("div");
    this.el.className = "feature-dialog";
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!this.okBtn.disabled) this.handlers.onOk();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.handlers.onCancel();
      }
      e.stopPropagation(); // typing here must not trigger 3D-view shortcuts
    });

    const head = document.createElement("div");
    head.className = "fd-title";
    head.textContent = title;
    this.el.appendChild(head);

    this.body = document.createElement("div");
    this.body.className = "fd-body";
    this.el.appendChild(this.body);

    this.messageEl = document.createElement("div");
    this.messageEl.className = "fd-message";
    this.el.appendChild(this.messageEl);

    const buttons = document.createElement("div");
    buttons.className = "fd-buttons";
    this.okBtn = document.createElement("button");
    this.okBtn.className = "fd-ok";
    this.okBtn.textContent = "OK";
    this.okBtn.addEventListener("click", () => this.handlers.onOk());
    const cancel = document.createElement("button");
    cancel.className = "fd-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.handlers.onCancel());
    buttons.append(this.okBtn, cancel);
    this.el.appendChild(buttons);

    parent.appendChild(this.el);
  }

  private row(label: string): { row: HTMLDivElement; slot: HTMLDivElement } {
    const row = document.createElement("div");
    row.className = "fd-row";
    const l = document.createElement("div");
    l.className = "fd-label";
    l.textContent = label;
    const slot = document.createElement("div");
    slot.className = "fd-slot";
    row.append(l, slot);
    this.body.appendChild(row);
    return { row, slot };
  }

  /** A "what to click" status line, e.g. "Profile: 2 selected". With
   *  `onClick` it is also a button: click it to pick for that row again. */
  selection(label: string, text: string, done = false, onClick?: () => void): SelectionHandle {
    const { slot } = this.row(label);
    const s = document.createElement("div");
    s.className = "fd-selection";
    if (onClick !== undefined) {
      s.classList.add("clickable");
      s.title = `Click to pick the ${label.toLowerCase()}`;
      s.addEventListener("mousedown", (e) => e.preventDefault());
      s.addEventListener("click", onClick);
    }
    slot.appendChild(s);
    const handle: SelectionHandle = {
      set: (t, d) => {
        s.textContent = t;
        s.classList.toggle("done", d);
      },
      setActive: (a) => s.classList.toggle("active", a),
    };
    handle.set(text, done);
    return handle;
  }

  /** Numeric/expression field ("10", "d1*2"); onChange fires on every keystroke. */
  number(label: string, unit: string, value: string, onChange: (text: string) => void): FieldHandle {
    const { row, slot } = this.row(label);
    const input = document.createElement("input");
    input.className = "fd-input";
    input.value = value;
    input.spellcheck = false;
    input.addEventListener("input", () => onChange(input.value.trim()));
    input.addEventListener("focus", () => input.select());
    const u = document.createElement("span");
    u.className = "fd-unit";
    u.textContent = unit;
    slot.append(input, u);
    return {
      set: (t) => {
        input.value = t;
      },
      setVisible: (v) => {
        row.hidden = !v;
      },
      setEnabled: (en) => {
        input.disabled = !en;
      },
    };
  }

  /** Row of picture buttons, exactly one active. */
  choice<T extends string>(label: string, options: ChoiceOption<T>[], value: T, onChange: (value: T) => void): ChoiceHandle<T> {
    const { row, slot } = this.row(label);
    const group = document.createElement("div");
    group.className = "fd-choice";
    const buttons = options.map((o) => {
      const b = document.createElement("button");
      b.className = "fd-choice-btn";
      b.title = o.title ?? o.label;
      b.innerHTML = `${o.icon ?? ""}<span>${o.label}</span>`;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the field being typed
      b.addEventListener("click", () => {
        handle.set(o.value);
        onChange(o.value);
      });
      group.appendChild(b);
      return b;
    });
    slot.appendChild(group);
    const handle: ChoiceHandle<T> = {
      set: (v) => buttons.forEach((b, i) => b.classList.toggle("active", options[i]!.value === v)),
      setVisible: (v) => {
        row.hidden = !v;
      },
    };
    handle.set(value);
    return handle;
  }

  /** Inline text entry with its own Enter/button (e.g. "add centre at x,y"). */
  textEntry(label: string, placeholder: string, buttonLabel: string, onSubmit: (text: string) => boolean): void {
    const { slot } = this.row(label);
    const input = document.createElement("input");
    input.className = "fd-input fd-wide";
    input.placeholder = placeholder;
    input.spellcheck = false;
    const btn = document.createElement("button");
    btn.className = "fd-small-btn";
    btn.textContent = buttonLabel;
    const submit = (): void => {
      if (onSubmit(input.value.trim())) input.value = "";
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation(); // Enter here adds, it doesn't press OK
      submit();
    });
    slot.append(input, btn);
  }

  /** Row of plain small buttons (e.g. "Remove last"). */
  buttons(label: string, items: { label: string; onClick: () => void }[]): void {
    const { slot } = this.row(label);
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "fd-small-btn";
      b.textContent = it.label;
      b.addEventListener("click", it.onClick);
      slot.appendChild(b);
    }
  }

  /** A full-width on/off button (e.g. "Position holes"). */
  toggle(label: string, title: string, onChange: (on: boolean) => void): { set(on: boolean): void } {
    const b = document.createElement("button");
    b.className = "fd-toggle";
    b.textContent = label;
    b.title = title;
    let on = false;
    const set = (v: boolean): void => {
      on = v;
      b.classList.toggle("active", v);
    };
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      set(!on);
      onChange(on);
    });
    this.body.appendChild(b);
    return { set };
  }

  /** An empty block the command fills itself (e.g. the Hole list). */
  custom(className: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = className;
    this.body.appendChild(el);
    return el;
  }

  /** Runs `build` (which adds rows) and returns a handle that shows/hides
   *  all the rows it added -- for conditional groups like "From 2 edges". */
  rowGroup(build: () => void): { setVisible(visible: boolean): void } {
    const before = this.body.children.length;
    build();
    const rows = [...this.body.children].slice(before) as HTMLElement[];
    return { setVisible: (v) => rows.forEach((r) => (r.hidden = !v)) };
  }

  /** Small grey help text line. */
  hint(text: string): void {
    const h = document.createElement("div");
    h.className = "fd-hint";
    h.textContent = text;
    this.body.appendChild(h);
  }

  /** Error (red) or empty; also enables/disables OK. */
  setError(message: string | null): void {
    this.messageEl.textContent = message ?? "";
    this.okBtn.disabled = message !== null;
  }

  /** Put the caret in the first enabled input. */
  focusFirst(): void {
    const input = this.el.querySelector<HTMLInputElement>("input:not(:disabled)");
    input?.focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.el.remove();
  }
}

// --- Picture-button icons (20x20, stroke = currentColor) ---

const svg = (inner: string): string =>
  `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4">${inner}</svg>`;

export const ICONS = {
  join: svg('<rect x="2" y="8" width="10" height="9"/><rect x="8" y="3" width="10" height="9" fill="currentColor" fill-opacity="0.35"/>'),
  cut: svg('<rect x="2" y="6" width="16" height="11"/><rect x="7" y="3" width="6" height="8" stroke-dasharray="2 1.5" fill="#ff5a5a" fill-opacity="0.45"/>'),
  newBody: svg('<rect x="2" y="9" width="7" height="8"/><rect x="11" y="3" width="7" height="8" fill="currentColor" fill-opacity="0.35"/>'),
  dirOne: svg('<line x1="3" y1="15" x2="17" y2="15"/><line x1="10" y1="15" x2="10" y2="3"/><path d="M7 6 L10 3 L13 6"/>'),
  dirFlip: svg('<line x1="3" y1="5" x2="17" y2="5"/><line x1="10" y1="5" x2="10" y2="17"/><path d="M7 14 L10 17 L13 14"/>'),
  dirSym: svg('<line x1="3" y1="10" x2="17" y2="10"/><line x1="10" y1="2" x2="10" y2="18"/><path d="M7 5 L10 2 L13 5 M7 15 L10 18 L13 15"/>'),
  distance: svg('<line x1="3" y1="17" x2="17" y2="17"/><line x1="3" y1="7" x2="17" y2="7" stroke-dasharray="2 1.5"/><path d="M10 16 L10 8 M8 10 L10 8 L12 10"/>'),
  through: svg('<rect x="5" y="6" width="10" height="8"/><line x1="10" y1="1" x2="10" y2="19"/><path d="M8 17 L10 19 L12 17"/>'),
  toAxis: svg('<circle cx="10" cy="11" r="7"/><line x1="2" y1="11" x2="18" y2="11" stroke-dasharray="1.5 1.5"/><path d="M8.5 1 V11 M11.5 1 V11"/>'),
  chamferEqual: svg('<path d="M3 17 V9 L9 3 H17"/><path d="M3 9 H1 M9 3 V1" stroke-dasharray="1.5 1.5"/>'),
  chamferTwo: svg('<path d="M3 17 V11 L7 3 H17"/><path d="M3 11 H1 M7 3 V1" stroke-dasharray="1.5 1.5"/>'),
  chamferAngle: svg('<path d="M3 17 V9 L9 3 H17"/><path d="M3 9 A5 5 0 0 1 6 12"/>'),
  holeSimple: svg('<path d="M2 4 H7 V17 H13 V4 H18" /><line x1="10" y1="1" x2="10" y2="19" stroke-dasharray="1.5 1.5"/>'),
  holeCbore: svg('<path d="M1 4 H5 V9 H7 V17 H13 V9 H15 V4 H19"/><line x1="10" y1="1" x2="10" y2="19" stroke-dasharray="1.5 1.5"/>'),
  holeCsink: svg('<path d="M1 4 H4 L7 8 V17 H13 V8 L16 4 H19"/><line x1="10" y1="1" x2="10" y2="19" stroke-dasharray="1.5 1.5"/>'),
  revFull: svg('<line x1="10" y1="1" x2="10" y2="19" stroke-dasharray="1.5 1.5"/><ellipse cx="10" cy="10" rx="7.5" ry="3.2"/><path d="M15.5 14.2 L17.4 11.6 L14.2 11.2"/>'),
  revAngle: svg('<line x1="10" y1="1" x2="10" y2="19" stroke-dasharray="1.5 1.5"/><path d="M10 10 L17.5 10 A7.5 3.2 0 0 1 10 13.2 Z" fill="currentColor" fill-opacity="0.35"/><path d="M10 10 L4 7"/>'),
  axisU: svg('<line x1="2" y1="14" x2="18" y2="14"/><path d="M15 11 L18 14 L15 17"/><path d="M6 5 A6 4 0 0 1 14 5" /><path d="M13 3 L14 5 L12 6"/>'),
  axisV: svg('<line x1="6" y1="18" x2="6" y2="2"/><path d="M3 5 L6 2 L9 5"/><path d="M11 6 A4 6 0 0 1 11 14"/><path d="M13 13 L11 14 L10 12"/>'),
};
