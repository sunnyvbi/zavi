
import { PENDING_STRATEGIST_CLASS } from "@/services/meta-ads/strategist-gate/constants";

export type RouteInput =
  | {
      op: "budget";
      within: boolean;
      origin?: "user_chat" | "agent";
      flagOn?: boolean;
      agentUnsure?: boolean;
      forceApproval?: boolean;
      level?: "adset" | "campaign";
    }
  | {
      op: "status";
      status: "ACTIVE" | "PAUSED";
      capEnabled: boolean;
      forceApproval?: boolean;
    }
  | { op: "create" };

export function pickDecisionClass(input: RouteInput): string {
  switch (input.op) {
    case "budget": {
      const [auto, review] =
        input.level === "campaign"
          ? ["meta_ads.update_campaign_budget", "meta_ads.update_campaign_budget_review"]
          : ["meta_ads.update_ad_set_budget", "meta_ads.update_ad_set_budget_review"];
      if (input.forceApproval === true) return review;
      if (input.origin === "user_chat" && input.flagOn === true) {
        return input.agentUnsure === true ? review : auto;
      }
      return input.within ? auto : review;
    }
    case "status":
      if (input.forceApproval === true) {
        return "meta_ads.set_status_review";
      }
      if (input.status === "PAUSED" && input.capEnabled) {
        return "meta_ads.set_status";
      }
      return "meta_ads.set_status_review";
    case "create":
      return PENDING_STRATEGIST_CLASS;
  }
}
