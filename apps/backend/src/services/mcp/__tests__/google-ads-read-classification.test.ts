import { describe, it, expect } from "vitest";
import { isSideEffectingTool } from "../tool-effect-classifier";

import { listGoogleAdsTools } from "../internal/google-ads";

const GOOGLE_ADS_READS = [
  "list_campaigns",
  "list_ad_groups",
  "conversion_tracking_health",
  "change_history",
  "conversion_lag",
  "search_terms",
  "campaign_diagnostics",
  "existing_negatives",
  "list_locations",
  "list_ads",
  "list_keywords",
  "list_video_campaigns",
  "video_performance",
] as const;

const GOOGLE_ADS_WRITES = [
  "propose_budget_change",
  "propose_status_change",
  "propose_new_campaign",
  "propose_campaign_update",
  "propose_new_ad_group",
  "propose_ad_group_update",
  "propose_new_ad",
  "propose_keywords",
  "propose_removal",
  "propose_video_campaign",
  "propose_video_ad",
  "propose_pmax_campaign",
] as const;

describe("google_ads tool-effect classification", () => {
  it.each(GOOGLE_ADS_READS)("classifies %s as a pure read", (tool) => {
    expect(isSideEffectingTool("google_ads", tool)).toBe(false);
  });

  it.each(GOOGLE_ADS_WRITES)("keeps %s guarded", (tool) => {
    expect(isSideEffectingTool("google_ads", tool)).toBe(true);
  });

  it("still fail-safes an unknown google_ads tool to guarded", () => {
    expect(isSideEffectingTool("google_ads", "some_future_mutation")).toBe(true);
  });

  it("the declared split covers exactly these lists (a new tool must be classified here)", () => {
    const declared = listGoogleAdsTools();
    const reads = declared.filter((t) => t.effect === "read").map((t) => t.tool_name).sort();
    const writes = declared.filter((t) => t.effect !== "read").map((t) => t.tool_name).sort();
    expect(reads).toEqual([...GOOGLE_ADS_READS].sort());
    expect(writes).toEqual([...GOOGLE_ADS_WRITES].sort());
  });
});
