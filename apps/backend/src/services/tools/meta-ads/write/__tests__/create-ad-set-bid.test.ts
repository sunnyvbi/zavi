
import { beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => ({ fbGet: vi.fn(), fbPost: vi.fn(), setting: vi.fn() }));
vi.mock("../../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  fbGetAllPages: async (t: string, path: string, params: Record<string, unknown>) => {
    const out: unknown[] = [];
    let after: string | undefined;
    for (;;) {
      const j = (await g.fbGet(t, path, after ? { ...params, after } : params)) as { data?: unknown[]; paging?: { next?: string; cursors?: { after?: string } } };
      out.push(...(j.data ?? []));
      if (!j.paging?.next) return out;
      after = j.paging.cursors?.after;
    }
  },
  fbPost: (...a: unknown[]) => g.fbPost(...a),
  getAdAccountCurrency: async () => "USD",
  metaAdsCreds: async () => ({ ad_account_id: "act_900", access_token: "t" }),
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: (...a: unknown[]) => g.setting(...a) }));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: async () => true }));
vi.mock("../cap-reader", () => {
  const m = { readTenantCapAndToday: async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 }) };
  return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday };
});

import { metaCreateAdSet } from "../create_ad_set";
import { pickSiblingBid, resolveCreateAdSetBid } from "../_ad-set-bid";
import { createAdSetBodySchema, type CreateAdSetBody } from "../_decision-bodies";
import { metaChangeRows } from "../_change-rows";
import { metaProposeNewAdSetTool } from "../propose_new_ad_set";
import { decisionConsequence } from "@/services/approvals/decision-copy";
import type { ToolContext } from "@/services/tools/types";
import { verdictFor } from "@/services/channels/exec-failure";
import { isDefinitePlatformRejection } from "@/services/decisions/ad-budget";

const CAMPAIGN = "120000000000000001";
const CONV = "OFFSITE_CONVERSIONS";
const PURCHASE = { pixel_id: "777", custom_event_type: "PURCHASE" };
const LEAD = { pixel_id: "777", custom_event_type: "LEAD" };
const TARGETING = { geo_locations: { countries: ["US"] }, age_min: 25, age_max: 54 };

function account(strategy: string | null, siblings: Array<Record<string, unknown>>, account_id = "900") {
  g.fbGet.mockImplementation(async (_t: string, path: string) => {
    if (path === "act_900/adsets") return { data: [{ name: "Existing set" }] };
    if (path === CAMPAIGN) return { id: CAMPAIGN, account_id, bid_strategy: strategy };
    if (path === `${CAMPAIGN}/adsets`) return { data: siblings };
    throw new Error(`unexpected read ${path}`);
  });
}
const siblingReads = () => g.fbGet.mock.calls.filter((c) => c[1] === `${CAMPAIGN}/adsets`).length;

const draft = (over: Partial<CreateAdSetBody> = {}): CreateAdSetBody => ({
  campaign_id: CAMPAIGN,
  name: "Grooming, new suburbs",
  daily_budget_usd: 40,
  currency: "USD",
  optimization_goal: CONV,
  billing_event: "IMPRESSIONS",
  targeting: TARGETING,
  rationale: "",
  promoted_object: PURCHASE,
  ...over,
});
const live = (o: Record<string, unknown>) => ({ status: "ACTIVE", effective_status: "ACTIVE", optimization_goal: CONV, promoted_object: PURCHASE, ...o });

const sentParams = () => g.fbPost.mock.calls[0][2] as Record<string, string>;
const exec = (body: CreateAdSetBody) => metaCreateAdSet("tenant-1", { ...body });

beforeEach(() => {
  vi.clearAllMocks();
  g.setting.mockResolvedValue(true);
  g.fbPost.mockResolvedValue({ id: "238000000000555" });
});

describe("propose: the card carries the bid Meta will run", () => {
  it("must catch (the motivating case): a body saying lowest cost into a cost-cap campaign is refused, never rewritten", async () => {
    account("COST_CAP", [live({ bid_amount: "3200" })]);
    await expect(resolveCreateAdSetBid("tenant-1", draft({ bid_strategy: "LOWEST_COST_WITHOUT_CAP" }))).rejects.toMatchObject({ code: "meta_ads_bid_conflict" });
  });

  it("cost cap, no bid in the body: the live same-result ad sets' lower median is stamped, with where it came from", async () => {
    account("COST_CAP", [
      live({ bid_amount: "3200" }),
      live({ bid_amount: "2500" }),
      live({ bid_amount: "9000" }),
      live({ status: "PAUSED", effective_status: "PAUSED", bid_amount: "100" }),
      live({ optimization_goal: "LINK_CLICKS", promoted_object: null, bid_amount: "100" }),
    ]);
    const b = await resolveCreateAdSetBid("tenant-1", draft());
    expect(b).toMatchObject({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32, bid_copied_from: { ad_sets: 3, result: "Purchase" } });
    expect(b).not.toHaveProperty("bid_strategy");
    expect(createAdSetBodySchema.safeParse(b).success).toBe(true);
  });

  it("must catch: a Purchase cap is never copied into a Lead ad set, though both say OFFSITE_CONVERSIONS", async () => {
    account("COST_CAP", [live({ bid_amount: "9000" })]);
    await expect(resolveCreateAdSetBid("tenant-1", draft({ promoted_object: LEAD }))).rejects.toMatchObject({ code: "meta_ads_bid_unavailable" });
  });

  it("a paused campaign: the ad sets switched on (configured status) win over stale paused ones", async () => {
    account("LOWEST_COST_WITH_BID_CAP", [
      live({ status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", bid_amount: "450" }),
      live({ status: "PAUSED", effective_status: "PAUSED", bid_amount: "100" }),
      live({ status: "PAUSED", effective_status: "PAUSED", bid_amount: "120" }),
    ]);
    expect(await resolveCreateAdSetBid("tenant-1", draft())).toMatchObject({ bid_amount_usd: 4.5, bid_copied_from: { ad_sets: 1 } });
  });

  it("deleted and archived ad sets are never copied", async () => {
    account("COST_CAP", [live({ status: "DELETED", bid_amount: "5000" }), live({ status: "PAUSED", effective_status: "ARCHIVED", bid_amount: "6000" })]);
    await expect(resolveCreateAdSetBid("tenant-1", draft())).rejects.toMatchObject({ code: "meta_ads_bid_unavailable" });
  });

  it("a campaign in another ad account is refused before any sibling read", async () => {
    account("COST_CAP", [live({ bid_amount: "3200" })], "555");
    await expect(resolveCreateAdSetBid("tenant-1", draft())).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(siblingReads()).toBe(0);
  });

  it("an unknown campaign strategy is refused, not read as 'no bid'", async () => {
    account("TARGET_COST", []);
    await expect(resolveCreateAdSetBid("tenant-1", draft())).rejects.toMatchObject({ code: "meta_ads_bid_unknown_strategy" });
  });

  it("the proposer's own amount in a cost-cap campaign is used as is, with no sibling read", async () => {
    account("COST_CAP", [live({ bid_amount: "3200" })]);
    const b = await resolveCreateAdSetBid("tenant-1", draft({ bid_amount_usd: 18 }));
    expect(b).toMatchObject({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 18 });
    expect(b).not.toHaveProperty("bid_copied_from");
    expect(siblingReads()).toBe(0);
  });

  it("minimum ROAS: the floor is copied as a ratio on a VALUE ad set, refused on any other goal", async () => {
    account("LOWEST_COST_WITH_MIN_ROAS", [live({ optimization_goal: "VALUE", bid_constraints: { roas_average_floor: 15000 } })]);
    expect(await resolveCreateAdSetBid("tenant-1", draft({ optimization_goal: "VALUE" }))).toMatchObject({ campaign_bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_floor: 1.5 });
    await expect(resolveCreateAdSetBid("tenant-1", draft())).rejects.toMatchObject({ code: "meta_ads_bid_unavailable" });
  });

  it("must not touch: a lowest-cost campaign gets no bid; a campaign with no strategy keeps the body's own", async () => {
    account("LOWEST_COST_WITHOUT_CAP", []);
    const lc = await resolveCreateAdSetBid("tenant-1", draft());
    expect(lc).toMatchObject({ campaign_bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(lc).not.toHaveProperty("bid_amount_usd");
    account(null, []);
    const own = await resolveCreateAdSetBid("tenant-1", draft({ bid_strategy: "COST_CAP", bid_amount_usd: 12 }));
    expect(own).toMatchObject({ bid_strategy: "COST_CAP", bid_amount_usd: 12 });
    expect(own).not.toHaveProperty("campaign_bid_strategy");
    expect(siblingReads()).toBe(0);
  });

  it("stamped fields from the caller are replaced, never trusted; the switch OFF reads nothing", async () => {
    account(null, []);
    const forged = await resolveCreateAdSetBid("tenant-1", draft({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: undefined, roas_floor: 9, bid_copied_from: { ad_sets: 9, result: "x" } }));
    expect(forged).not.toHaveProperty("campaign_bid_strategy");
    expect(forged).not.toHaveProperty("roas_floor");
    expect(forged).not.toHaveProperty("bid_copied_from");
  });

  it("switch OFF stops the copy, never the check: a capped campaign needs the proposer's own amount", async () => {
    g.setting.mockResolvedValue(false);
    account("COST_CAP", [live({ bid_amount: "3200" })]);
    await expect(resolveCreateAdSetBid("tenant-1", draft())).rejects.toMatchObject({ code: "meta_ads_bid_unavailable" });
    expect(await resolveCreateAdSetBid("tenant-1", draft({ bid_amount_usd: 20 }))).toMatchObject({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 20 });
    expect(siblingReads()).toBe(0);
  });

  it("an amount the proposer gives is rounded to cents before the card (card and wire cannot differ); one that rounds to nothing is refused", async () => {
    account("COST_CAP", []);
    expect(await resolveCreateAdSetBid("tenant-1", draft({ bid_amount_usd: 12.3456 }))).toMatchObject({ bid_amount_usd: 12.35 });
    await expect(resolveCreateAdSetBid("tenant-1", draft({ bid_amount_usd: 0.004 }))).rejects.toMatchObject({ code: "meta_ads_invalid_bid" });
  });

  it("every body schema refuses a bid that is not whole cents (create and one-card launch)", () => {
    expect(createAdSetBodySchema.safeParse({ ...draft(), bid_strategy: "COST_CAP", bid_amount_usd: 1.005 }).success).toBe(false);
    expect(createAdSetBodySchema.safeParse({ ...draft(), campaign_bid_strategy: "COST_CAP", bid_amount_usd: 1.005 }).success).toBe(false);
    expect(createAdSetBodySchema.safeParse({ ...draft(), bid_strategy: "COST_CAP", bid_amount_usd: 1.01 }).success).toBe(true);
  });
});

describe("the propose tool, end to end (real resolver)", () => {
  const ctx = () => {
    const emit = vi.fn(async (_class: string, _body: unknown) => "decision-1");
    return { emit, c: { tenant_id: "tenant-1", log: () => {}, emit_decision: emit } as unknown as ToolContext };
  };
  const input = { campaign_id: CAMPAIGN, name: "Grooming, new suburbs", daily_budget_usd: 40, optimization_goal: CONV, billing_event: "IMPRESSIONS", targeting: TARGETING, promoted_object: PURCHASE, rationale: "r" };

  it("an amount alone into a cost-cap campaign reaches the card as the campaign's bid", async () => {
    account("COST_CAP", []);
    const a = ctx();
    await metaProposeNewAdSetTool.execute(a.c, { ...input, bid_amount_usd: 25 });
    expect(a.emit.mock.calls[0]![1]).toMatchObject({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 25 });
  });

  it("no bid into a cost-cap campaign: the card carries the copied bid; lowest cost asked there is refused with no card", async () => {
    account("COST_CAP", [live({ bid_amount: "3200" })]);
    const a = ctx();
    await metaProposeNewAdSetTool.execute(a.c, input);
    expect(a.emit.mock.calls[0]![1]).toMatchObject({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32 });
    const b = ctx();
    await expect(metaProposeNewAdSetTool.execute(b.c, { ...input, bid_strategy: "LOWEST_COST_WITHOUT_CAP" })).rejects.toMatchObject({ code: "meta_ads_bid_conflict" });
    expect(b.emit).not.toHaveBeenCalled();
  });

  it("an invalid body is refused by the body check first, with no Meta read", async () => {
    account("COST_CAP", []);
    const a = ctx();
    await expect(metaProposeNewAdSetTool.execute(a.c, { ...input, promoted_object: undefined })).rejects.toMatchObject({ code: "meta_ads_invalid_create_body" });
    expect(g.fbGet.mock.calls.some((c) => c[1] === CAMPAIGN)).toBe(false);
  });
});

describe("the card shows the number", () => {
  it("the decisions rail (Slack, web approvals) says the bid too", () => {
    const body = { ...draft(), campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32, bid_copied_from: { ad_sets: 3, result: "Purchase" } };
    expect(decisionConsequence("meta_ads.create_ad_set", "meta_ads.create_ad_set", body).approve).toContain(
      "and a cost per result goal of $32, picked from the campaign's 3 ad sets for Purchase",
    );
    expect(decisionConsequence("meta_ads.create_ad_set", "meta_ads.create_ad_set", draft()).approve).not.toMatch(/goal|bid cap|ROAS/);
  });

  it("a one-card launch (it goes live) names its bid on the decisions rail too", () => {
    const launch = { currency: "USD", campaign: { name: "Spring", daily_budget_usd: 50, bid_strategy: "LOWEST_COST_WITH_BID_CAP" }, ad_set: { bid_amount_usd: 2.5 } };
    expect(decisionConsequence("meta_ads.launch_campaign", "meta_ads.launch_campaign", launch).approve).toContain("with a bid cap of $2.50");
    const lowest = { ...launch, campaign: { ...launch.campaign, bid_strategy: "LOWEST_COST_WITHOUT_CAP" }, ad_set: {} };
    expect(decisionConsequence("meta_ads.launch_campaign", "meta_ads.launch_campaign", lowest).approve).not.toMatch(/bid cap|goal/);
  });

  it("a copied cost cap reads as an amount and where it came from", () => {
    const body = { ...draft(), campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32, bid_copied_from: { ad_sets: 3, result: "Purchase" } };
    const bid = metaChangeRows("meta_ads.create_ad_set", body)?.rows.find((r) => r.item === "Bid");
    expect(bid?.after).toBe("Cost per result goal, $32, picked from the campaign's 3 ad sets for Purchase");
  });

  it("the body schema refuses a stamped campaign strategy beside an ad-set strategy, and a floor without one", () => {
    expect(createAdSetBodySchema.safeParse({ ...draft(), campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32, bid_strategy: "COST_CAP" }).success).toBe(false);
    expect(createAdSetBodySchema.safeParse({ ...draft(), campaign_bid_strategy: "COST_CAP" }).success).toBe(false);
    expect(createAdSetBodySchema.safeParse({ ...draft(), roas_floor: 2 }).success).toBe(false);
  });
});

describe("execute: the approved bid goes out unchanged, or nothing does", () => {
  const stamped = () => draft({ campaign_bid_strategy: "COST_CAP", bid_amount_usd: 32, bid_copied_from: { ad_sets: 3, result: "Purchase" } });

  it("sends the approved amount alone (no ad-set strategy) and never re-reads the siblings", async () => {
    account("COST_CAP", [live({ bid_amount: "9900" })]);
    await exec(stamped());
    expect(sentParams().bid_amount).toBe("3200");
    expect(sentParams()).not.toHaveProperty("bid_strategy");
    expect(siblingReads()).toBe(0);
  });

  it("refuses before anything is sent when the campaign's strategy changed after approval, and gives the hold back", async () => {
    account("LOWEST_COST_WITHOUT_CAP", []);
    const err = await exec(stamped()).catch((e) => e);
    expect(err).toMatchObject({ code: "meta_ads_bid_unavailable" });
    expect(isDefinitePlatformRejection(err)).toBe(true);
    expect(verdictFor({ code: err.code, error: err.message }, "meta_ads.create_ad_set")).toMatchObject({ bucket: "blocked_on_us" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("refuses a capped campaign's create whose card showed no bid (an old card), instead of picking one", async () => {
    account("COST_CAP", [live({ bid_amount: "3200" })]);
    await expect(exec(draft())).rejects.toMatchObject({ code: "meta_ads_bid_unavailable" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("refuses a campaign outside the connected ad account", async () => {
    account("COST_CAP", [], "555");
    await expect(exec(stamped())).rejects.toBeTruthy();
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("minimum ROAS goes out as the scaled floor", async () => {
    account("LOWEST_COST_WITH_MIN_ROAS", []);
    await exec(draft({ optimization_goal: "VALUE", campaign_bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_floor: 1.5 }));
    expect(JSON.parse(sentParams().bid_constraints)).toEqual({ roas_average_floor: 15000 });
    expect(sentParams()).not.toHaveProperty("bid_amount");
  });

  it("must not touch: no campaign strategy sends the body's own bid; lowest cost sends none", async () => {
    account(null, []);
    await exec(draft({ bid_strategy: "COST_CAP", bid_amount_usd: 12 }));
    expect(sentParams()).toMatchObject({ bid_strategy: "COST_CAP", bid_amount: "1200" });
    g.fbPost.mockClear();
    account("LOWEST_COST_WITHOUT_CAP", []);
    await exec(draft());
    expect(sentParams()).not.toHaveProperty("bid_amount");
    expect(sentParams()).not.toHaveProperty("bid_strategy");
  });

  it("switch OFF changes nothing at execute: the campaign is still checked", async () => {
    g.setting.mockResolvedValue(false);
    account("COST_CAP", [live({ bid_amount: "3200" })]);
    await expect(exec(draft())).rejects.toMatchObject({ code: "meta_ads_bid_unavailable" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a failed read before the POST gives the hold back (pre-send), not only the campaign read", async () => {
    g.fbGet.mockRejectedValue(new Error("Graph 500"));
    const err = await exec(draft()).catch((e) => e);
    expect(isDefinitePlatformRejection(err)).toBe(true);
    expect(g.fbPost).not.toHaveBeenCalled();
  });
});

describe("pickSiblingBid", () => {
  it("ignores unreadable amounts and takes the lower median", () => {
    const rows = [live({ bid_amount: "abc" }), live({ bid_amount: 0 }), live({ bid_amount: "700" }), live({ bid_amount: "900" })];
    expect(pickSiblingBid("COST_CAP", rows, CONV, PURCHASE)).toEqual({ value: 700, ad_sets: 2 });
  });
});
