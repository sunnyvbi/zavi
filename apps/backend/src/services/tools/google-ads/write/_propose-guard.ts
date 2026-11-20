import type { ToolContext } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isGoogleAdsWriteEnabled } from "./_flag-check";

export type EmitDecision = NonNullable<ToolContext["emit_decision"]>;

export function withFounderOrigin<B>(ctx: ToolContext, body: B): B {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (!isHumanAuthoredCommand(ctx, "budget")) return body;
  return { ...(body as Record<string, unknown>), origin: "user_initiated_chat" } as B;
}

export async function assertGoogleAdsProposeAllowed(ctx: ToolContext): Promise<EmitDecision> {
  if (!(await isGoogleAdsWriteEnabled())) {
    throw new ExpectedToolError(
      "google_ads_write_disabled",
      "Google Ads write has been disabled at the platform level (system_config.google_ads_write_enabled kill switch is false). It is on by default — an operator must re-enable it before this tool will accept proposals.",
    );
  }
  if (typeof ctx.emit_decision !== "function") {
    throw new ExpectedToolError(
      "google_ads_propose_no_emit",
      "Cannot emit a decision in this context (no emit_decision plumbed).",
    );
  }
  const emit = ctx.emit_decision;
  return (decision_class, body) => emit(decision_class, withFounderOrigin(ctx, body));
}

export function displayFields(input: { name?: string; about?: string }): {
  name?: string;
  about?: string;
} {
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(input.about ? { about: input.about } : {}),
  };
}
