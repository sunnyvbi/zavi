export type GoogleRouteInput =
  | {
      op: "budget";
      within: boolean;
      forceApproval?: boolean;
    }
  | { op: "status"; status: "ENABLED" | "PAUSED"; capEnabled: boolean; forceApproval?: boolean };

export function pickGoogleDecisionClass(input: GoogleRouteInput): string {
  switch (input.op) {
    case "budget": {
      if (input.forceApproval === true) {
        return "google_ads.update_campaign_budget_review";
      }
      return input.within
        ? "google_ads.update_campaign_budget"
        : "google_ads.update_campaign_budget_review";
    }
    case "status":
      if (input.forceApproval !== true && input.status === "PAUSED" && input.capEnabled) {
        return "google_ads.set_status";
      }
      return "google_ads.set_status_review";
  }
}

export const GOOGLE_ADS_DECISION_CLASSES = {
  create_campaign: "google_ads.create_campaign",
  update_campaign: "google_ads.update_campaign",
  create_ad_group: "google_ads.create_ad_group",
  update_ad_group: "google_ads.update_ad_group",
  create_ad: "google_ads.create_ad",
  add_keywords: "google_ads.add_keywords",
  remove_resource: "google_ads.remove_resource",
} as const;

export type GoogleAdsFixedClass =
  (typeof GOOGLE_ADS_DECISION_CLASSES)[keyof typeof GOOGLE_ADS_DECISION_CLASSES];
