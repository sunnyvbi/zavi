
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import {
  isFounderChatOrder,
  isHumanAuthoredCommand,
  isUnverifiedEmailRun,
  hasUntrustedContext,
  isRulesSteered,
} from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { isUserInitiatedSpendApplyEnabled } from "./_user-initiated-flag-check";
import { readTenantCapAndToday } from "./cap-reader";
import { evaluateBudgetCap } from "./_cap-evaluator";
import { pickDecisionClass } from "./_class-router";
import { evaluateAgentUnsure, AUTHORIZED_EFFECTIVE_CAP } from "./_user-initiated";
import { cgoRunsAdsUnderBudget, evaluateLearningPhaseStep } from "./_step-guard";
import {
  hasGroundingTools,
  readRunToolNamesFromEvents,
} from "./_grounding-guard";
import { evaluateCutGuard, briefForAdSet, briefForCampaign, isCgoOriginatedRun } from "./_cut-guard";
import { isBudgetBrakeRun } from "./_brake-run";
import { simulateBudgetWrite } from "./_simulate";
import { logEvent } from "@/services/logging/logEvent";

const inputSchema = z.object({
  ad_set_id: z.string().min(1).optional().describe("Meta ad-set ID (numeric). Give this OR campaign_id."),
  campaign_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Meta campaign ID, ONLY for a campaign that sets its own daily budget (Advantage campaign budget: list_campaigns shows a campaign daily budget and its ad sets have none). Give this OR ad_set_id.",
    ),
  current_daily_budget_usd: z
    .number()
    .nonnegative()
    .describe(
      "The ad set's (or campaign's) current daily budget in the AD ACCOUNT's currency (the `currency` list_ad_sets returns, e.g. USD or INR). Read this from the `daily_budget_usd` field returned by `meta_ads__list_ad_sets`. Used for drift detection at dispatch — if it doesn't match Meta's live value the proposal is rejected.",
    ),
  proposed_daily_budget_usd: z
    .number()
    .positive()
    .describe("The new daily budget, in the ad account's currency (same unit as current_daily_budget_usd)."),
  name: z
    .string()
    .optional()
    .describe(
      "The human-readable ad-set NAME (the `ad_set_name` from list_ad_sets). ALWAYS pass this so the approval card shows which ad set it is instead of a raw numeric ID.",
    ),
  about: z
    .string()
    .optional()
    .describe(
      "ONE plain sentence describing what this ad set is about — its objective, audience, or role (e.g. 'Purchase-objective line for Spring Sale, the account's top ROAS performer'). ALWAYS pass this so the reviewer knows what they're approving without opening Meta.",
    ),
  rationale: rationaleInput()
    .describe(
      "Why this change makes sense. Surfaces on Growth next to the proposal.",
    ),
  match_confidence: z
    .enum(["exact", "ambiguous"])
    .optional()
    .describe(
      "How confident you are that `ad_set_id` is the EXACT, UNIQUE ad set the user named. Pass 'exact' ONLY when the user's named campaign/ad set resolved to one unambiguous ad_set_id (exact id or a unique name match). If multiple candidates matched, the name was fuzzy, or you guessed — pass 'ambiguous' (or omit; absent is treated as ambiguous). On a user-typed chat command this gates whether the change applies directly vs routes to approval: 'exact' + unambiguous + non-fat-finger applies immediately; anything else waits on Growth page. NEVER claim 'exact' to skip the gate — when unsure, ASK the user which campaign instead of proposing.",
    ),
  currently_delivering: z
    .boolean()
    .optional()
    .describe(
      "TRUE if this ad set is currently DELIVERING (its `effective_status` from `meta_ads__list_ad_sets` is 'ACTIVE' — i.e. Meta is actively spending on it). Set this whenever you propose a RAISE on a live ad set. A delivering ad set is in/past Meta's learning phase, so an oversized single-step raise (more than +30% of current, beyond a +$10/day floor) re-enters learning and throws away its optimization. When true, the platform FORCES such an oversized raise to operator approval even if it's under the dollar cap — a money-safety guard. Absent/false ⇒ no learning-phase guard applies (new/paused ad sets have no learning phase).",
    ),
  oversized_step_justified: z
    .boolean()
    .optional()
    .describe(
      "Set TRUE ONLY when you are DELIBERATELY proposing a single raise larger than the graduated +30% step on a delivering ad set AND you have explained why in `rationale` (e.g. the operator explicitly directed a large scale-up, or the ad set just exited learning with strong ROAS and the operator wants aggressive scaling). This does NOT make the change auto-apply — an oversized raise still routes to operator approval; it only records that the oversized step was intentional + justified rather than an accidental leap. Default false. Do NOT set this to dodge the guard — when in doubt, propose a +30% step instead.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "If true, returns a pure simulation of the change (before/after/delta/pct/cap-state) and emits NO decision — zero side effect, no spend. Use to preview 'what would this do?' before proposing for real.",
    ),
});

export const metaProposeBudgetChangeTool: ToolSpec = {
  name: "meta_ads_propose_budget_change",
  effect: "money",
  description:
    "Propose a Meta daily-budget change on an ad set, or on a campaign that sets its own budget. Does NOT spend — emits a decision routed to operator approval (over the tenant's cap) or auto-dispatch (within cap). Use this instead of trying to change Meta directly.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if (!(await isMetaAdsWriteEnabled())) {
      throw new ExpectedToolError(
        "meta_ads_write_disabled",
        "Meta Ads write is disabled at the platform level. The operator must flip system_config.meta_ads_write_enabled to true before this tool will accept proposals.",
      );
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "meta_ads_propose_no_emit",
        "Cannot emit a decision in this context — the runner did not plumb emit_decision (typical for tool calls outside an agent run).",
      );
    }
    const args = inputSchema.parse(input);
    if (!!args.ad_set_id === !!args.campaign_id) {
      throw new ExpectedToolError(
        "meta_ads_invalid_target",
        "Give exactly one of ad_set_id or campaign_id.",
      );
    }
    const level: "adset" | "campaign" = args.campaign_id ? "campaign" : "adset";
    const target = { key: level === "campaign" ? "campaign_id" : "ad_set_id", id: (args.campaign_id ?? args.ad_set_id) as string };

    const { cap, today_total_change_usd, currency, units_per_usd } = await readTenantCapAndToday(ctx.tenant_id);
    if (!Number.isFinite(units_per_usd) || units_per_usd <= 0) {
      throw new ExpectedToolError("meta_ads_fx_unavailable", "The ad account's exchange rate could not be read; nothing was proposed.");
    }
    const inUsd = (n: number) => n / units_per_usd;
    const evalRes = evaluateBudgetCap({
      proposed_daily_budget_usd: args.proposed_daily_budget_usd,
      current_daily_budget_usd: args.current_daily_budget_usd,
      today_total_change_usd,
      cap,
    });

    if (args.dry_run === true) {
      return {
        dry_run: true as const,
        simulation: simulateBudgetWrite({
          current_daily_budget_usd: args.current_daily_budget_usd,
          proposed_daily_budget_usd: args.proposed_daily_budget_usd,
          today_total_change_usd,
          cap,
        }),
      };
    }

    const userInitiatedFlagOn = await isUserInitiatedSpendApplyEnabled();
    const isUserChat = isHumanAuthoredCommand(ctx, "budget");
    const origin: "user_chat" | "agent" =
      isUserChat && userInitiatedFlagOn ? "user_chat" : "agent";

    const isDecrease = args.proposed_daily_budget_usd < args.current_daily_budget_usd;
    const brakeCut = isDecrease && (await isBudgetBrakeRun(ctx.tenant_id, ctx.run_id));
    let cutGuardNote: string | null = null;
    if (isDecrease && !brakeCut) {
      const brief =
        level === "campaign"
          ? await briefForCampaign(ctx.tenant_id, target.id, new Date())
          : await briefForAdSet(ctx.tenant_id, target.id, new Date());
      const founderOrder = isFounderChatOrder(ctx) && ctx.founder_order_unverified !== true;
      const operatorDirected = origin === "user_chat" || founderOrder;
      const cgoOriginated = !operatorDirected && !brief && (await isCgoOriginatedRun(ctx.tenant_id, ctx.run_id, ctx.agent_slug));
      const cutVerdict = evaluateCutGuard(brief, { operatorDirected, cgoOriginated });
      const objection = founderOrder ? evaluateCutGuard(brief, { operatorDirected: false, cgoOriginated: false }) : null;
      if (objection?.block) {
        cutGuardNote = (objection.guidance ?? "").slice(0, 300) || null;
        void logEvent({ level: "info", source: "meta-ads.propose", code: "founder_order.guard_overridden", tenant_id: ctx.tenant_id, meta: { gate_reason: objection.reason ?? "unknown" } });
      }
      if (cutVerdict.block) {
        return {
          ok: false as const,
          blocked: true as const,
          code: cutVerdict.reason,
          message: cutVerdict.guidance,
          analyst_brief: brief
            ? {
                funnel_label: brief.funnel_label,
                posture: brief.posture,
                settled_cutoff: brief.settled_cutoff,
                maturing_days: brief.maturing_days,
                settled: brief.settled,
              }
            : null,
        };
      }
    }

    const unsureRes = evaluateAgentUnsure({
      match_confidence: args.match_confidence,
      current_daily_budget_usd: inUsd(args.current_daily_budget_usd),
      proposed_daily_budget_usd: inUsd(args.proposed_daily_budget_usd),
    });

    const stepInput = {
      current_daily_budget_usd: inUsd(args.current_daily_budget_usd),
      proposed_daily_budget_usd: inUsd(args.proposed_daily_budget_usd),
      delivering: args.currently_delivering,
      justifiedOversizedStep: args.oversized_step_justified,
    };
    let stepGuard = evaluateLearningPhaseStep(stepInput);
    if (stepGuard.forceApproval && !isUserChat && (await cgoRunsAdsUnderBudget(ctx.tenant_id))) {
      stepGuard = evaluateLearningPhaseStep({ ...stepInput, cgoBudgetBounds: true });
    }

    const isRaise = args.proposed_daily_budget_usd > args.current_daily_budget_usd;
    const wouldAutoApply =
      origin === "agent" && evalRes.within && !stepGuard.forceApproval;
    let groundingForceApproval = false;
    if (isRaise && wouldAutoApply) {
      const toolNames = await readRunToolNamesFromEvents(
        ctx.tenant_id,
        ctx.run_id,
      );
      const grounded = toolNames !== null && hasGroundingTools(toolNames);
      groundingForceApproval = !grounded;
    }

    const decision_class = pickDecisionClass({
      op: "budget",
      level,
      within: evalRes.within,
      origin,
      flagOn: userInitiatedFlagOn,
      agentUnsure: unsureRes.unsure,
      forceApproval:
        stepGuard.forceApproval ||
        groundingForceApproval ||
        hasUntrustedContext(ctx) ||
        isUnverifiedEmailRun(ctx) ||
        isRulesSteered(ctx, "budget"),
    });

    const userChatAutoApply =
      origin === "user_chat" && !unsureRes.unsure && !stepGuard.forceApproval;

    const body = {
      [target.key]: target.id,
      daily_budget_usd: args.proposed_daily_budget_usd,
      expected_current_daily_budget_usd: args.current_daily_budget_usd,
      currency,
      rationale: args.rationale,
      over_cap: !evalRes.within,
      ...(!evalRes.within && evalRes.reason ? { cap_reason: evalRes.reason } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.about ? { about: args.about } : {}),
      ...(cutGuardNote ? { cut_guard_note: cutGuardNote } : {}),
      ...(origin === "user_chat" && args.match_confidence === "ambiguous" ? { match_unsure: "ambiguous_match" as const } : {}),
      ...(userChatAutoApply
        ? {
            origin: "user_initiated_chat" as const,
            authorized_effective_cap: AUTHORIZED_EFFECTIVE_CAP,
          }
        : {}),
    };

    const decision_id = await ctx.emit_decision(decision_class, body);
    return {
      decision_id,
      decision_class,
      within_cap: evalRes.within,
      cap_reason: evalRes.reason ?? null,
      origin,
      agent_unsure: unsureRes.unsure,
      agent_unsure_reason: unsureRes.reason ?? null,
      forced_to_approval_by_step_guard: stepGuard.forceApproval,
      step_guard_reason: stepGuard.reason ?? null,
      step_pct: stepGuard.step_pct ?? null,
      forced_to_approval_by_grounding: groundingForceApproval,
      brake_cut: brakeCut,
    };
  },
};
