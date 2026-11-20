import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => "owner") }));

import { metaActionRaisesSpend } from "../_decision-bodies";
import { metaApproverRefusal } from "../_approver-role";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("metaActionRaisesSpend", () => {
  it.each([
    ["meta_ads.launch_campaign", {}],
    ["meta_ads.duplicate_campaign", { daily_budget_usd: 20 }],
    ["meta_ads.duplicate_ad_set", { daily_budget_usd: 20 }],
    ["meta_ads.update_ad_set_budget", { expected_current_daily_budget_usd: 10, daily_budget_usd: 11 }],
    ["meta_ads.update_ad_set_budget_review", { expected_current_daily_budget_usd: 10, daily_budget_usd: 11 }],
    ["meta_ads.update_campaign_budget", { expected_current_daily_budget_usd: 10, daily_budget_usd: 11 }],
    ["meta_ads.update_campaign_budget_review", { daily_budget_usd: 11 }],
    ["meta_ads.update_campaign_budget", null],
    ["meta_ads.set_status", { status: "ACTIVE" }],
    ["meta_ads.set_status_review", {}],
    ["meta_ads.update_ad", { status: "ACTIVE" }],
    ["meta_ads.create_ad", { ad_set_id: "1" }],
    ["meta_ads.duplicate_ad", { source_ad_id: "1", ad_set_id: "2" }],
    ["meta_ads.update_campaign", { spend_cap_usd: null, expected_current_spend_cap_usd: 300 }],
    ["meta_ads.update_campaign", { spend_cap_usd: 400, expected_current_spend_cap_usd: 300 }],
    ["meta_ads.update_campaign", { spend_cap_usd: 400 }],
    ["meta_ads.update_campaign", { spend_cap_usd: null }],
    ["meta_ads.update_campaign", { bid_strategy: "LOWEST_COST_WITHOUT_CAP", expected_current_bid_strategy: "COST_CAP" }],
    ["meta_ads.update_campaign", { bid_strategy: "COST_CAP", spend_cap_usd: 100, expected_current_spend_cap_usd: 300 }],
    ["meta_ads.update_ad_set", { bid_strategy: "LOWEST_COST_WITHOUT_CAP", expected_current_bid_strategy: "LOWEST_COST_WITH_BID_CAP" }],
    ["meta_ads.update_ad_set", { bid_amount_usd: 3, expected_current_bid_amount_usd: 2 }],
    ["meta_ads.update_ad_set", { bid_amount_usd: 3, expected_current_bid_amount_usd: null }],
    ["meta_ads.update_ad_set", { bid_amount_usd: 3 }],
    ["meta_ads.update_ad_set", { bid_strategy: "COST_CAP" }],
    ["meta_ads.update_ad_set", { bid_strategy: "COST_CAP", expected_current_bid_strategy: "COST_CAP", bid_amount_usd: 4, expected_current_bid_amount_usd: 3 }],
    ["meta_ads.update_ad_set", { end_time: "2026-12-31T00:00:00Z", expected_current_end_time: "2026-11-30T00:00:00Z" }],
    ["meta_ads.update_ad_set", { end_time: "2026-12-31T00:00:00Z" }],
    ["meta_ads.update_ad_set", { end_time: "not a date", expected_current_end_time: null }],
    ["meta_ads.update_ad_set", { new_name: "x", end_time: "2026-12-31T00:00:00Z", expected_current_end_time: "2026-11-30T00:00:00Z" }],
  ])("%s %j raises spend", (cls, body) => {
    expect(metaActionRaisesSpend(cls, body)).toBe(true);
  });

  it.each([
    ["meta_ads.update_ad_set_budget", { expected_current_daily_budget_usd: 10, daily_budget_usd: 9 }],
    ["meta_ads.update_campaign_budget", { expected_current_daily_budget_usd: 10, daily_budget_usd: 10 }],
    ["meta_ads.set_status", { status: "PAUSED" }],
    ["meta_ads.set_status_review", { status: "PAUSED" }],
    ["meta_ads.update_ad", { status: "PAUSED" }],
    ["meta_ads.update_ad", { new_name: "x" }],
    ["meta_ads.delete_campaign", {}],
    ["meta_ads.create_campaign", { daily_budget_usd: 50 }],
    ["meta_ads.update_campaign", { spend_cap_usd: 200, expected_current_spend_cap_usd: 300 }],
    ["meta_ads.update_campaign", { spend_cap_usd: 200, expected_current_spend_cap_usd: null }],
    ["meta_ads.update_campaign", { spend_cap_usd: null, expected_current_spend_cap_usd: null }],
    ["meta_ads.update_campaign", { new_name: "x" }],
    ["meta_ads.update_ad_set", { bid_amount_usd: 2, expected_current_bid_amount_usd: 3 }],
    ["meta_ads.update_ad_set", { end_time: "2026-11-01T00:00:00Z", expected_current_end_time: "2026-11-30T00:00:00Z" }],
    ["meta_ads.update_ad_set", { end_time: "2026-11-01T00:00:00Z", expected_current_end_time: null }],
    ["meta_ads.update_ad_set", { new_name: "x", targeting_patch: {} }],
    ["meta_ads.update_ad_set", { bid_strategy: "COST_CAP", expected_current_bid_strategy: "COST_CAP", bid_amount_usd: 2, expected_current_bid_amount_usd: 3 }],
    ["meta_ads.update_campaign", { bid_strategy: "COST_CAP", expected_current_bid_strategy: "COST_CAP", spend_cap_usd: 100, expected_current_spend_cap_usd: 300 }],
    ["reddit_ads.launch_campaign", {}],
    [null, {}],
  ])("%s %j does not", (cls, body) => {
    expect(metaActionRaisesSpend(cls, body)).toBe(false);
  });
});

describe("metaApproverRefusal (executor re-check)", () => {
  const launch = { tenant_id: T, decision_class: "meta_ads.launch_campaign", body: {}, approved_by: "u-1", approved_by_source: null };

  it("refuses a launch whose approver was demoted to member after the click, and hands it back", async () => {
    const loadRole = vi.fn(async () => "member");
    const out = await metaApproverRefusal(launch, loadRole);
    expect(loadRole).toHaveBeenCalledWith("u-1", T);
    expect(out).toMatchObject({ ok: false, held_for_founder: true, code: "meta_ads_admin_required" });
  });

  it("refuses an approver who left the workspace", async () => {
    expect(await metaApproverRefusal(launch, async () => null)).toMatchObject({ code: "meta_ads_admin_required" });
  });

  it("an unreadable role holds the card, nothing written", async () => {
    const out = await metaApproverRefusal(launch, async () => { throw new Error("db down"); });
    expect(out).toMatchObject({ ok: false, held_for_founder: true, code: "meta_ads_role_unavailable" });
  });

  it.each(["owner", "admin"])("lets an %s's approval through", async (r) => {
    expect(await metaApproverRefusal(launch, async () => r)).toBeNull();
  });

  it("a member's pause or budget cut is not re-checked", async () => {
    const loadRole = vi.fn(async () => "member");
    expect(await metaApproverRefusal({ ...launch, decision_class: "meta_ads.set_status", body: { status: "PAUSED" } }, loadRole)).toBeNull();
    expect(await metaApproverRefusal({ ...launch, decision_class: "meta_ads.update_ad_set_budget", body: { expected_current_daily_budget_usd: 10, daily_budget_usd: 5 } }, loadRole)).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("a CGO approval under Autopilot is unchanged: no role read, not refused", async () => {
    const loadRole = vi.fn(async () => "member");
    expect(await metaApproverRefusal({ ...launch, approved_by_source: "cgo" }, loadRole)).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("a staff approval is unchanged (Ravi 2026-10-11)", async () => {
    const loadRole = vi.fn(async () => null);
    expect(await metaApproverRefusal({ ...launch, approved_by_source: "staff" }, loadRole)).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("a row with no approver (the capped unattended path) is unchanged", async () => {
    const loadRole = vi.fn(async () => null);
    expect(await metaApproverRefusal({ ...launch, approved_by: null }, loadRole)).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
  });
});
