
import { describe, it, expect, vi } from "vitest";

const cgoAdBudget = vi.fn();
vi.mock("../cgo-ads", () => ({ cgoAdBudget: (...a: unknown[]) => cgoAdBudget(...a) }));
vi.mock("../unattended-policy", () => ({ loadPausedByFounder: vi.fn() }));

import { orderBodyProblem } from "../cgo-order-validate";
import { submitCgoAdAction } from "../cgo-ad-orders";
import { dwellKeyOf, planGapOrders, type AdObject, type Inventory } from "../ad-spend-controller";
import type { SpendPace } from "@/services/growth/spend-pace";

const createAd = (over: Record<string, unknown> = {}) => ({
  ad_set_id: "120000000001",
  primary_text: "Spotless homes, booked in two minutes.",
  headline: "Book a deep clean",
  link_url: "https://fernway-cleaning.example/book",
  cta: "BOOK_TRAVEL",
  source: "copy",
  source_ad_id: "120000000009",
  ...over,
});

describe("orderBodyProblem", () => {
  it("must catch: a call to action the launch ad does not take", async () => {
    expect(await orderBodyProblem("meta_ads.create_ad", createAd({ cta: "WHATSAPP_MESSAGE_NOW" }))).toMatch(/cta/);
  });

  it("must catch: a link that is not https", async () => {
    expect(await orderBodyProblem("meta_ads.create_ad", createAd({ link_url: "http://ledgerly.example/signup" }))).toMatch(/https/);
  });

  it("must catch: a class with no schema here (deny by default)", async () => {
    expect(await orderBodyProblem("meta_ads.delete_campaign", { campaign_id: "1" })).toMatch(/no body check/);
    expect(await orderBodyProblem("reddit_ads.set_status", { id: "1" })).toMatch(/no body check/);
  });

  it("must not catch: a well-formed create_ad", async () => {
    expect(await orderBodyProblem("meta_ads.create_ad", createAd())).toBeNull();
  });

  it("must not catch: a loser-cut pause on each platform", async () => {
    expect(await orderBodyProblem("meta_ads.set_status", { object_id: "120000000002", level: "adset", status: "PAUSED", rationale: "Over the saved cost limit.", over_cap: false })).toBeNull();
    expect(await orderBodyProblem("google_ads.set_status", { campaign_id: "4401", level: "campaign", status: "PAUSED", rationale: "Over the saved cost limit.", over_cap: false })).toBeNull();
  });
});

function adSet(id: string, over: Partial<AdObject> = {}): AdObject {
  return {
    platform: "meta",
    level: "ad_set",
    id,
    campaign_id: "120000000100",
    name: `Ad set ${id}`,
    active: true,
    paused_self: false,
    parent_active: true,
    daily_budget_usd: 20,
    budget_on_campaign: false,
    spend7d_usd: 140,
    spend3d_usd: 60,
    spend_days7d: 7,
    results7d: 7,
    result_kind: "conversions",
    has_live_ads: true,
    has_any_ads: true,
    has_ready_ads: true,
    audience_ids: [],
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}
const BEHIND = { daily_target_usd: 600, required_cumulative_usd: 6000, actual_month_usd: 3000, delivery_debt_usd: 3000, days_left: 20, data_fresh: true } as SpendPace;

describe("every order the gap planner builds passes the executor's schema", () => {
  for (const [shape, objects] of [
    [
      "home-cleaning service",
      {
        meta: {
          connected: true,
          ads: [],
          objects: [
            adSet("120000000101"),
            adSet("120000000200", { level: "campaign", campaign_id: "120000000200" }),
            adSet("120000000102", { campaign_id: "120000000200", budget_on_campaign: true, daily_budget_usd: null }),
            adSet("120000000103", { active: false, paused_self: true, spend7d_usd: 0, spend3d_usd: 0, spend_days7d: 0, results7d: 0 }),
          ],
        },
        google: { connected: true, conversions30d: 12, objects: [adSet("4401", { platform: "google", level: "campaign", campaign_id: "4401" }), adSet("4402", { platform: "google", level: "campaign", campaign_id: "4402", active: false, paused_self: true })] },
      },
    ],
    ["SaaS with sign-ups", { meta: { connected: true, ads: [], objects: [adSet("120000000301", { result_kind: "conversions" }), adSet("120000000302")] }, google: { connected: false, objects: [], conversions30d: null } }],
  ] as Array<[string, Inventory]>) {
    it(shape, async () => {
      const p = planGapOrders({
        pace: BEHIND,
        inv: objects,
        now: new Date("2026-10-10T12:00:00Z"),
        dwell: new Set(),
        recentlyOrdered: new Set(),
        enableSafe: new Set([dwellKeyOf("meta", "120000000103"), dwellKeyOf("google", "4402")]),
      });
      expect(p.orders.length).toBeGreaterThan(0);
      for (const o of p.orders) expect(await orderBodyProblem(o.exec_class, o.body), o.exec_class).toBeNull();
    });
  }
});

describe("submitCgoAdAction refuses an invalid body before anything is read or written", () => {
  it("returns invalid_body and never checks the budget", async () => {
    cgoAdBudget.mockReset();
    const r = await submitCgoAdAction({
      tenant_id: "t1",
      channel_slug: "meta_ads",
      exec_class: "meta_ads.create_ad",
      body: createAd({ link_url: "http://fernway-cleaning.example/book" }),
      reason: "Fresh ad for a tired ad set.",
      idempotency_key: "t1:creative:as1:2026-10-10T12",
    });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/^invalid_body:/) });
    expect(cgoAdBudget).not.toHaveBeenCalled();
  });
});
