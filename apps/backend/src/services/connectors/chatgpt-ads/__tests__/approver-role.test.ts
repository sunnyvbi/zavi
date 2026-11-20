import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => "owner") }));

import { chatgptActionRaisesSpend } from "../raises-spend";
import { chatgptApproverRefusal } from "../approver-role";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("chatgptActionRaisesSpend", () => {
  it.each([
    ["chatgpt_ads.create_and_launch", { name: "c" }],
    ["chatgpt_ads.create_and_launch", null],
    ["chatgpt_ads.create_campaign_bundle", {}],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 60, expected_current_daily_budget_usd: 50 }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 60 }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: "40", expected_current_daily_budget_usd: 50 }],
    ["chatgpt_ads.update_campaign_budget", null],
    ["chatgpt_ads.set_status", { status: "ACTIVE" }],
    ["chatgpt_ads.set_status", {}],
    ["chatgpt_ads.set_status", null],
    ["chatgpt_ads.duplicate_campaign", {}],
    ["chatgpt_ads.update_lifetime_budget", { lifetime_budget_usd: 10 }],
  ])("%s %j raises spend", (cls, body) => {
    expect(chatgptActionRaisesSpend(cls, body)).toBe(true);
  });

  it.each([
    ["chatgpt_ads.set_status", { status: "PAUSED" }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 40, expected_current_daily_budget_usd: 50 }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 50, expected_current_daily_budget_usd: 50 }],
    ["meta_ads.set_status", { status: "ACTIVE" }],
    ["linkedin_ads.create_campaign_bundle", {}],
    [null, {}],
    [undefined, {}],
  ])("%s %j does not", (cls, body) => {
    expect(chatgptActionRaisesSpend(cls, body)).toBe(false);
  });
});

describe("chatgptApproverRefusal (executor re-check)", () => {
  const raise = { tenant_id: T, decision_class: "chatgpt_ads.update_campaign_budget", body: { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }, approved_by: "u-1", approved_by_source: null };

  it("hands a raise back to the founder when the approver is no longer owner/admin", async () => {
    for (const role of ["member", "viewer", null]) {
      const out = await chatgptApproverRefusal(raise, async () => role);
      expect(out).toMatchObject({ ok: false, held_for_founder: true, code: "chatgpt_ads_admin_required" });
    }
  });

  it("fails closed when the role cannot be read", async () => {
    const out = await chatgptApproverRefusal(raise, async () => { throw new Error("db down"); });
    expect(out).toMatchObject({ ok: false, held_for_founder: true, code: "chatgpt_ads_role_unavailable" });
  });

  it("lets an owner or admin through", async () => {
    expect(await chatgptApproverRefusal(raise, async () => "owner")).toBeNull();
    expect(await chatgptApproverRefusal(raise, async () => "admin")).toBeNull();
  });

  it("does not check a member's pause or cut", async () => {
    const loadRole = vi.fn(async () => "member");
    expect(await chatgptApproverRefusal({ ...raise, decision_class: "chatgpt_ads.set_status", body: { status: "PAUSED" } }, loadRole)).toBeNull();
    expect(await chatgptApproverRefusal({ ...raise, body: { daily_budget_usd: 30, expected_current_daily_budget_usd: 60 } }, loadRole)).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("leaves cgo and staff approvals, and rows with no approver, unchanged", async () => {
    const loadRole = vi.fn(async () => "member");
    expect(await chatgptApproverRefusal({ ...raise, approved_by_source: "cgo" }, loadRole)).toBeNull();
    expect(await chatgptApproverRefusal({ ...raise, approved_by_source: "staff" }, loadRole)).toBeNull();
    expect(await chatgptApproverRefusal({ ...raise, approved_by: null }, loadRole)).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
  });
});
