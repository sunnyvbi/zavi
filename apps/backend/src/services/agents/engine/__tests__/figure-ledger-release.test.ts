import { describe, it, expect } from "vitest";
import { recordFigures, releaseRunFigures, ledgerIsEmpty, figureWasRead } from "../figure-ledger";

describe("releaseRunFigures", () => {
  it("must-catch: a finished run's ledger is gone (no waiting for LRU eviction)", () => {
    recordFigures("run-done", "revenue 48,213 last week");
    expect(figureWasRead("run-done", "48,213")).toBe(true);
    expect(releaseRunFigures("run-done", "success")).toBe(true);
    expect(ledgerIsEmpty("run-done")).toBe(true);
  });
  it("must-catch: an unknown status releases", () => {
    recordFigures("run-unknown", "7,331 bookings");
    expect(releaseRunFigures("run-unknown", null)).toBe(true);
    expect(ledgerIsEmpty("run-unknown")).toBe(true);
  });
  it("must-not-catch: a paused run keeps its ledger for the resume", () => {
    for (const status of ["paused_awaiting_approval", "paused_awaiting_child"]) {
      recordFigures(`run-${status}`, "1,204 hosts");
      expect(releaseRunFigures(`run-${status}`, status)).toBe(false);
      expect(ledgerIsEmpty(`run-${status}`)).toBe(false);
    }
  });
});
