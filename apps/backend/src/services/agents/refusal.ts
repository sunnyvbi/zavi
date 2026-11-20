
import { planWallMessage } from "@/services/agents/entitlement";
import type { Tier } from "@/services/billing/tiers";

export type RefusalAction = "top_up" | "upgrade" | "wait" | "none";

export type RefusalCode =
  | "insufficient_credits"
  | "insufficient_credits_for_build"
  | "out_of_credits"
  | "build_credits_exhausted"
  | "budget_exceeded"
  | "channel_budget_exhausted"
  | "cap_reached"
  | "daily_build_limit_reached"
  | "provision_budget_exceeded"
  | "budget_exhausted"
  | "plan_upgrade_required"
  | "free_edits_used";

export type Refusal = {
  code: RefusalCode;
  message: string;
  action: RefusalAction;
};

export type RefusalInput =
  | { kind: "credits" }
  | {
      kind: "credits_for_build";
      required_credits?: number;
      remaining_credits?: number;
      free_plan?: boolean;
      scope?: "build" | "change";
    }
  | { kind: "free_edits_used"; message: string }
  | { kind: "out_of_credits" }
  | { kind: "build_credits_exhausted" }
  | { kind: "budget_exceeded" }
  | { kind: "channel_budget_exhausted" }
  | { kind: "cap_reached" }
  | { kind: "daily_build_limit_reached" }
  | { kind: "budget_exhausted" }
  | { kind: "provision_budget_exceeded" }
  | { kind: "plan_upgrade"; slug: string; required_tier: Tier }
  | { kind: "custom_agents_plan" };

const OUT_OF_CREDITS =
  "You're out of credits for now. Your free daily credits come back at midnight UTC, or top up or upgrade in Billing to keep going today.";

export function refusalFor(input: RefusalInput): Refusal {
  switch (input.kind) {
    case "credits":
      return { code: "insufficient_credits", message: OUT_OF_CREDITS, action: "top_up" };

    case "out_of_credits":
      return { code: "out_of_credits", message: OUT_OF_CREDITS, action: "top_up" };

    case "credits_for_build":
      if (input.scope === "change") {
        return {
          code: "insufficient_credits_for_build",
          message: input.free_plan
            ? "The free plan's daily credits don't cover this change. Upgrade or top up in Billing, then send it again."
            : typeof input.required_credits === "number" &&
              typeof input.remaining_credits === "number"
              ? `This change needs about ${input.required_credits.toLocaleString()} credits and you have ${input.remaining_credits.toLocaleString()}. Top up or upgrade in Billing, then send it again.`
              : "You don't have enough credits for this change. Top up or upgrade in Billing, then send it again.",
          action: "top_up",
        };
      }
      return {
        code: "insufficient_credits_for_build",
        message: input.free_plan
          ? "The free plan's daily credits don't cover this build. Top up or pick a plan in Billing to start it."
          : typeof input.required_credits === "number" &&
          typeof input.remaining_credits === "number"
            ? `This build needs about ${input.required_credits.toLocaleString()} credits and you have ${input.remaining_credits.toLocaleString()}. Top up in Billing and start it again.`
            : "You don't have enough credits to finish this build. Top up in Billing and start it again.",
        action: "top_up",
      };

    case "build_credits_exhausted":
      return {
        code: "build_credits_exhausted",
        message:
          "This workspace is out of build credits. Top up in Billing to keep building.",
        action: "top_up",
      };

    case "budget_exceeded":
      return {
        code: "budget_exceeded",
        message:
          "This workspace has reached its spend limit for today. It resets tomorrow.",
        action: "wait",
      };

    case "channel_budget_exhausted":
      return {
        code: "channel_budget_exhausted",
        message:
          "This channel has used its budget for now. It frees up as the window rolls.",
        action: "wait",
      };

    case "cap_reached":
      return {
        code: "cap_reached",
        message:
          "This channel has hit its run cap for now. It frees up as the window rolls.",
        action: "wait",
      };

    case "daily_build_limit_reached":
      return {
        code: "daily_build_limit_reached",
        message: "You've used today's builds. You can start another tomorrow.",
        action: "wait",
      };

    case "budget_exhausted":
      return {
        code: "budget_exhausted",
        message:
          "This workspace has used its spend budget for now. It resets as the window rolls.",
        action: "wait",
      };

    case "provision_budget_exceeded":
      return {
        code: "provision_budget_exceeded",
        message:
          "This workspace has hit its provisioning budget, so nothing new can be set up right now.",
        action: "none",
      };

    case "free_edits_used":
      return { code: "free_edits_used", message: input.message, action: "upgrade" };

    case "custom_agents_plan":
      return {
        code: "plan_upgrade_required",
        message: "Custom agents are available on paid plans.",
        action: "upgrade",
      };

    case "plan_upgrade":
      return {
        code: "plan_upgrade_required",
        message: planWallMessage(input.slug, input.required_tier),
        action: "upgrade",
      };
  }
}

export function refusalText(input: RefusalInput): string {
  return refusalFor(input).message;
}
