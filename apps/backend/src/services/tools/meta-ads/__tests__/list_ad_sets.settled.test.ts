import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fb = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../_client", async (orig) => ({
  ...(await orig<typeof import("../_client")>()),
  fbGet: fb.get,
  fbGetAllPages: vi.fn(async () => []),
  metaAdsCreds: vi.fn(async () => ({ ad_account_id: "act_1" })),
}));

import { metaListAdSetsTool, settledThroughDate, settledWindow } from "../list_ad_sets";
import { DEFAULT_LAG_HOURS } from "@/services/growth/perf-brief/brief";

const NOW = new Date("2026-10-22T16:00:00Z");
const ctx = { tenant_id: "t1" } as never;

function graph(insightsParams: Array<Record<string, unknown>>) {
  fb.get.mockImplementation(async (_t: string, path: string, params: Record<string, unknown>) => {
    if (path === "act_1/insights") {
      insightsParams.push(params);
      return { data: [{ adset_id: "as1", adset_name: "Rentals", campaign_id: "c1", spend: "100", actions: [] }] };
    }
    if (path === "c1/adsets") return { data: [{ id: "as1", name: "Rentals", campaign_id: "c1" }] };
    if (path === "") {
      expect(String(params.fields)).toContain("learning_stage_info");
      expect(String(params.fields)).toContain("updated_time");
      return { as1: { daily_budget: "14900", status: "ACTIVE", learning_stage_info: { status: "LEARNING" }, updated_time: "2026-10-20T10:00:00+0000" } };
    }
    if (path === "act_1") return { currency: "USD" };
    throw new Error(`unexpected path ${path}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fb.get.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the settled day", () => {
  it("is the day before analyst_brief's cutoff (now - DEFAULT_LAG_HOURS)", () => {
    expect(DEFAULT_LAG_HOURS).toBe(72);
    expect(settledThroughDate(NOW)).toBe("2026-10-18");
  });

  it("a last-N preset keeps its length and ends on the settled day; a month preset stops there", () => {
    expect(settledWindow("last_7d", NOW)).toEqual({ since: "2026-10-12", until: "2026-10-18" });
    expect(settledWindow("last_30d", NOW)).toEqual({ since: "2026-09-19", until: "2026-10-18" });
    expect(settledWindow("this_month", NOW)).toEqual({ since: "2026-10-01", until: "2026-10-18" });
    const early = new Date("2026-10-02T12:00:00Z");
    expect(settledWindow("this_month", early)).toEqual({ since: "2026-10-01", until: "2026-10-02" });
  });
});

describe("meta_ads_list_ad_sets", () => {
  it("with no window given, reads insights through the settled day and says so; maps learning and days since edit", async () => {
    const seen: Array<Record<string, unknown>> = [];
    graph(seen);
    const out = (await metaListAdSetsTool.execute(ctx, { campaign_id: "c1" })) as Record<string, unknown>;
    expect(JSON.parse(String(seen[0]!.time_range))).toEqual({ since: "2026-09-19", until: "2026-10-18" });
    expect(out.time_range).toEqual({ since: "2026-09-19", until: "2026-10-18" });
    expect(out.settled_through).toBe("2026-10-18");
    const row = (out.ad_sets as Array<Record<string, unknown>>)[0]!;
    expect(row).toMatchObject({ ad_set_id: "as1", daily_budget_usd: 149, learning: true, learning_status: "LEARNING", days_since_edit: 2 });
  });

  it("through the MCP seam (input_schema.parse before execute), an unset window still ends on the settled day", async () => {
    const seen: Array<Record<string, unknown>> = [];
    graph(seen);
    const parsed = metaListAdSetsTool.input_schema.parse({ campaign_id: "c1" });
    await metaListAdSetsTool.execute(ctx, parsed);
    expect(JSON.parse(String(seen[0]!.time_range))).toEqual({ since: "2026-09-19", until: "2026-10-18" });
  });

  it("a caller that names a window gets exactly that window (the dashboard, a recency read)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    graph(seen);
    await metaListAdSetsTool.execute(ctx, { campaign_id: "c1", date_preset: "last_7d" });
    expect(JSON.parse(String(seen[0]!.time_range))).toEqual({ since: "2026-10-15", until: "2026-10-21" });
    await metaListAdSetsTool.execute(ctx, { campaign_id: "c1", time_range: { since: "2026-10-01", until: "2026-10-21" } });
    expect(JSON.parse(String(seen[1]!.time_range))).toEqual({ since: "2026-10-01", until: "2026-10-21" });
  });

  it("learning and days since edit are null when Meta does not say", async () => {
    fb.get.mockImplementation(async (_t: string, path: string) => {
      if (path === "act_1/insights") return { data: [{ adset_id: "as2", campaign_id: "c1", spend: "0" }] };
      if (path === "c1/adsets") return { data: [] };
      if (path === "") return { as2: { status: "PAUSED" } };
      return { currency: "USD" };
    });
    const out = (await metaListAdSetsTool.execute(ctx, { campaign_id: "c1" })) as { ad_sets: Array<Record<string, unknown>> };
    expect(out.ad_sets[0]).toMatchObject({ learning: null, learning_status: null, days_since_edit: null });
  });
});
