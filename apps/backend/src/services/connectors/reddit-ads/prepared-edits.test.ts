import { describe, expect, it, vi } from "vitest";
const page = vi.hoisted(() => ({ rows: [] as unknown[], ranges: [] as Array<[number, number]> }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({ from: () => { const q: Record<string, unknown> = {}; for (const m of ["select", "eq", "or", "order"]) q[m] = () => q; q.range = async (a: number, b: number) => { page.ranges.push([a, b]); return { data: page.rows.slice(a, b + 1), error: null }; }; return q; } }),
}));
import { adoptPreparedEdit, applyPreparedEdit, checkPreparedEdit, preparedKeyFor, readPreparedRows } from "./prepared-edits";
import type { CampaignPlan } from "./schema";

const plan = {
  ad_account_id: "a2_1", name: "Test", rationale: "r", origin: "specialist", operation_key: "op_key_123", profile_id: "t2_p", pixel_id: "px_1",
  objective: "CLICKS", daily_budget_usd: 5, lifetime_cap_usd: 100, start_time: "2026-11-01T00:00:00Z",
  targeting: { geolocations: ["US"], communities: [], interests: [], locations: ["FEED"], expand_targeting: false },
  creatives: [
    { name: "First ad", headline: "Rent a car", image_url: "https://x.test/a.png", destination_url: "https://x.test/1", allow_comments: false },
    { name: "Second ad", headline: "Drive today", image_url: "https://x.test/b.png", destination_url: "https://x.test/2", allow_comments: false },
  ],
} as CampaignPlan;

const rows = [
  { operation_key: "prepared", step: "manifest", result: { id: "c1", group: { id: "g1" }, ads: [{ id: "ad1" }, { id: "ad2" }] } },
  { operation_key: "launched", step: "manifest", result: { id: "c2", group: { id: "g2" }, ads: [{ id: "ad3" }] } },
  { operation_key: "launched", step: "enable_c2", result: { id: "c2" } },
];

describe("an approved edit on a prepared campaign", () => {
  it("finds the prepared, not yet launched, operation that owns the object", () => {
    expect(preparedKeyFor(rows, { kind: "budget", ad_group_id: "g1", daily_budget_usd: 6 })).toBe("prepared");
    expect(preparedKeyFor(rows, { kind: "destination", ad_id: "ad2", destination_url: "https://x.test/2?utm_source=reddit" })).toBe("prepared");
    expect(preparedKeyFor(rows, { kind: "budget", ad_group_id: "g2", daily_budget_usd: 6 })).toBeNull();
    expect(preparedKeyFor(rows, { kind: "budget", ad_group_id: "other", daily_budget_usd: 6 })).toBeNull();
  });

  it("carries the new budget, targeting or destination into the stored plan", () => {
    expect(applyPreparedEdit(plan, ["ad1", "ad2"], { kind: "budget", ad_group_id: "g1", daily_budget_usd: 6 }).daily_budget_usd).toBe(6);
    const targeting = { ...plan.targeting, geolocations: ["CA"] };
    expect(applyPreparedEdit(plan, ["ad1", "ad2"], { kind: "targeting", ad_group_id: "g1", targeting }).targeting.geolocations).toEqual(["CA"]);
    const moved = applyPreparedEdit(plan, ["ad1", "ad2"], { kind: "destination", ad_id: "ad2", destination_url: "https://x.test/2?utm_source=reddit" });
    expect(moved.creatives.map((c) => [c.destination_url, c.click_url])).toEqual([["https://x.test/1", undefined], ["https://x.test/2", "https://x.test/2?utm_source=reddit"]]);
    const back = applyPreparedEdit(moved, ["ad1", "ad2"], { kind: "destination", ad_id: "ad2", destination_url: "https://x.test/2" });
    expect("click_url" in back.creatives[1]).toBe(false);
  });

  it("re-verifies and saves only for a prepared operation", async () => {
    const adopt = vi.fn(async () => {});
    const deps = { rows: async () => rows, load: async () => ({ plan, adIds: ["ad1", "ad2"] }), adopt };
    expect(await adoptPreparedEdit("t1", {} as never, { kind: "budget", ad_group_id: "g1", daily_budget_usd: 6 }, deps)).toBe("prepared");
    expect(adopt).toHaveBeenCalledWith("t1", {}, "prepared", expect.any(Function));
    const next = (adopt.mock.calls[0] as unknown as [string, unknown, string, (p: CampaignPlan, ids: string[]) => CampaignPlan])[3];
    expect(next(plan, ["ad1", "ad2"]).daily_budget_usd).toBe(6);
    adopt.mockClear();
    expect(await adoptPreparedEdit("t1", {} as never, { kind: "budget", ad_group_id: "g2", daily_budget_usd: 6 }, deps)).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("finds a renamed campaign, ad group or ad and keeps the plan as approved", () => {
    expect(preparedKeyFor(rows, { kind: "refresh", level: "campaign", object_id: "c1" })).toBe("prepared");
    expect(preparedKeyFor(rows, { kind: "refresh", level: "ad", object_id: "ad1" })).toBe("prepared");
    expect(preparedKeyFor(rows, { kind: "refresh", level: "campaign", object_id: "c2" })).toBeNull();
    expect(applyPreparedEdit(plan, ["ad1", "ad2"], { kind: "refresh", level: "campaign", object_id: "c1" })).toBe(plan);
  });

  it("refuses, before any write, a change that would leave the prepared plan invalid", async () => {
    const deps = { rows: async () => rows, load: async () => ({ plan, adIds: ["ad1", "ad2"] }), adopt: vi.fn() };
    expect(await checkPreparedEdit("t1", { kind: "budget", ad_group_id: "g1", daily_budget_usd: 6 }, deps)).toBe("prepared");
    await expect(checkPreparedEdit("t1", { kind: "budget", ad_group_id: "g1", daily_budget_usd: 150 }, deps)).rejects.toMatchObject({ code: "reddit_ads_invalid_request" });
    expect(await checkPreparedEdit("t1", { kind: "budget", ad_group_id: "g2", daily_budget_usd: 150 }, deps)).toBeNull();
  });
});

describe("finding the prepared campaign", () => {
  it("reads every page, so an older unlaunched campaign is still found", async () => {
    page.rows = [...Array.from({ length: 1500 }, (_, i) => ({ operation_key: `other_${i}`, step: "manifest", result: { id: `c_${i}`, group: { id: `g_${i}` }, ads: [] } })), rows[0]];
    page.ranges = [];
    const all = await readPreparedRows("t");
    expect(page.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(preparedKeyFor(all, { kind: "budget", ad_group_id: "g1", daily_budget_usd: 6 })).toBe("prepared");
  });
});
