/**
 * MinimalCAD Web
 * testUtils/fakeEngine.ts
 *
 * A real Engine wired to a minimal fake CommandBar (duck-typed to the
 * subset of methods commands actually call) -- lets command state machines
 * be driven and asserted on directly in vitest with no DOM/jsdom needed,
 * exactly the payoff engine/engine.ts's own doc comment calls out.
 */

import { Engine } from "../engine/engine";
import { Viewport } from "../engine/viewport";
import type { CommandBar } from "../ui/commandBar";

function makeFakeCommandBar(): CommandBar {
  // Backed by a real EventTarget (rather than no-op stubs) so tests can
  // exercise commands that listen for the popup's textChanged/
  // suggestionAcceptedContinue events (see commands/insertLib.test.ts) by
  // dispatching them the same way the real CommandBar would.
  const fake = Object.assign(new EventTarget(), {
    setStatus: () => {},
    enableInput: () => {},
    disableInput: () => {},
    clear: () => {},
    text: () => "",
    setValue: () => {},
    setTextToEdit: () => {},
    setReady: () => {},
    enableDualInput: () => {},
    disableDualInput: () => {},
    setLiveValue: () => {},
    setLiveAngle: () => {},
    setSnap: () => {},
    setTypedCommand: () => {},
    setOrtho: () => {},
    showSuggestions: () => {},
    hideSuggestions: () => {},
  });
  return fake as unknown as CommandBar;
}

export function makeTestEngine(): Engine {
  const viewport = new Viewport(
    () => 800,
    () => 600,
  );
  return new Engine(viewport, makeFakeCommandBar(), () => {});
}
