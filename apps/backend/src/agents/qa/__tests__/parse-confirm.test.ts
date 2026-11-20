import { describe, it, expect } from "vitest";
import { parseConfirmTurn } from "../parse-confirm";

describe("parseConfirmTurn", () => {
  it("parses 'add 1' to a single index", () => {
    expect(parseConfirmTurn("add 1")).toEqual({ kind: "add_indices", indices: [1] });
  });

  it("parses 'add 1, 3' to multiple indices", () => {
    expect(parseConfirmTurn("add 1, 3")).toEqual({ kind: "add_indices", indices: [1, 3] });
  });

  it("parses 'insert 2,4' (no space, insert verb)", () => {
    expect(parseConfirmTurn("insert 2,4")).toEqual({ kind: "add_indices", indices: [2, 4] });
  });

  it("de-dupes 'add 1, 1' to [1] preserving order", () => {
    expect(parseConfirmTurn("add 1, 1")).toEqual({ kind: "add_indices", indices: [1] });
  });

  it("de-dupes 'add 3, 1, 3' to [3, 1] (first-occurrence order)", () => {
    expect(parseConfirmTurn("add 3, 1, 3")).toEqual({ kind: "add_indices", indices: [3, 1] });
  });

  it("parses 'add all'", () => {
    expect(parseConfirmTurn("add all")).toEqual({ kind: "add_all" });
  });

  it("parses 'insert all'", () => {
    expect(parseConfirmTurn("insert all")).toEqual({ kind: "add_all" });
  });

  it("parses 'skip'", () => {
    expect(parseConfirmTurn("skip")).toEqual({ kind: "skip" });
  });

  it("parses 'none' / 'cancel' / 'no' as skip", () => {
    expect(parseConfirmTurn("none")).toEqual({ kind: "skip" });
    expect(parseConfirmTurn("cancel")).toEqual({ kind: "skip" });
    expect(parseConfirmTurn("no")).toEqual({ kind: "skip" });
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(parseConfirmTurn("  ADD 1, 3  ")).toEqual({ kind: "add_indices", indices: [1, 3] });
    expect(parseConfirmTurn("Skip")).toEqual({ kind: "skip" });
  });

  it("treats 'first two' as unparsable (LLM fallback)", () => {
    expect(parseConfirmTurn("first two")).toEqual({ kind: "unparsable" });
  });

  it("treats 'yes please add the first two' as unparsable", () => {
    expect(parseConfirmTurn("yes please add the first two")).toEqual({ kind: "unparsable" });
  });

  it("treats 'add 0' as unparsable (1-based; 0 filtered to empty)", () => {
    expect(parseConfirmTurn("add 0")).toEqual({ kind: "unparsable" });
  });

  it("treats empty string as unparsable", () => {
    expect(parseConfirmTurn("")).toEqual({ kind: "unparsable" });
  });

  it("treats 'add 1 and 3' as unparsable (P3 nit — not in grammar)", () => {
    expect(parseConfirmTurn("add 1 and 3")).toEqual({ kind: "unparsable" });
  });
});
