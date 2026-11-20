import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => "owner") }));
vi.mock("@/services/ads-wallet/consent", () => ({ sharedWalletConsent: vi.fn(async () => { throw new Error("the real consent read must not run in this test"); }) }));

import { linkedinApproverRefusal } from "../_approver-role";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const row = (exec_class: string, body: unknown, over: Record<string, unknown> = {}) => ({ tenant_id: T, exec_class, body, approved_by: "u1", approved_by_source: "web", ...over });
const PAGE = "urn:li:organization:1";
const adStatus = (status: "ACTIVE" | "PAUSED") => ({ creative_id: "8", campaign_id: "22", account_id: "11", campaign_name: "Spring", ad_name: "Ad 8", expected_status: status === "ACTIVE" ? "PAUSED" : "ACTIVE", status, rationale: "r" });
const archive = (mode: "archive" | "delete") => ({ target: "campaign", id: "22", account_id: "11", campaign_id: null, name: "Spring", expected_status: "PAUSED", mode, rationale: "r" });
const createAd = (go_live: boolean) => ({ campaign_id: "22", account_id: "11", campaign_name: "Spring", campaign_status: "ACTIVE", associated_entity: PAGE, source: { kind: "post", post_urn: "urn:li:share:1" }, go_live, expected_ad_count: 3, rationale: "r" });

describe("linkedinApproverRefusal hands the card back to the founder instead of failing it", () => {
  it("a member approving a spend-raising class is a founder hold, never dispatch_failed", async () => {
    const r = await linkedinApproverRefusal(row("linkedin_ads.set_ad_status", adStatus("ACTIVE")), async () => "member");
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "linkedin_ads_admin_required" });
    const { classifyExecFailure } = await import("@/services/channels/exec-failure");
    expect(classifyExecFailure(r)).toBeNull();
  });

  it("a role lookup failure is also a hold, so the founder approves again once roles load", async () => {
    const r = await linkedinApproverRefusal(row("linkedin_ads.create_campaign", {}), async () => { throw new Error("db"); });
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "linkedin_ads_role_unavailable" });
  });

  it("members may approve what only stops spend, and owners or admins approve anything", async () => {
    await expect(linkedinApproverRefusal(row("linkedin_ads.set_ad_status", adStatus("PAUSED")), async () => "member")).resolves.toBeNull();
    await expect(linkedinApproverRefusal(row("linkedin_ads.archive", archive("archive")), async () => "member")).resolves.toBeNull();
    await expect(linkedinApproverRefusal(row("linkedin_ads.archive", archive("delete")), async () => "member")).resolves.toMatchObject({ code: "linkedin_ads_admin_required" });
    await expect(linkedinApproverRefusal(row("linkedin_ads.create_ad", createAd(true)), async () => "admin")).resolves.toBeNull();
    await expect(linkedinApproverRefusal(row("linkedin_ads.create_ad", createAd(true)), async () => "member")).resolves.toMatchObject({ code: "linkedin_ads_admin_required" });
    await expect(linkedinApproverRefusal(row("linkedin_ads.create_ad", createAd(false)), async () => "member")).resolves.toBeNull();
  });

  it("an unattended or cgo approval skips the role check", async () => {
    await expect(linkedinApproverRefusal(row("linkedin_ads.launch_campaign", {}, { approved_by: null }), async () => "member")).resolves.toBeNull();
  });
});

describe("an Autopilot (cgo) approval is re-checked at execute, after the policy let it through", () => {
  const ids = { campaign_id: "22", account_id: "11" };
  const usd = (amount: string) => ({ amount, currency: "USD" });
  const resume = { ...ids, name: "Spring", rationale: "r", expected_status: "PAUSED", run_start_at: null, run_end_at: null, budget: { kind: "daily", amount: "40", currency: "USD" }, origin: "agent" };
  const bidRaise = { ...ids, name: "Spring", rationale: "r", last_modified_at: null, changes: { unit_cost: { before: usd("5.00"), after: usd("6.00") } }, origin: "agent" };
  const bidCut = { ...bidRaise, changes: { unit_cost: { before: usd("6.00"), after: usd("5.00") } } };
  const groupLonger = { group_id: "33", account_id: "11", name: "G", rationale: "r", last_modified_at: null, changes: { run_end_at: { before: "2026-12-01T00:00:00.000Z", after: "2026-12-15T00:00:00.000Z" } }, origin: "agent" };
  const swap = { ...ids, campaign_name: "Spring", associated_entity: PAGE, old_creative_id: "44", old_ad_name: "Old", source: { kind: "post", post_urn: "urn:li:share:2" }, rationale: "r", origin: "agent" };
  const cgo = (exec_class: string, body: unknown) => row(exec_class, body, { approved_by: null, approved_by_source: "cgo" });
  const role = async () => { throw new Error("a cgo row has no person to look up"); };
  const yes = async () => true;

  it.each([
    ["linkedin_ads.resume_campaign", resume],
    ["linkedin_ads.update_campaign", bidRaise],
    ["linkedin_ads.create_ad", { ...createAd(true), origin: "agent" }],
  ])("F1: %s without the founder's paid permission is held for the founder, not failed and not sent", async (cls, body) => {
    const r = await linkedinApproverRefusal(cgo(cls, body), role, async () => false);
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "linkedin_ads_consent_required" });
    const { classifyExecFailure } = await import("@/services/channels/exec-failure");
    expect(classifyExecFailure(r)).toBeNull();
  });

  it("F1: a permission read that errors fails closed", async () => {
    const r = await linkedinApproverRefusal(cgo("linkedin_ads.resume_campaign", resume), role, async () => { throw new Error("db down"); });
    expect(r).toMatchObject({ code: "linkedin_ads_consent_required" });
  });

  it.each([
    ["linkedin_ads.update_campaign", bidRaise],
    ["linkedin_ads.update_campaign_group", groupLonger],
    ["linkedin_ads.create_ad", { ...createAd(true), origin: "agent" }],
    ["linkedin_ads.swap_ad", swap],
  ])("F2: %s raises spend with no ad-budget hold, so even with permission Autopilot refuses it", async (cls, body) => {
    await expect(linkedinApproverRefusal(cgo(cls, body), role, yes)).resolves.toMatchObject({ held_for_founder: true, code: "linkedin_ads_change_not_held" });
  });

  it("F2: a group or ad copy reserves nothing, so Autopilot refuses it at execute; a campaign copy goes through", async () => {
    const dup = (over: Record<string, unknown>) => ({ target: "campaign", source_id: "22", account_id: "11", source_name: "Spring", new_name: "Spring (copy)", group_id: null, campaign_id: null, copy_ads: true, source_last_modified_at: null, rationale: "r", origin: "agent", ...over });
    await expect(linkedinApproverRefusal(cgo("linkedin_ads.duplicate", dup({ target: "campaign_group", source_id: "33" })), role, yes)).resolves.toMatchObject({ code: "linkedin_ads_change_not_held" });
    await expect(linkedinApproverRefusal(cgo("linkedin_ads.duplicate", dup({ target: "creative", source_id: "44", campaign_id: "22" })), role, yes)).resolves.toMatchObject({ code: "linkedin_ads_change_not_held" });
    await expect(linkedinApproverRefusal(cgo("linkedin_ads.duplicate", dup({})), role, yes)).resolves.toBeNull();
  });

  it("with permission, a held restart and an edit that cannot raise spend go through", async () => {
    await expect(linkedinApproverRefusal(cgo("linkedin_ads.resume_campaign", resume), role, yes)).resolves.toBeNull();
    await expect(linkedinApproverRefusal(cgo("linkedin_ads.update_campaign", bidCut), role, yes)).resolves.toBeNull();
  });

  it("a pause is never blocked by a missing permission, and a founder's own approval never reads it", async () => {
    const never = vi.fn(async () => false);
    await expect(linkedinApproverRefusal(cgo("linkedin_ads.set_status", { ...ids, status: "PAUSED" }), role, never)).resolves.toBeNull();
    await expect(linkedinApproverRefusal(row("linkedin_ads.update_campaign", bidRaise), async () => "owner", never)).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
