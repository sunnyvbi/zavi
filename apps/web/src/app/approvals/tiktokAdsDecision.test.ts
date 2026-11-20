import { describe, expect, it } from "vitest";
import { decisionConsequence } from "./decisionCopy";
import { handlerPreview, isHighStakesDecision, outcomeAppName } from "./approvalsHelpers";
import { parseProposalView } from "@/components/agents/proposalView";
import { composioChatCardState, OWNER_OR_ADMIN_APPROVE_REASON } from "./composioChatCard";

const base = { advertiser_id: "111", advertiser_name: "Main", rationale: "No clicks in 7 days." };
const adPause = { ...base, level: "ad", object_id: "301", campaign_id: "101", ad_group_id: "201", ad_id: "301", name: "Spring ad", status: "PAUSED", expected_current_status: "ACTIVE", daily_budget_usd: null };
const budget = { ...base, level: "campaign", object_id: "101", campaign_id: "101", name: "Spring", expected_current_daily_budget_usd: 60, expected_current_status: "ACTIVE", daily_budget_usd: 90 };

describe("TikTok Ads approval cards", () => {
  it("names the action, the object and the change", () => {
    const v = parseProposalView("tiktok_ads.set_status", "tiktok_ads.set_status", adPause);
    expect(v.action).toBe("Pause this TikTok ad");
    expect(v.target).toBe("TikTok · Spring ad");
    expect(v.fields).toEqual([{ label: "Ad account", value: "Main (111)" }, { label: "Ad “Spring ad”", value: "Active → Paused" }]);
  });

  it("reads a budget change as a raise and shows the daily stake", () => {
    const v = parseProposalView("tiktok_ads.update_budget", "tiktok_ads.update_budget", budget);
    expect(v.action).toBe("Raise daily budget");
    expect(v.chips).toContainEqual({ label: "$90/day", tone: "neutral" });
    expect(handlerPreview("tiktok_ads.update_budget", budget)).toBe("→ TikTok · Spring · daily budget $60 → $90");
  });

  it("a member cannot press Approve on a spend card, but can on a pause", () => {
    const state = (cls: string, body: Record<string, unknown>) => composioChatCardState({ decision_class: cls, status: "proposed", body }, "member").approveBlockedReason;
    expect(state("tiktok_ads.update_budget", budget)).toBe(OWNER_OR_ADMIN_APPROVE_REASON);
    expect(state("tiktok_ads.create_launch", { name: "Launch", daily_budget_usd: 30 })).toBe(OWNER_OR_ADMIN_APPROVE_REASON);
    expect(state("tiktok_ads.set_status", adPause)).toBeNull();
  });

  it("is high stakes and points an unknown outcome at TikTok Ads", () => {
    expect(isHighStakesDecision("tiktok_ads.update_budget", "tiktok_ads.update_budget", budget)).toBe(true);
    expect(outcomeAppName("tiktok_ads.set_status", adPause)).toBe("TikTok Ads");
  });
});
