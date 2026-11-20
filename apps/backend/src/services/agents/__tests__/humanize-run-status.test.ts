import { describe, it, expect } from "vitest";
import { humanizeRunStatus } from "../humanize-run-status";

describe("humanizeRunStatus — prompt projection only, never the DB", () => {
  it("translates `parse_failed` → 'incomplete output'", () => {
    expect(humanizeRunStatus("parse_failed")).toBe("incomplete output");
  });

  it("translates `dispatch_error` → \"didn't run\"", () => {
    expect(humanizeRunStatus("dispatch_error")).toBe("didn't run");
  });

  it("translates `failed` → 'errored'", () => {
    expect(humanizeRunStatus("failed")).toBe("errored");
  });

  it("passes `success` through unchanged (already benign)", () => {
    expect(humanizeRunStatus("success")).toBe("success");
  });

  it("passes neutral lifecycle statuses through unchanged", () => {
    for (const s of ["queued", "running", "completed", "cancelled", "timed_out"]) {
      expect(humanizeRunStatus(s)).toBe(s);
    }
  });

  it("passes unknown / future statuses through unchanged (default branch)", () => {
    expect(humanizeRunStatus("something_new")).toBe("something_new");
    expect(humanizeRunStatus("")).toBe("");
  });
});
