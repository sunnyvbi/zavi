
import { describe, it, expect } from "vitest";
import { anyAdSetDelivering, buildPendingByCampaign } from "@/routes/agents/dashboard";

describe("anyAdSetDelivering (live delivery, covers Ads-Manager pauses)", () => {
  it("true when any non-deleted ad set is effective_status ACTIVE", () => {
    expect(
      anyAdSetDelivering([
        { effective_status: "PAUSED" },
        { effective_status: "ACTIVE" },
      ]),
    ).toBe(true);
  });

  it("false when every live ad set is paused (CAMPAIGN_PAUSED / ADSET_PAUSED / PAUSED)", () => {
    expect(
      anyAdSetDelivering([
        { effective_status: "CAMPAIGN_PAUSED" },
        { effective_status: "ADSET_PAUSED" },
        { effective_status: "PAUSED" },
      ]),
    ).toBe(false);
  });

  it("ignores DELETED/ARCHIVED ad sets when judging delivery", () => {
    expect(
      anyAdSetDelivering([
        { effective_status: "ARCHIVED" },
        { configured_status: "DELETED" },
        { effective_status: "ACTIVE" },
      ]),
    ).toBe(true);
  });

  it("FAILS OPEN (true) on an empty list — can't prove paused, never hide a money-control", () => {
    expect(anyAdSetDelivering([])).toBe(true);
  });

  it("FAILS OPEN (true) when only deleted/archived ad sets remain (no live signal)", () => {
    expect(
      anyAdSetDelivering([
        { effective_status: "ARCHIVED" },
        { configured_status: "DELETED" },
      ]),
    ).toBe(true);
  });

  it("delivering=true when the EDGE shows an ACTIVE ad set even though it had zero window spend (insights would miss it)", () => {
    const fullEdgeView = [
      { effective_status: "PAUSED" },
      { effective_status: "ACTIVE" },
    ];
    expect(anyAdSetDelivering(fullEdgeView)).toBe(true);
  });
});

describe("buildPendingByCampaign (in-product proposed changes only)", () => {
  it("maps a proposed budget edit by body.campaign_id", () => {
    const m = buildPendingByCampaign([
      {
        decision_class: "meta_ads.update_ad_set_budget_review",
        body: { campaign_id: "c1", ad_set_id: "as1", daily_budget_usd: 24 },
      },
    ]);
    expect(m.get("c1")).toEqual({ kind: "budget", label: "Budget change pending approval" });
  });

  it("maps a campaign-level pause by body.object_id + level=campaign", () => {
    const m = buildPendingByCampaign([
      {
        decision_class: "meta_ads.set_status_review",
        body: { object_id: "c2", level: "campaign", status: "PAUSED" },
      },
    ]);
    expect(m.get("c2")).toEqual({ kind: "status", label: "Pause pending approval" });
  });

  it("labels a campaign-level resume distinctly", () => {
    const m = buildPendingByCampaign([
      {
        decision_class: "meta_ads.set_status_review",
        body: { object_id: "c3", level: "campaign", status: "ACTIVE" },
      },
    ]);
    expect(m.get("c3")).toEqual({ kind: "status", label: "Resume pending approval" });
  });

  it("does NOT map an ad-set-level status decision (no campaign_id, no campaign object) — v1 has no ad-set→campaign resolution", () => {
    const m = buildPendingByCampaign([
      {
        decision_class: "meta_ads.set_status_review",
        body: { object_id: "as9", level: "adset", status: "PAUSED" },
      },
    ]);
    expect(m.size).toBe(0);
  });

  it("does NOT map a budget decision lacking campaign_id (an agent-originated proposal)", () => {
    const m = buildPendingByCampaign([
      {
        decision_class: "meta_ads.update_ad_set_budget_review",
        body: { ad_set_id: "as1", daily_budget_usd: 50 },
      },
    ]);
    expect(m.size).toBe(0);
  });

  it("first (newest) row per campaign wins the label", () => {
    const m = buildPendingByCampaign([
      {
        decision_class: "meta_ads.set_status_review",
        body: { object_id: "c1", level: "campaign", status: "PAUSED" },
      },
      {
        decision_class: "meta_ads.update_ad_set_budget_review",
        body: { campaign_id: "c1", daily_budget_usd: 10 },
      },
    ]);
    expect(m.get("c1")).toEqual({ kind: "status", label: "Pause pending approval" });
  });
});
