import { describe, it, expect } from "vitest";
import { fileActionClass, changedFilesLabel } from "./refineFiles";

describe("refineFiles changelog helpers (Gap #2)", () => {
  it("maps known file actions to their palette color", () => {
    expect(fileActionClass("create")).toBe("text-emerald-700");
    expect(fileActionClass("modify")).toBe("text-amber-700");
    expect(fileActionClass("delete")).toBe("text-rose-700");
  });

  it("falls back to muted for an unknown action (never un-styled)", () => {
    expect(fileActionClass("rename")).toBe("text-inkMuted");
    expect(fileActionClass("")).toBe("text-inkMuted");
  });

  it("pluralizes the changelog header by file count", () => {
    expect(changedFilesLabel(1)).toBe("Changed 1 file");
    expect(changedFilesLabel(3)).toBe("Changed 3 files");
    expect(changedFilesLabel(0)).toBe("Changed 0 files");
  });
});
