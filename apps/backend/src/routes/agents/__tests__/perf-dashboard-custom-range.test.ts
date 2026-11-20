import { describe, it, expect, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({ rpc }),
}));

import {
  parseCustomRange,
  resolveWindowSpec,
  resolvePerfMarketerDashboard,
  clearCustomLastGood,
  needsAdSetEnrichment,
} from "../dashboard";

const NOW = new Date("2026-07-10T12:00:00Z");

describe("parseCustomRange", () => {
  it("accepts a well-formed inclusive range", () => {
    expect(parseCustomRange("2026-07-03", "2026-07-08", NOW)).toEqual({
      since: "2026-07-03",
      until: "2026-07-08",
    });
  });

  it("accepts a single-day range", () => {
    expect(parseCustomRange("2026-07-05", "2026-07-05", NOW)).toEqual({
      since: "2026-07-05",
      until: "2026-07-05",
    });
  });

  it("clamps a future `until` to today", () => {
    expect(parseCustomRange("2026-07-08", "2026-12-31", NOW)).toEqual({
      since: "2026-07-08",
      until: "2026-07-10",
    });
  });

  it("rejects since > until", () => {
    expect(parseCustomRange("2026-07-08", "2026-07-03", NOW)).toBeNull();
  });

  it("rejects a bad shape / non-string / missing", () => {
    expect(parseCustomRange("2026/07/03", "2026-07-08", NOW)).toBeNull();
    expect(parseCustomRange("2026-7-3", "2026-07-08", NOW)).toBeNull();
    expect(parseCustomRange(undefined, "2026-07-08", NOW)).toBeNull();
    expect(parseCustomRange("2026-07-03", 42, NOW)).toBeNull();
  });

  it("rejects a range wider than the 366-day cap", () => {
    expect(parseCustomRange("2024-01-01", "2026-07-08", NOW)).toBeNull();
  });

  it("rejects a range whose start is after today once until is clamped", () => {
    expect(parseCustomRange("2026-08-01", "2026-08-10", NOW)).toBeNull();
  });
});

describe("parseCustomRange across time zones", () => {
  it("a browser already on tomorrow's date that picks its own today gets UTC today, not the preset", () => {
    expect(parseCustomRange("2026-07-11", "2026-07-11", NOW)).toEqual({ since: "2026-07-10", until: "2026-07-10" });
  });

  it("a range that ends on the browser's today is cut at UTC today and keeps its start", () => {
    expect(parseCustomRange("2026-07-05", "2026-07-11", NOW)).toEqual({ since: "2026-07-05", until: "2026-07-10" });
  });

  it("a start two or more days ahead is still refused", () => {
    expect(parseCustomRange("2026-07-12", "2026-07-12", NOW)).toBeNull();
  });
});

describe("resolveWindowSpec", () => {
  it("uses the preset row when no custom range", () => {
    const spec = resolveWindowSpec("last_14d", null);
    expect(spec.key).toBe("last_14d");
    expect(spec.meta).toBe("last_14d");
    expect(spec.google).toBe("LAST_14_DAYS");
    expect(spec.days).toBe(14);
    expect(spec.range).toBeNull();
  });

  it("switches to a custom spec (key=custom, label, day count) when a range is set", () => {
    const spec = resolveWindowSpec("this_month", {
      since: "2026-07-03",
      until: "2026-07-08",
    });
    expect(spec.key).toBe("custom");
    expect(spec.range).toEqual({ since: "2026-07-03", until: "2026-07-08" });
    expect(spec.days).toBe(6);
    expect(spec.label).toBe("Jul 3, 2026 – Jul 8, 2026");
  });

  it("labels a single-day custom range without a dash", () => {
    const spec = resolveWindowSpec("last_7d", {
      since: "2026-07-05",
      until: "2026-07-05",
    });
    expect(spec.label).toBe("Jul 5, 2026");
    expect(spec.days).toBe(1);
  });
});

describe("resolvePerfMarketerDashboard — custom range bypasses the cache", () => {
  it("does a live build and never reads/writes the snapshot", async () => {
    rpc.mockReset();
    const read = { connected: true, rows: [], read_at: new Date().toISOString(), daily: null };
    const build = vi.fn(async () => ({
      payload: { window: "custom", campaigns: [] },
      reads: {
        meta: { ...read, placements: [], pixel_status: null },
        google: { ...read, networks: [] },
      },
    }));
    const spec = resolveWindowSpec("this_month", {
      since: "2026-07-03",
      until: "2026-07-08",
    });
    const out = await resolvePerfMarketerDashboard(
      { tenant_id: "t-1", access_token: "tok" },
      "performance-marketer",
      spec,
      false,
      build,
    );
    expect(build).toHaveBeenCalledOnce();
    expect(out.cached).toBe(false);
    expect(out.stale).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("resolvePerfMarketerDashboard — custom range keeps last-good per channel", () => {
  const good = (spend: number) => ({
    connected: true,
    rows: [{ campaign_id: "c1", spend_usd: spend }],
    read_at: new Date().toISOString(),
    daily: null,
    placements: [],
    pixel_status: null,
  });
  const google = { connected: false, rows: [], read_at: new Date().toISOString(), daily: null, networks: [] };
  const throttled = {
    connected: true,
    rows: [],
    read_at: new Date().toISOString(),
    daily: null,
    placements: [],
    pixel_status: null,
    error: { code: "meta_ads_busy", message: "Meta is busy for 5 min; try again after 10:14 UTC" },
  };
  const buildWith = (live: unknown) =>
    vi.fn(async (_a: unknown, _s: string, _spec: unknown, reuse: Record<string, unknown> = {}) => {
      const reads = { ...(live as Record<string, unknown>), ...reuse };
      return { payload: { reads }, reads } as never;
    });
  const auth = { tenant_id: "t-lg", access_token: "tok" };
  const spec = resolveWindowSpec("last_7d", { since: "2026-07-03", until: "2026-07-03" });

  it("serves the previous good Meta read when a later read of the same range is throttled", async () => {
    clearCustomLastGood();
    await resolvePerfMarketerDashboard(auth, "performance-marketer", spec, false, buildWith({ meta: good(42), google }));
    const out = await resolvePerfMarketerDashboard(
      auth, "performance-marketer", spec, true, buildWith({ meta: throttled, google }),
    );
    expect(out.servedLastGood).toBe(true);
    expect(out.servedLastGoodChannels).toEqual(["meta"]);
    expect(out.channelErrors?.meta?.code).toBe("meta_ads_busy");
    expect((out.adData as { reads: { meta: { rows: unknown[] } } }).reads.meta.rows).toEqual(good(42).rows);
  });

  it("never serves another tenant's or another range's read", async () => {
    clearCustomLastGood();
    await resolvePerfMarketerDashboard(auth, "performance-marketer", spec, false, buildWith({ meta: good(42), google }));
    const other = await resolvePerfMarketerDashboard(
      { tenant_id: "t-other", access_token: "tok" }, "performance-marketer", spec, true, buildWith({ meta: throttled, google }),
    );
    expect(other.servedLastGood).toBe(false);
    const otherRange = resolveWindowSpec("last_7d", { since: "2026-07-04", until: "2026-07-04" });
    const out = await resolvePerfMarketerDashboard(
      auth, "performance-marketer", otherRange, true, buildWith({ meta: throttled, google }),
    );
    expect(out.servedLastGood).toBe(false);
  });

  it("does not hide a reconnect-required error behind last-good", async () => {
    clearCustomLastGood();
    await resolvePerfMarketerDashboard(auth, "performance-marketer", spec, false, buildWith({ meta: good(42), google }));
    const expired = { ...throttled, error: { code: "meta_ads_token_expired", message: "expired" } };
    const out = await resolvePerfMarketerDashboard(
      auth, "performance-marketer", spec, true, buildWith({ meta: expired, google }),
    );
    expect(out.servedLastGood).toBe(false);
  });
});

describe("needsAdSetEnrichment", () => {
  it("skips a stopped campaign with no spend in the window", () => {
    expect(needsAdSetEnrichment({ status: "PAUSED", spend_usd: 0 })).toBe(false);
    expect(needsAdSetEnrichment({ status: "ARCHIVED", spend_usd: 0 })).toBe(false);
  });

  it("reads a live campaign, a stopped one that spent, and an unknown status", () => {
    expect(needsAdSetEnrichment({ status: "ACTIVE", spend_usd: 0 })).toBe(true);
    expect(needsAdSetEnrichment({ status: "PAUSED", spend_usd: 12.5 })).toBe(true);
    expect(needsAdSetEnrichment({ status: null, spend_usd: 0 })).toBe(true);
    expect(needsAdSetEnrichment({ status: "WITH_ISSUES", spend_usd: 0 })).toBe(true);
  });
});
