import { describe, expect, it, vi } from "vitest";
import {
  mergeRollupDays,
  outcomeFingerprint,
  refreshOutcomeRollup,
  rollupIsStale,
  rollupNeedsRebuild,
  usableRollup,
  type OutcomeRollup,
  type RefreshDeps,
} from "../outcome-rollup";
import { sweepOutcomeRollups } from "@/../workers/functions/outcome-rollup-refresh";
import { MAP, TZ } from "./outcomes-fixture";

const NOW = new Date("2026-10-15T20:00:00Z");

function row(over: Partial<OutcomeRollup> = {}): OutcomeRollup {
  return { basis: outcomeFingerprint(MAP, TZ), through_day: "2026-10-14", first_seen_floor: null, source_watermark: "7|1|2", days: [], refreshed_at: NOW.toISOString(), ...over };
}

describe("outcome rollup", () => {
  it("is used only under the same map + zone and when it covers the window", () => {
    expect(usableRollup(row(), MAP, TZ, "2026-10-14", "7|1|2", NOW)).not.toBeNull();
    expect(usableRollup(row(), MAP, TZ, "2026-10-14", "7|9|2", NOW)).toBeNull();
    expect(usableRollup(row(), MAP, TZ, "2026-10-15", "7|1|2", NOW)).toBeNull();
    expect(usableRollup(row(), MAP, "UTC", "2026-10-10", "7|1|2", NOW)).toBeNull();
    expect(usableRollup(row(), { ...MAP, terminal_statuses: ["completed"] }, TZ, "2026-10-10", "7|1|2", NOW)).toBeNull();
    expect(usableRollup(row(), { ...MAP, outcome_confirmed_at: "2026-10-16T00:00:00Z" }, TZ, "2026-10-10", "7|1|2", NOW)).toBeNull();
  });

  it("is stale when missing, under another map, or not through yesterday", () => {
    expect(rollupIsStale(null, MAP, TZ, NOW)).toBe(true);
    expect(rollupIsStale(row(), MAP, TZ, NOW)).toBe(false);
    expect(rollupIsStale(row({ through_day: "2026-10-13" }), MAP, TZ, NOW)).toBe(true);
    expect(rollupIsStale(row({ basis: "old" }), MAP, TZ, NOW)).toBe(true);
  });

  it("refresh computes through yesterday (local) and writes one row with merged days", async () => {
    const write = vi.fn(async () => undefined);
    const compute = vi.fn(async (_t: string, _m: unknown, _tz: string, _until: Date) => ({
      first: [
        { date: "2026-10-04", customers: 1 },
        { date: "2026-10-15", customers: 9 },
      ],
      unplaced: [{ d: "2026-10-02", u_cac: 1, u_roas: 1, pos: 80, neg: 0, unr: 0 }],
      floor: "2026-09-03T18:00:00.000Z",
      source_watermark: "7|1|2",
    }));
    const deps: RefreshDeps = { getOutcomeMap: vi.fn(async () => ({ ok: true as const, map: MAP })), compute, write, now: () => NOW };
    const out = await refreshOutcomeRollup("t1", TZ, deps);
    expect(out?.through_day).toBe("2026-10-14");
    expect(compute.mock.calls[0][3]).toEqual(new Date("2026-10-15T07:00:00Z"));
    expect(out?.days).toEqual([
      { d: "2026-10-02", first: 0, u_cac: 1, u_roas: 1, pos: 80, neg: 0, unr: 0 },
      { d: "2026-10-04", first: 1, u_cac: 0, u_roas: 0, pos: 0, neg: 0, unr: 0 },
    ]);
    expect(write).toHaveBeenCalledWith("t1", out);
  });

  it("refresh does nothing for an unconfirmed map", async () => {
    const write = vi.fn();
    const out = await refreshOutcomeRollup("t1", TZ, {
      getOutcomeMap: vi.fn(async () => ({ ok: false as const, missing: ["customer_ref_field"], message: "" })),
      compute: vi.fn(),
      write,
      now: () => NOW,
    });
    expect(out).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it("merge keeps first-finish and unplaced facts of the same day together", () => {
    expect(mergeRollupDays([{ date: "2026-10-02", customers: 2 }], [{ d: "2026-10-02", u_cac: 1, u_roas: 0, pos: 0, neg: 0, unr: 0 }])).toEqual([
      { d: "2026-10-02", first: 2, u_cac: 1, u_roas: 0, pos: 0, neg: 0, unr: 0 },
    ]);
  });

  it("the hourly sweep rebuilds only stale tenants and keeps going past a failure", async () => {
    const refresh = vi.fn(async (t: string) => {
      if (t === "bad") throw new Error("db down");
    });
    const r = await sweepOutcomeRollups({
      listTenants: async () => ["fresh", "stale", "bad"],
      tzOf: async () => TZ,
      isStale: async (t) => t !== "fresh",
      refresh,
      now: () => NOW,
    });
    expect(r).toEqual({ checked: 3, refreshed: 1, errors: 1 });
    expect(refresh.mock.calls.map((c) => c[0])).toEqual(["stale", "bad"]);
  });

  it("needs a rebuild when the data watermark moved even though the day is current", async () => {
    const base = { getOutcomeMap: async () => ({ ok: true as const, map: MAP }), readRollup: async () => row() };
    expect(await rollupNeedsRebuild("t1", TZ, NOW, { ...base, liveWatermark: async () => "7|1|2" })).toBe(false);
    expect(await rollupNeedsRebuild("t1", TZ, NOW, { ...base, liveWatermark: async () => "8|1|2" })).toBe(true);
    expect(await rollupNeedsRebuild("t1", TZ, NOW, { ...base, readRollup: async () => null, liveWatermark: async () => "7|1|2" })).toBe(true);
  });

  it("a rollup older than the max age is neither used nor current (catches an order moved to another customer)", () => {
    const old = row({ refreshed_at: new Date(NOW.getTime() - 7 * 3600_000).toISOString() });
    expect(usableRollup(old, MAP, TZ, "2026-10-14", "7|1|2", NOW)).toBeNull();
    expect(rollupIsStale(old, MAP, TZ, NOW)).toBe(true);
  });
});
