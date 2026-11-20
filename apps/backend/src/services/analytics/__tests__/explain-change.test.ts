
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import {
  computeContributions,
  confidenceFor,
  pickDrivers,
  explainChange,
  explainCompareWindow,
} from "../explain-change";
import type { FetchResult, MetricImpl, Parts } from "../metric-catalog";
import type { CatalogMetricMeta } from "../metric-registry";

const sessions: MetricImpl["value"] = (p) => p.sessions ?? 0;
const cpa: MetricImpl["value"] = (p) => (p.conversions ? (p.spend ?? 0) / p.conversions : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("computeContributions: additive", () => {
  const cur = { total: { sessions: 700 }, segments: [{ key: "google / organic", parts: { sessions: 300 } }, { key: "direct", parts: { sessions: 250 } }] };
  const prev = { total: { sessions: 1000 }, segments: [{ key: "google / organic", parts: { sessions: 600 } }, { key: "direct", parts: { sessions: 260 } }] };

  it("contributions plus all-other sum EXACTLY to the total change", () => {
    const c = computeContributions(sessions, cur, prev);
    if (!c.ok) throw new Error("not ok");
    expect(c.additive).toBe(true);
    expect(c.total_change).toBe(-300);
    expect(sum(c.segments.map((s) => s.contribution)) + c.other_contribution).toBe(c.total_change);
    const google = c.segments.find((s) => s.key === "google / organic")!;
    expect(google.contribution).toBe(-300);
    expect(google.share).toBe(1);
    expect(c.other_contribution).toBe(10);
  });

  it("sign: a segment that moved against the total gets a negative share", () => {
    const c = computeContributions(
      sessions,
      { total: { sessions: 900 }, segments: [{ key: "a", parts: { sessions: 400 } }, { key: "b", parts: { sessions: 500 } }] },
      { total: { sessions: 1000 }, segments: [{ key: "a", parts: { sessions: 600 } }, { key: "b", parts: { sessions: 400 } }] },
    );
    if (!c.ok) throw new Error("not ok");
    const a = c.segments.find((s) => s.key === "a")!;
    const b = c.segments.find((s) => s.key === "b")!;
    expect(a.share).toBe(2);
    expect(b.share).toBe(-1);
    expect(sum(c.segments.map((s) => s.contribution)) + c.other_contribution).toBe(-100);
  });

  it("a segment present in only one window counts from/to zero", () => {
    const c = computeContributions(
      sessions,
      { total: { sessions: 500 }, segments: [{ key: "new", parts: { sessions: 200 } }] },
      { total: { sessions: 300 }, segments: [{ key: "old", parts: { sessions: 50 } }] },
    );
    if (!c.ok) throw new Error("not ok");
    expect(c.segments.find((s) => s.key === "new")).toMatchObject({ contribution: 200, existed_before: false });
    expect(c.segments.find((s) => s.key === "old")).toMatchObject({ contribution: -50, existed_before: true });
    expect(sum(c.segments.map((s) => s.contribution)) + c.other_contribution).toBe(200);
  });

  it("a zero total change has no shares and no drivers", () => {
    const c = computeContributions(
      sessions,
      { total: { sessions: 100 }, segments: [{ key: "a", parts: { sessions: 60 } }, { key: "b", parts: { sessions: 40 } }] },
      { total: { sessions: 100 }, segments: [{ key: "a", parts: { sessions: 40 } }, { key: "b", parts: { sessions: 60 } }] },
    );
    if (!c.ok) throw new Error("not ok");
    expect(c.total_change).toBe(0);
    expect(c.segments.every((s) => s.share === null)).toBe(true);
    expect(pickDrivers([{ dimension: "source_medium", c }])).toEqual([]);
  });

  it("no value on either side is not ok", () => {
    expect(computeContributions(cpa, { total: {}, segments: [] }, { total: { spend: 1, conversions: 1 }, segments: [] })).toEqual({ ok: false, reason: "no_value" });
  });
});

describe("computeContributions: ratio", () => {
  it("is detected as non-additive and uses put-it-back counterfactuals", () => {
    const c = computeContributions(
      cpa,
      {
        total: { spend: 1000, conversions: 50 },
        segments: [
          { key: "A", parts: { spend: 500, conversions: 10 } },
          { key: "B", parts: { spend: 500, conversions: 40 } },
        ],
      },
      {
        total: { spend: 1000, conversions: 100 },
        segments: [
          { key: "A", parts: { spend: 500, conversions: 60 } },
          { key: "B", parts: { spend: 500, conversions: 40 } },
        ],
      },
    );
    if (!c.ok) throw new Error("not ok");
    expect(c.additive).toBe(false);
    expect(c.total_change).toBe(10);
    const a = c.segments.find((s) => s.key === "A")!;
    const b = c.segments.find((s) => s.key === "B")!;
    expect(a.contribution).toBe(10);
    expect(b.contribution).toBe(0);
    const drivers = pickDrivers([{ dimension: "campaign", c }]);
    expect(drivers[0]).toMatchObject({ segment: "A", share_pct: 100, confidence: "medium" });
  });
});

describe("confidence labels", () => {
  it("high needs 60%+, an additive metric and a segment that already existed", () => {
    expect(confidenceFor(0.6, true, true)).toBe("high");
    expect(confidenceFor(0.59, true, true)).toBe("medium");
    expect(confidenceFor(0.9, true, false)).toBe("medium");
    expect(confidenceFor(0.9, false, true)).toBe("medium");
    expect(confidenceFor(0.3, true, true)).toBe("medium");
    expect(confidenceFor(0.29, true, true)).toBe("low");
  });

  it("drivers are the top 3 across dimensions, only segments that pushed the way it moved", () => {
    const mk = (pairs: Array<[string, number, number]>, total: [number, number]) =>
      computeContributions(
        sessions,
        { total: { sessions: total[0] }, segments: pairs.map(([key, now]) => ({ key, parts: { sessions: now } })) },
        { total: { sessions: total[1] }, segments: pairs.map(([key, , before]) => ({ key, parts: { sessions: before } })) },
      );
    const src = mk([["google / organic", 100, 500], ["direct", 300, 280], ["bing / cpc", 50, 70]], [450, 850]);
    const dev = mk([["mobile", 200, 560], ["desktop", 250, 290]], [450, 850]);
    if (!src.ok || !dev.ok) throw new Error("not ok");
    const d = pickDrivers([
      { dimension: "source_medium", c: src },
      { dimension: "device", c: dev },
    ]);
    expect(d).toHaveLength(3);
    expect(d.map((x) => x.segment)).toEqual(["google / organic", "mobile", "desktop"]);
    expect(d[0]).toMatchObject({ dimension: "source_medium", share_pct: 100, confidence: "high" });
    expect(d[1]).toMatchObject({ dimension: "device", share_pct: 90, confidence: "high" });
    expect(d.some((x) => x.segment === "direct")).toBe(false);
  });
});

describe("explainChange", () => {
  const meta = {
    id: "sessions",
    label: "Sessions",
    unit: "count",
    direction: "up",
    source: "google_analytics",
    needs: ["google_analytics"],
    grains: ["day"],
    breakdowns: ["source_medium", "device"],
    definition: "",
    caveats: [],
  } as unknown as CatalogMetricMeta;

  const NOW = new Date("2026-09-28T15:00:00Z");
  const byDim: Record<string, Record<string, Parts>> = {
    source_medium: { "google / organic": { sessions: 100 }, direct: { sessions: 300 } },
    device: { mobile: { sessions: 150 }, desktop: { sessions: 250 } },
  };
  const byDimPrev: Record<string, Record<string, Parts>> = {
    source_medium: { "google / organic": { sessions: 500 }, direct: { sessions: 300 } },
    device: { mobile: { sessions: 500 }, desktop: { sessions: 300 } },
  };

  function impl(): MetricImpl & { fetch: ReturnType<typeof vi.fn> } {
    const fetch = vi.fn(async (ctx: { breakdown?: string }, w: { since: string }): Promise<FetchResult> => {
      const prev = w.since < "2026-09-27";
      const segs = (prev ? byDimPrev : byDim)[ctx.breakdown!];
      return {
        ok: true,
        daily: [{ date: w.since, parts: { sessions: prev ? 800 : 400 } }],
        breakdown: Object.entries(segs).map(([key, parts]) => ({ key, parts })),
        currency: null,
        row_count: 1,
        truncated: false,
        caveats: [],
        params: {},
      };
    });
    return { value: sessions, fetch } as never;
  }

  it("splits the day by every supported dimension and names the top drivers", async () => {
    const i = impl();
    const out = await explainChange(
      { tenant_id: "tenant-a", tz: "UTC", now: NOW },
      { metric_id: "sessions", window: { since: "2026-09-27", until: "2026-09-27" }, compare: "previous_week" },
      { catalogEntry: () => ({ meta, impl: i }) },
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok" || !("drivers" in out)) return;
    expect(out.compare_window).toEqual({ since: "2026-09-20", until: "2026-09-20" });
    expect(out.total).toBe(400);
    expect(out.compare_total).toBe(800);
    expect(out.change).toBe(-400);
    expect(out.drivers[0]).toMatchObject({ segment: "google / organic", share_pct: 100, confidence: "high" });
    expect(out.dimensions.map((d) => d.dimension)).toEqual(["source_medium", "device"]);
    for (const call of i.fetch.mock.calls) expect(call[0]).toMatchObject({ tenant_id: "tenant-a", grain: "day" });
  });

  it("refuses a point-in-time metric and one with no breakdown", async () => {
    const i = impl();
    const pit = await explainChange({ tenant_id: "t", tz: "UTC", now: NOW }, { metric_id: "mrr" }, {
      catalogEntry: () => ({ meta: { ...meta, id: "mrr", point_in_time: true } as CatalogMetricMeta, impl: i }),
    });
    expect(pit.status).toBe("unsupported");
    const none = await explainChange({ tenant_id: "t", tz: "UTC", now: NOW }, { metric_id: "signups" }, {
      catalogEntry: () => ({ meta: { ...meta, id: "signups", breakdowns: [] } as CatalogMetricMeta, impl: i }),
    });
    expect(none.status).toBe("unsupported");
    const users = await explainChange({ tenant_id: "t", tz: "UTC", now: NOW }, { metric_id: "users" }, {
      catalogEntry: () => ({ meta: { ...meta, id: "users", label: "Users" } as CatalogMetricMeta, impl: i }),
    });
    expect(users.status).toBe("unsupported");
    expect(i.fetch).not.toHaveBeenCalled();
  });

  it("a read failure is a status with its reason, never a number", async () => {
    const fail = { value: sessions, fetch: vi.fn(async (): Promise<FetchResult> => ({ ok: false, reason: "not_connected", message: "Google Analytics is not connected." })) };
    const out = await explainChange({ tenant_id: "t", tz: "UTC", now: NOW }, { metric_id: "sessions" }, { catalogEntry: () => ({ meta, impl: fail }) });
    expect(out.status).toBe("not_connected");
  });
});

describe("explainCompareWindow", () => {
  it("previous_week keeps weekdays aligned", () => {
    expect(explainCompareWindow({ since: "2026-09-27", until: "2026-09-27", tz: "UTC", notes: [] }, "previous_week")).toMatchObject({
      since: "2026-09-20",
      until: "2026-09-20",
    });
    expect(explainCompareWindow({ since: "2026-09-27", until: "2026-09-27", tz: "UTC", notes: [] }, "previous_period")).toMatchObject({
      since: "2026-09-26",
      until: "2026-09-26",
    });
  });
});
