
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { isGoogleAdsWriteEnabled } from "./_flag-check";
import { readTenantGoogleCapAndToday } from "./cap-reader";
import { evaluateBudgetCap } from "@/services/tools/meta-ads/write/_cap-evaluator";
import { cgoRunsAdsUnderBudget, evaluateLearningPhaseStep } from "@/services/tools/meta-ads/write/_step-guard";
import { pickGoogleDecisionClass } from "./_class-router";
import { hasUntrustedContext, isHumanAuthoredCommand, isRulesSteered } from "@/services/agents/untrusted-context";
import { assertNotVideoCampaign } from "./_video-guard";
import { withFounderOrigin } from "./_propose-guard";

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  campaign_id: z.string().min(1).describe("Google Ads campaign ID (numeric)."),
  current_daily_budget_usd: z
    .number()
    .nonnegative()
    .describe(
      "The campaign's current daily budget in USD. Read this from the `spend_usd` context / the campaign's live budget. Used for drift detection at dispatch — if it doesn't match Google's live value the proposal is rejected.",
    ),
  proposed_daily_budget_usd: z
    .number()
    .positive()
    .describe("The new daily budget in USD."),
  name: z
    .string()
    .optional()
    .describe(
      "The human-readable campaign NAME (the `campaign_name` from google_ads__list_campaigns). ALWAYS pass this so the approval card shows which campaign it is instead of a raw numeric ID.",
    ),
  about: z
    .string()
    .optional()
    .describe(
      "ONE plain sentence describing what this campaign is about — its objective, audience, or role. ALWAYS pass this so the reviewer knows what they're approving without opening Google Ads.",
    ),
  rationale: rationaleInput()
    .describe(
      "Why this change makes sense. Surfaces on Growth next to the proposal.",
    ),
  currently_delivering: z
    .boolean()
    .optional()
    .describe(
      "TRUE if this campaign is currently DELIVERING (its status is 'ENABLED' and it is actively spending). Set this whenever you propose a RAISE on a live campaign. A delivering campaign that gets an oversized single-step raise (more than +30% of current, beyond a +$10/day floor) throws away its optimization. When true, the platform FORCES such an oversized raise to operator approval even if it's under the dollar cap — a money-safety guard. Absent/false ⇒ no learning-phase guard applies.",
    ),
  oversized_step_justified: z
    .boolean()
    .optional()
    .describe(
      "Set TRUE ONLY when you are DELIBERATELY proposing a single raise larger than the graduated +30% step on a delivering campaign AND you have explained why in `rationale`. This does NOT make the change auto-apply — an oversized raise still routes to operator approval; it only records that the oversized step was intentional. Default false. Do NOT set this to dodge the guard.",
    ),
});

export const googleProposeBudgetChangeTool: ToolSpec = {
  name: "google_ads_propose_budget_change",
  effect: "money",
  description:
    "Propose a Google Ads campaign daily-budget change. Does NOT spend — emits a decision routed to operator approval (over the tenant's cap) or auto-dispatch (within cap). Use this instead of trying to change Google Ads directly. On by default; the google_ads_write_enabled platform kill switch can disable it.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if (!(await isGoogleAdsWriteEnabled())) {
      throw new ExpectedToolError(
        "google_ads_write_disabled",
        "Google Ads write has been disabled at the platform level (system_config.google_ads_write_enabled kill switch is false). It is on by default — an operator must re-enable it before this tool will accept proposals.",
      );
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "google_ads_propose_no_emit",
        "Cannot emit a decision in this context — the runner did not plumb emit_decision (typical for tool calls outside an agent run).",
      );
    }
    const args = inputSchema.parse(input);
    await assertUsdGoogleAccount(ctx, "budgets");
    await assertNotVideoCampaign(ctx.tenant_id, args.campaign_id);

    const { cap, today_total_change_usd } = await readTenantGoogleCapAndToday(
      ctx.tenant_id,
    );
    const evalRes = evaluateBudgetCap({
      proposed_daily_budget_usd: args.proposed_daily_budget_usd,
      current_daily_budget_usd: args.current_daily_budget_usd,
      today_total_change_usd,
      cap,
    });

    const stepInput = {
      current_daily_budget_usd: args.current_daily_budget_usd,
      proposed_daily_budget_usd: args.proposed_daily_budget_usd,
      delivering: args.currently_delivering,
      justifiedOversizedStep: args.oversized_step_justified,
    };
    let stepGuard = evaluateLearningPhaseStep(stepInput);
    if (stepGuard.forceApproval && !isHumanAuthoredCommand(ctx, "budget") && (await cgoRunsAdsUnderBudget(ctx.tenant_id))) {
      stepGuard = evaluateLearningPhaseStep({ ...stepInput, cgoBudgetBounds: true });
    }

    const decision_class = pickGoogleDecisionClass({
      op: "budget",
      within: evalRes.within,
      forceApproval: stepGuard.forceApproval || isRulesSteered(ctx, "budget") || hasUntrustedContext(ctx),
    });

    const body = {
      campaign_id: args.campaign_id,
      daily_budget_usd: args.proposed_daily_budget_usd,
      expected_current_daily_budget_usd: args.current_daily_budget_usd,
      rationale: args.rationale,
      decision_evidence: buildGoogleAdsDecisionEvidence("budget", args.rationale, args),
      over_cap: !evalRes.within,
      ...(!evalRes.within && evalRes.reason ? { cap_reason: evalRes.reason } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.about ? { about: args.about } : {}),
    };

    const decision_id = await ctx.emit_decision(decision_class, withFounderOrigin(ctx, body));
    return {
      decision_id,
      decision_class,
      within_cap: evalRes.within,
      cap_reason: evalRes.reason ?? null,
      forced_to_approval_by_step_guard: stepGuard.forceApproval,
      step_guard_reason: stepGuard.reason ?? null,
      step_pct: stepGuard.step_pct ?? null,
    };
  },
};
