import { describe, expect, it } from "vitest";
import { commandSuggestions } from "./registry";

describe("typed command suggestions", () => {
  it("prioritizes exact shortcuts and supports full command prefixes", () => {
    expect(commandSuggestions("m")[0]).toBe("move");
    expect(commandSuggestions("mi")[0]).toBe("mirror");
    expect(commandSuggestions("lin")[0]).toBe("line");
    expect(commandSuggestions("pdf")[0]).toBe("pdfexport");
  });

  it("ranks drawing tools before edit tools and other commands", () => {
    expect(commandSuggestions("p")[0]).toBe("polygon");
    expect(commandSuggestions("m")[0]).toBe("move");
    expect(commandSuggestions("pa")[0]).toBe("polararray");
  });

  it("uses the same draw, edit, then other order for 3D commands", () => {
    expect(commandSuggestions("l", "3d")[0]).toBe("line3d");
    expect(commandSuggestions("f", "3d")[0]).toBe("fillet");
    expect(commandSuggestions("s", "3d")[0]).toBe("newsketch");
    expect(commandSuggestions("sheet", "3d")[0]).toBe("sheetmetal");
  });

  it("does not suggest internal grip/edit commands or empty-query noise", () => {
    expect(commandSuggestions("")).toEqual([]);
    expect(commandSuggestions("grip")).toEqual([]);
    expect(commandSuggestions("edit")).toEqual([]);
  });
});
