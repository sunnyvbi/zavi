
import { describe, it, expect, vi, beforeEach } from "vitest";

const g = vi.hoisted(() => ({
  fbGet: vi.fn(),
  fbPost: vi.fn(),
  currency: vi.fn(),
  creds: vi.fn(),
}));
vi.mock("../../_client", () => ({
  fbGet: (...a: unknown[]) => g.fbGet(...a),
  fbPost: (...a: unknown[]) => g.fbPost(...a),
  getAdAccountCurrency: (...a: unknown[]) => g.currency(...a),
  metaAdsCreds: (...a: unknown[]) => g.creds(...a),
}));
vi.mock("../_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => true) }));
vi.mock("../_fx-rate", () => ({ unitsPerUsd: async (c: string) => (c === "INR" ? 90 : 1) }));
vi.mock("../cap-reader", () => {
  const m = { readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })) };
  return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday };
});

import {
  META_REMOVE_SPEND_CAP,
  shapeCreateCampaignRequest,
  shapeDeleteCampaignRequest,
  shapeUpdateCampaignRequest,
} from "../_request-shapers";
import { createCampaignBodySchema, deleteCampaignBodySchema, updateCampaignBodySchema } from "../_decision-bodies";
import { metaCreateCampaign, metaDeleteCampaign, metaUpdateCampaign } from "../campaign_writes";
import {
  metaProposeCampaignDeleteTool,
  metaProposeCampaignUpdateTool,
  metaProposeNewCampaignTool,
} from "../propose_campaign";
import { metaChangeRows } from "../_change-rows";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";

const ACCOUNT = "act_555";
const CID = "120200000001";

beforeEach(() => {
  vi.clearAllMocks();
  g.creds.mockResolvedValue({ ad_account_id: ACCOUNT, access_token: "t" });
  g.currency.mockResolvedValue("USD");
  g.fbPost.mockResolvedValue({ success: true });
});

function live(extra: Record<string, unknown> = {}) {
  return { id: CID, account_id: "555", name: "Spring", status: "ACTIVE", daily_budget: "5000", spend_cap: null, bid_strategy: "LOWEST_COST_WITHOUT_CAP", ...extra };
}

describe("request shapes", () => {
  it("a create is always PAUSED; with a budget the campaign holds it at lowest cost", () => {
    const r = shapeCreateCampaignRequest(
      { ad_account_id: ACCOUNT, name: "N · zvabc", objective: "OUTCOME_SALES", special_ad_categories: [], daily_budget_usd: 40 },
      "USD",
    );
    expect(r.path).toBe("act_555/campaigns");
    expect(r.params).toMatchObject({ status: "PAUSED", objective: "OUTCOME_SALES", daily_budget: "4000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", special_ad_categories: "[]" });
    expect(r.params.is_adset_budget_sharing_enabled).toBeUndefined();
  });

  it("a create without a budget says its ad sets hold the budget, and refuses a bid strategy", () => {
    const r = shapeCreateCampaignRequest({ ad_account_id: ACCOUNT, name: "N", objective: "OUTCOME_TRAFFIC", special_ad_categories: [] }, "USD");
    expect(r.params.is_adset_budget_sharing_enabled).toBe("false");
    expect(r.params.daily_budget).toBeUndefined();
    expect(() =>
      shapeCreateCampaignRequest({ ad_account_id: ACCOUNT, name: "N", objective: "OUTCOME_TRAFFIC", special_ad_categories: [], bid_strategy: "COST_CAP" }, "USD"),
    ).toThrow(ExpectedToolError);
  });

  it("an update sends only the fields given; null removes the spend cap", () => {
    expect(shapeUpdateCampaignRequest({ campaign_id: CID, new_name: "New" }, "USD").params).toEqual({ name: "New" });
    expect(shapeUpdateCampaignRequest({ campaign_id: CID, spend_cap_usd: 500 }, "USD").params).toEqual({ spend_cap: "50000" });
    expect(shapeUpdateCampaignRequest({ campaign_id: CID, spend_cap_usd: null }, "USD").params).toEqual({ spend_cap: META_REMOVE_SPEND_CAP });
    expect(() => shapeUpdateCampaignRequest({ campaign_id: CID }, "USD")).toThrow(ExpectedToolError);
  });

  it("a delete is Meta's DELETED status on a real campaign id", () => {
    expect(shapeDeleteCampaignRequest({ campaign_id: CID })).toEqual({ path: CID, params: { status: "DELETED" } });
    expect(() => shapeDeleteCampaignRequest({ campaign_id: "act_555" })).toThrow(ExpectedToolError);
  });
});

describe("body rules", () => {
  it("a campaign bid strategy needs a campaign budget; a special category needs its countries", () => {
    expect(createCampaignBodySchema.safeParse({ name: "N", objective: "OUTCOME_SALES", bid_strategy: "COST_CAP" }).success).toBe(false);
    expect(createCampaignBodySchema.safeParse({ name: "N", objective: "OUTCOME_SALES", special_ad_categories: ["HOUSING"] }).success).toBe(false);
    expect(createCampaignBodySchema.safeParse({ name: "N", objective: "OUTCOME_SALES", special_ad_categories: ["HOUSING"], special_ad_category_country: ["us"] }).success).toBe(true);
  });

  it("an update changes something, and a cap or bid change carries the value it changes from", () => {
    expect(updateCampaignBodySchema.safeParse({ campaign_id: CID }).success).toBe(false);
    expect(updateCampaignBodySchema.safeParse({ campaign_id: CID, spend_cap_usd: 500 }).success).toBe(false);
    expect(updateCampaignBodySchema.safeParse({ campaign_id: CID, spend_cap_usd: 500, expected_current_spend_cap_usd: null }).success).toBe(true);
    expect(updateCampaignBodySchema.safeParse({ campaign_id: CID, bid_strategy: "COST_CAP" }).success).toBe(false);
  });

  it("a delete names a Meta id", () => {
    expect(deleteCampaignBodySchema.safeParse({ campaign_id: "abc" }).success).toBe(false);
  });
});

describe("executors", () => {
  it("a create reuses the campaign its tag already names, sending nothing", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [{ id: "999", name: "Spring · zvabcdef0123" }] });
    const r = await metaCreateCampaign("t1", { name: "Spring", tag: "zvabcdef0123", objective: "OUTCOME_SALES", special_ad_categories: [] });
    expect(r).toEqual({ id: "999", name: "Spring · zvabcdef0123", reused: true });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("a fresh create posts PAUSED with the tagged name", async () => {
    g.fbGet.mockResolvedValueOnce({ data: [] });
    g.fbPost.mockResolvedValueOnce({ id: "777" });
    const r = await metaCreateCampaign("t1", { name: "Spring", tag: "zvabcdef0123", objective: "OUTCOME_SALES", special_ad_categories: [], daily_budget_usd: 30 });
    expect(r).toMatchObject({ id: "777", reused: false });
    const [, path, params] = g.fbPost.mock.calls[0] as [string, string, Record<string, string>];
    expect(path).toBe("act_555/campaigns");
    expect(params).toMatchObject({ name: "Spring · zvabcdef0123", status: "PAUSED", daily_budget: "3000" });
  });

  it("an update refuses a campaign from another ad account before sending", async () => {
    g.fbGet.mockResolvedValueOnce(live({ account_id: "999" }));
    const body = updateCampaignBodySchema.parse({ campaign_id: CID, new_name: "X" });
    await expect(metaUpdateCampaign("t1", body)).rejects.toMatchObject({ code: "meta_ads_invalid_target" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("an update refuses a spend cap that moved since the proposal", async () => {
    g.fbGet.mockResolvedValueOnce(live({ spend_cap: "90000" }));
    const body = updateCampaignBodySchema.parse({ campaign_id: CID, spend_cap_usd: 500, expected_current_spend_cap_usd: null });
    await expect(metaUpdateCampaign("t1", body)).rejects.toMatchObject({ code: "meta_ads_spend_cap_drift" });
    expect(g.fbPost).not.toHaveBeenCalled();
  });

  it("an update treats Meta's 'no cap' value as no cap", async () => {
    g.fbGet.mockResolvedValueOnce(live({ spend_cap: META_REMOVE_SPEND_CAP }));
    const body = updateCampaignBodySchema.parse({ campaign_id: CID, spend_cap_usd: 500, expected_current_spend_cap_usd: null });
    await expect(metaUpdateCampaign("t1", body)).resolves.toMatchObject({ updated_fields: ["spend_cap"] });
  });

  it("an update refuses a bid strategy on a campaign whose ad sets hold the budget", async () => {
    g.fbGet.mockResolvedValueOnce(live({ daily_budget: null }));
    const body = updateCampaignBodySchema.parse({ campaign_id: CID, bid_strategy: "COST_CAP", expected_current_bid_strategy: null });
    await expect(metaUpdateCampaign("t1", body)).rejects.toMatchObject({ code: "meta_ads_bid_strategy_needs_campaign_budget" });
  });

  it("a delete reads the campaign first (own account) and returns its prior status", async () => {
    g.fbGet.mockResolvedValueOnce(live());
    await expect(metaDeleteCampaign("t1", CID)).resolves.toEqual({ before_status: "ACTIVE", name: "Spring" });
    expect(g.fbPost).toHaveBeenCalledWith("t1", CID, { status: "DELETED" });
  });
});

describe("propose tools", () => {
  function ctx() {
    const emit = vi.fn(async () => "d-1");
    const c: ToolContext = { tenant_id: "t1", log: () => {}, emit_decision: emit, run_trigger: "scheduled" };
    return { c, emit };
  }

  it("a new campaign is filed on the create class with the account currency", async () => {
    const { c, emit } = ctx();
    await metaProposeNewCampaignTool.execute(c, { name: "Leads Q4", objective: "OUTCOME_LEADS", daily_budget_usd: 50, rationale: "new objective" });
    expect(emit).toHaveBeenCalledWith("meta_ads.create_campaign", expect.objectContaining({ name: "Leads Q4", currency: "USD", daily_budget_usd: 50 }));
  });

  it("an update stamps the LIVE spend cap and bid strategy, never the model's", async () => {
    const { c, emit } = ctx();
    g.fbGet.mockResolvedValueOnce(live({ spend_cap: "20000" }));
    await metaProposeCampaignUpdateTool.execute(c, { campaign_id: CID, spend_cap_usd: 500, bid_strategy: "COST_CAP", rationale: "bound the test" });
    expect(emit).toHaveBeenCalledWith(
      "meta_ads.update_campaign",
      expect.objectContaining({ expected_current_spend_cap_usd: 200, expected_current_bid_strategy: "LOWEST_COST_WITHOUT_CAP", name: "Spring" }),
    );
  });

  it("an update below Meta's smallest spend cap is refused", async () => {
    const { c, emit } = ctx();
    g.fbGet.mockResolvedValueOnce(live());
    await expect(metaProposeCampaignUpdateTool.execute(c, { campaign_id: CID, spend_cap_usd: 40, rationale: "x" })).rejects.toBeInstanceOf(ExpectedToolError);
    expect(emit).not.toHaveBeenCalled();
  });

  it("remove_spend_cap files a null cap against the live one", async () => {
    const { c, emit } = ctx();
    g.fbGet.mockResolvedValueOnce(live({ spend_cap: "30000" }));
    await metaProposeCampaignUpdateTool.execute(c, { campaign_id: CID, remove_spend_cap: true, rationale: "lift the cap" });
    expect(emit).toHaveBeenCalledWith("meta_ads.update_campaign", expect.objectContaining({ spend_cap_usd: null, expected_current_spend_cap_usd: 300 }));
  });

  it("a delete is filed with the campaign's live name", async () => {
    const { c, emit } = ctx();
    g.fbGet.mockResolvedValueOnce(live());
    await metaProposeCampaignDeleteTool.execute(c, { campaign_id: CID, rationale: "founder asked" });
    expect(emit).toHaveBeenCalledWith("meta_ads.delete_campaign", expect.objectContaining({ campaign_id: CID, name: "Spring" }));
  });
});

describe("card rows", () => {
  it("create, change and delete say exactly what Approve does", () => {
    expect(metaChangeRows("meta_ads.create_campaign", { name: "Leads Q4", objective: "OUTCOME_LEADS" })?.rows).toContainEqual({ item: "Budget", before: "None", after: "Set on each ad set" });
    const u = metaChangeRows("meta_ads.update_campaign", { campaign_id: CID, name: "Spring", spend_cap_usd: null, expected_current_spend_cap_usd: 300 });
    expect(u?.rows).toEqual([{ item: "Spend cap", before: "$300", after: "No cap" }]);
    expect(u?.change_sentence).toBe("Zavi removes its spend cap on “Spring”.");
    expect(metaChangeRows("meta_ads.delete_campaign", { campaign_id: CID, name: "Spring" })?.title).toBe("Delete “Spring”");
  });
});

describe("meta create cards show every value Approve sends", () => {
  it("a campaign create shows its bid strategy and special-category countries", () => {
    const rows = metaChangeRows("meta_ads.create_campaign", {
      name: "Jobs",
      objective: "OUTCOME_LEADS",
      daily_budget_usd: 40,
      bid_strategy: "COST_CAP",
      special_ad_categories: ["EMPLOYMENT"],
      special_ad_category_country: ["US"],
    })?.rows;
    expect(rows).toContainEqual({ item: "Bid strategy", before: "None", after: "Cost per result goal" });
    expect(rows).toContainEqual({ item: "Special ad category", before: "None", after: "Employment (US)" });
  });

  it("a creative shows its full primary text and its button", () => {
    const text = "x".repeat(260);
    const rows = metaChangeRows("meta_ads.create_creative", {
      name: "Spring v2",
      primary_text: text,
      headline: "Save now",
      link_url: "https://example.com",
      image_hash: "0123456789abcdef0123456789abcdef",
      cta: "SIGN_UP",
      rationale: "",
    })?.rows;
    expect(rows).toContainEqual({ item: "Primary text", before: "None", after: text });
    expect(rows).toContainEqual({ item: "Button", before: "None", after: "SIGN_UP" });
  });
});
