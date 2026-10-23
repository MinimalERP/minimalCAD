import { describe, expect, it } from "vitest";
import { commandSuggestions } from "./registry";

describe("typed command suggestions", () => {
  it("prioritizes exact shortcuts and supports full command prefixes", () => {
    expect(commandSuggestions("m")[0]).toBe("move");
    expect(commandSuggestions("mi")[0]).toBe("mirror");
    expect(commandSuggestions("lin")[0]).toBe("line");
    expect(commandSuggestions("pdf")[0]).toBe("pdfexport");
  });

  it("does not suggest internal grip/edit commands or empty-query noise", () => {
    expect(commandSuggestions("")).toEqual([]);
    expect(commandSuggestions("grip")).toEqual([]);
    expect(commandSuggestions("edit")).toEqual([]);
  });
});
