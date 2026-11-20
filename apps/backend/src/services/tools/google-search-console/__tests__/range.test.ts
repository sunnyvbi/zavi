
import { describe, it, expect } from "vitest";
import { previousWindow, windowDays, resolveRange } from "../_range";

describe("_range", () => {
  it("counts an inclusive window (a single day is 1, not 0)", () => {
    expect(windowDays({ startDate: "2026-09-01", endDate: "2026-09-01", label: "" })).toBe(1);
    expect(windowDays({ startDate: "2026-08-05", endDate: "2026-09-01", label: "" })).toBe(28);
  });

  it("puts the previous window immediately before, same length, no gap or overlap", () => {
    const current = { startDate: "2026-08-05", endDate: "2026-09-01", label: "" };
    const prev = previousWindow(current);
    expect(prev.endDate).toBe("2026-08-04");
    expect(windowDays(prev)).toBe(windowDays(current));
    expect(prev.startDate).toBe("2026-07-08");
  });

  it("handles a month boundary without drifting", () => {
    const prev = previousWindow({ startDate: "2026-03-01", endDate: "2026-03-07", label: "" });
    expect(prev).toMatchObject({ startDate: "2026-02-22", endDate: "2026-02-28" });
  });

  it("never ends a default window today — GSC data lags", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(resolveRange("LAST_28_DAYS").endDate).not.toBe(today);
  });

  it("takes a custom range verbatim", () => {
    expect(resolveRange("LAST_7_DAYS", { since: "2026-01-01", until: "2026-01-31" })).toMatchObject({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      label: "2026-01-01..2026-01-31",
    });
  });
});
