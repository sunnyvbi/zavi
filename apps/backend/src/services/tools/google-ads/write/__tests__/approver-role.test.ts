import { describe, expect, it, vi } from "vitest";
import { googleApproverRefusal, type GoogleApproverDeps } from "../_approver-role";

const row = (decision_class: string, body: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  tenant_id: "t-1",
  decision_class,
  body,
  approved_by: "u-1",
  approved_by_source: null,
  ...over,
});
const deps = (role: string | null | Error, negative: boolean | Error = false): GoogleApproverDeps => ({
  loadRole: vi.fn(async () => {
    if (role instanceof Error) throw role;
    return role;
  }),
  liveKeywordNegative: vi.fn(async () => {
    if (negative instanceof Error) throw negative;
    return negative;
  }),
});
const RAISE = { campaign_id: "1", daily_budget_usd: 30, expected_current_daily_budget_usd: 20 };
const KW = { level: "keyword", scope: "ad_group", parent_id: "5", criterion_id: "9" };

describe("googleApproverRefusal", () => {
  it("a member demoted (or never promoted) after the click: a raise is refused with nothing changed; an owner/admin passes", async () => {
    expect(await googleApproverRefusal(row("google_ads.update_campaign_budget", RAISE), deps("member"))).toMatchObject({ code: "google_ads_admin_required", held_for_founder: true });
    expect(await googleApproverRefusal(row("google_ads.update_campaign_budget", RAISE), deps(null))).toMatchObject({ code: "google_ads_admin_required" });
    for (const r of ["owner", "admin"]) expect(await googleApproverRefusal(row("google_ads.update_campaign_budget", RAISE), deps(r))).toBeNull();
  });

  it("a role read error refuses (fail closed); a cut needs no role read; cgo/staff/unattended rows are not checked here", async () => {
    expect(await googleApproverRefusal(row("google_ads.update_campaign_budget", RAISE), deps(new Error("down")))).toMatchObject({ code: "google_ads_role_unavailable" });
    const d = deps("member");
    expect(await googleApproverRefusal(row("google_ads.update_campaign_budget", { ...RAISE, daily_budget_usd: 10 }), d)).toBeNull();
    expect(d.loadRole).not.toHaveBeenCalled();
    for (const over of [{ approved_by_source: "cgo" }, { approved_by_source: "staff" }, { approved_by: null }]) {
      expect(await googleApproverRefusal(row("google_ads.update_campaign_budget", RAISE, over), deps("member"))).toBeNull();
    }
  });

  it("removing a keyword is judged on the live keyword, never the stored flag", async () => {
    expect(await googleApproverRefusal(row("google_ads.remove_resource", { ...KW, criterion_negative: false }), deps("member", true))).toMatchObject({ code: "google_ads_admin_required" });
    expect(await googleApproverRefusal(row("google_ads.remove_resource", { ...KW, criterion_negative: true }), deps("member", false))).toBeNull();
    expect(await googleApproverRefusal(row("google_ads.remove_resource", KW), deps("member", new Error("api down")))).toMatchObject({ code: "google_ads_admin_required" });
  });

  it("adding keywords is judged on the same stored field the write uses", async () => {
    expect(await googleApproverRefusal(row("google_ads.add_keywords", { level: "ad_group", ad_group_id: "1", negative: false, keywords: [] }), deps("member"))).toMatchObject({ code: "google_ads_admin_required" });
    expect(await googleApproverRefusal(row("google_ads.add_keywords", { level: "ad_group", ad_group_id: "1", negative: true, keywords: [] }), deps("member"))).toBeNull();
  });
});
