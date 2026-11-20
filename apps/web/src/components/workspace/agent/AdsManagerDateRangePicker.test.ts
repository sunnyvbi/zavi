import { describe, expect, it } from "vitest";
import {
  RANGE_PRESETS,
  presetRange,
  rangeTriggerLabel,
  resolveWindow,
  ymd,
} from "./AdsManagerDateRangePicker";

const NOW = new Date(2025, 0, 9, 12, 0, 0);

describe("presetRange", () => {
  it("resolves single-day presets to that day", () => {
    expect(presetRange("today", NOW)).toEqual({
      start: new Date(2025, 0, 9),
      end: new Date(2025, 0, 9),
    });
    expect(presetRange("yesterday", NOW)).toEqual({
      start: new Date(2025, 0, 8),
      end: new Date(2025, 0, 8),
    });
  });

  it("resolves rolling-window presets inclusive of today", () => {
    expect(presetRange("last_7d", NOW)).toEqual({
      start: new Date(2025, 0, 3),
      end: new Date(2025, 0, 9),
    });
    expect(presetRange("last_14d", NOW)).toEqual({
      start: new Date(2024, 11, 27),
      end: new Date(2025, 0, 9),
    });
  });

  it("this_month starts on the 1st through today", () => {
    expect(presetRange("this_month", NOW)).toEqual({
      start: new Date(2025, 0, 1),
      end: new Date(2025, 0, 9),
    });
  });

  it("last_month is the full prior calendar month", () => {
    expect(presetRange("last_month", NOW)).toEqual({
      start: new Date(2024, 11, 1),
      end: new Date(2024, 11, 31),
    });
  });
});

describe("resolveWindow", () => {
  const supported = new Set([
    "last_7d",
    "last_14d",
    "last_28d",
    "last_30d",
    "this_month",
    "last_month",
  ]);

  it("maps every preset to a backend-supported window and keeps its label", () => {
    for (const p of RANGE_PRESETS) {
      const { start, end } = presetRange(p.key, NOW);
      const r = resolveWindow(start, end, NOW);
      expect(supported.has(r.key)).toBe(true);
      expect(r.presetLabel).toBe(p.label);
    }
  });

  it("keeps 1:1 presets on their own key + flags them non-custom", () => {
    const m = presetRange("this_month", NOW);
    const rm = resolveWindow(m.start, m.end, NOW);
    expect(rm.key).toBe("this_month");
    expect(rm.isCustom).toBe(false);
    const lm = presetRange("last_month", NOW);
    expect(resolveWindow(lm.start, lm.end, NOW).key).toBe("last_month");
    const l14 = presetRange("last_14d", NOW);
    expect(resolveWindow(l14.start, l14.end, NOW).key).toBe("last_14d");
  });

  it("flags sub-window presets custom so they fetch exact since/until", () => {
    for (const key of ["today", "yesterday", "this_week", "last_week"] as const) {
      const { start, end } = presetRange(key, NOW);
      const r = resolveWindow(start, end, NOW);
      expect(r.isCustom).toBe(true);
    }
    const l7 = presetRange("last_7d", NOW);
    expect(resolveWindow(l7.start, l7.end, NOW).isCustom).toBe(false);
  });

  it("folds a hand-picked custom span to the nearest window + flags it custom", () => {
    const start = new Date(2025, 0, 2);
    const end = new Date(2025, 0, 6);
    const r = resolveWindow(start, end, NOW);
    expect(r.key).toBe("last_7d");
    expect(r.presetLabel).toBe("Custom");
    expect(r.isCustom).toBe(true);
    expect(resolveWindow(new Date(2025, 0, 1), new Date(2025, 0, 20), NOW).key).toBe(
      "last_30d",
    );
  });
});

describe("ymd", () => {
  it("formats a local date as YYYY-MM-DD, zero-padded", () => {
    expect(ymd(new Date(2025, 0, 9))).toBe("2025-01-09");
    expect(ymd(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("rangeTriggerLabel", () => {
  it("shows a single date for one-day ranges", () => {
    const r = resolveWindow(...rangePair("today"), NOW);
    expect(rangeTriggerLabel(r)).toBe("Today: Jan 9, 2025");
  });

  it("shows a start–end range for multi-day windows", () => {
    const r = resolveWindow(...rangePair("this_month"), NOW);
    expect(rangeTriggerLabel(r)).toBe(
      "This month: Jan 1, 2025 – Jan 9, 2025",
    );
  });

  function rangePair(key: Parameters<typeof presetRange>[0]): [Date, Date] {
    const { start, end } = presetRange(key, NOW);
    return [start, end];
  }
});
