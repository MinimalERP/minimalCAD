/**
 * MinimalCAD Web
 * ui/tabBar.ts
 *
 * Renders the horizontal tab strip (#tab-bar in index.html) for multitab
 * support: one tab per open drawing (engine/session.ts's TabSession), a "+"
 * button to open a new blank one, and a "x" per tab to close it. Purely a
 * view over whatever main.ts's TabBarHost reports -- every actual decision
 * (which tab is active, whether closing needs an unsaved-changes confirm,
 * how a just-closed tab picks its successor) lives in main.ts, which is
 * where the array of sessions and "which one is active" already live.
 */

import type { TabSession } from "../engine/session";

export interface TabBarHost {
  getSessions(): TabSession[];
  getActiveId(): string;
  activate(id: string): void;
  createNew(): void;
  close(id: string): void;
  rename(id: string, name: string): void;
}

/** Tab group colours (a model tab + its drawing tab), like browser tab groups. */
const GROUP_COLORS = ["#e8a33d", "#4fb477", "#c678dd", "#e06c75", "#56b6c2", "#d19a66"];

export interface TabBar {
  /** Call after the host's sessions/active-id state changes (new/close/rename/activate). */
  refresh(): void;
}

export function buildTabBar(root: HTMLElement, host: TabBarHost): TabBar {
  function render(): void {
    root.replaceChildren();

    for (const session of host.getSessions()) {
      const tab = document.createElement("div");
      tab.className = session.id === host.getActiveId() ? "tab active" : "tab";
      // A model and its drawing tab: one group, one colour.
      if (session.group !== null) {
        tab.classList.add("grouped");
        tab.style.setProperty("--group-color", GROUP_COLORS[session.group % GROUP_COLORS.length]!);
      }
      if (session.workspace === "drawing") tab.classList.add("drawing");
      // Same focus-steal prevention as toolbar.ts's own buttons -- without
      // it, clicking a tab while a command is mid-flight on another tab
      // would silently steal focus back from the command bar's input field.
      tab.addEventListener("mousedown", (e) => e.preventDefault());
      tab.addEventListener("click", () => host.activate(session.id));

      const nameEl = document.createElement("span");
      nameEl.className = "tab-name";
      nameEl.textContent = session.name;
      nameEl.title = "Double-click to rename";
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const nextName = window.prompt("Rename tab", session.name);
        if (nextName === null) return;
        const trimmed = nextName.trim();
        if (trimmed !== "") host.rename(session.id, trimmed);
      });

      const closeBtn = document.createElement("button");
      closeBtn.className = "tab-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close tab";
      closeBtn.addEventListener("mousedown", (e) => e.preventDefault());
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also activate() the tab being closed
        host.close(session.id);
      });

      tab.append(nameEl, closeBtn);
      root.appendChild(tab);
    }

    const newBtn = document.createElement("button");
    newBtn.className = "tab-new";
    newBtn.title = "New Tab";
    newBtn.setAttribute("aria-label", "New Tab");
    newBtn.textContent = "+";
    newBtn.addEventListener("mousedown", (e) => e.preventDefault());
    newBtn.addEventListener("click", () => host.createNew());
    root.appendChild(newBtn);
  }

  render();
  return { refresh: render };
}
