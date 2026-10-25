import { describe, expect, it } from "vitest";
import { Undo } from "./undo";
import type { DocumentSnapshot } from "./document";

function snap(n: number): DocumentSnapshot {
  return { entities: [{ type: "line", n }], constraints: [] };
}

describe("Undo", () => {
  it("push then undo returns the pushed snapshot", () => {
    const undo = new Undo();
    undo.push(snap(1));
    const restored = undo.undo(snap(2));
    expect(restored).toEqual(snap(1));
  });

  it("undo with an empty stack returns null", () => {
    const undo = new Undo();
    expect(undo.undo(snap(1))).toBeNull();
  });

  it("undo then redo round-trips back to the state before the undo", () => {
    const undo = new Undo();
    undo.push(snap(1));
    const afterUndo = undo.undo(snap(2))!;
    expect(afterUndo).toEqual(snap(1));
    const afterRedo = undo.redo(afterUndo);
    expect(afterRedo).toEqual(snap(2));
  });

  it("a new push clears the redo stack", () => {
    const undo = new Undo();
    undo.push(snap(1));
    undo.undo(snap(2));
    undo.push(snap(3));
    expect(undo.canRedo()).toBe(false);
  });

  it("skips pushing an exact duplicate of the current top", () => {
    const undo = new Undo();
    undo.push(snap(1));
    undo.push(snap(1));
    // Only one entry pushed -- a single undo should hit the empty floor, not
    // return to snap(1) twice.
    undo.undo(snap(99));
    expect(undo.canUndo()).toBe(false);
  });

  it("compares embedded image snapshots without changing duplicate detection", () => {
    const undo = new Undo();
    const image = "data:image/png;base64," + "a".repeat(1024 * 1024);
    const before: DocumentSnapshot = { entities: [], constraints: [], image_references: [{ data_url: image, opacity: 0.5 }] };
    undo.push(before);
    undo.push({ entities: [], constraints: [], image_references: [{ data_url: image, opacity: 0.5 }] });
    expect(undo.undo({ entities: [], constraints: [] })).toEqual(before);
    expect(undo.canUndo()).toBe(false);
  });

  it("caps the undo stack at 100 entries, evicting the oldest", () => {
    const undo = new Undo();
    for (let i = 0; i < 105; i++) {
      undo.push(snap(i));
    }
    let current: DocumentSnapshot = snap(9999);
    let count = 0;
    let popped: DocumentSnapshot | null;
    while ((popped = undo.undo(current)) !== null) {
      current = popped;
      count++;
    }
    expect(count).toBe(100);
    // Oldest surviving entry should be snap(5) (0..4 evicted).
    expect(current).toEqual(snap(5));
  });

  it("clear() empties both stacks and resets dirty", () => {
    const undo = new Undo();
    undo.push(snap(1));
    undo.clear();
    expect(undo.canUndo()).toBe(false);
    expect(undo.canRedo()).toBe(false);
    expect(undo.dirty).toBe(false);
  });
});
