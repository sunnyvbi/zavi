
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
import { pickDecisionClass } from "./_class-router";
import { readTenantCapRowAndToday } from "./cap-reader";
import { evaluateCutGuard, briefForAdSet, briefForCampaign, isCgoOriginatedRun } from "./_cut-guard";
import { isUserInitiatedSpendApplyEnabled } from "./_user-initiated-flag-check";
import { simulateStatusWrite } from "./_simulate";
import { adSetSpend7d, fileFounderPauseCard, pausePastGuardBody } from "./_pause-past-guard";
import { logEvent } from "@/services/logging/logEvent";

const inputSchema = z.object({
  object_id: z.string().min(1).describe("Meta ad-set OR campaign ID."),
  level: z
    .enum(["campaign", "adset"])
    .describe("Which object the id refers to."),
  status: z
    .enum(["ACTIVE", "PAUSED"])
    .describe(
      "Target status. PAUSED auto-applies ONLY if the tenant has opted in via tenant_ads_write_caps.enabled=true; ACTIVE always waits for operator approval.",
    ),
  rationale: rationaleInput(),
  name: z
    .string()
    .optional()
    .describe(
      "The human-readable campaign/ad-set NAME (the `campaign_name` / `ad_set_name` from list_campaigns / list_ad_sets). ALWAYS pass this so the approval card shows which campaign it is instead of a raw numeric ID.",
    ),
  about: z
    .string()
    .optional()
    .describe(
      "ONE plain sentence describing what this campaign/ad set is about — its objective, audience, or role (e.g. 'Purchase-objective campaign targeting Denver homeowners'). ALWAYS pass this so the reviewer knows what they're approving without opening Meta.",
    ),
  current_status: z
    .enum(["ACTIVE", "PAUSED"])
    .optional()
    .describe(
      "The object's current status (read from list_campaigns / list_ad_sets). Only used to render the dry_run simulation's reopens_spend flag; ignored on the real propose path. When omitted, the simulation assumes the inverse of `status`.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "If true, returns a pure simulation of the status flip (before/after, whether it re-opens spend) and emits NO decision — zero side effect, no spend.",
    ),
});

export const metaProposeStatusChangeTool: ToolSpec = {
  name: "meta_ads_propose_status_change",
  effect: "write",
  description:
    "Propose pausing or resuming a Meta campaign or ad set. PAUSED proposals auto-apply within seconds IF the operator has opted in to write-caps (otherwise they wait for operator approval); ACTIVE (resume) proposals wait for the founder, or cgo can approve them when Autopilot runs the ads under a budget.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if (!(await isMetaAdsWriteEnabled())) {
      throw new ExpectedToolError(
        "meta_ads_write_disabled",
        "Meta Ads write is disabled at the platform level.",
      );
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "meta_ads_propose_no_emit",
        "Cannot emit a decision in this context (no emit_decision plumbed).",
      );
    }
    const args = inputSchema.parse(input);

    if (args.dry_run === true) {
      return {
        dry_run: true as const,
        simulation: simulateStatusWrite({
          object_id: args.object_id,
          level: args.level,
          current_status:
            args.current_status ?? (args.status === "ACTIVE" ? "PAUSED" : "ACTIVE"),
          target_status: args.status,
        }),
      };
    }

    let cutGuardNote: string | null = null;
    if (args.status === "PAUSED") {
      const founderOrder = isFounderChatOrder(ctx) && ctx.founder_order_unverified !== true;
      const operatorDirected =
        founderOrder || (isHumanAuthoredCommand(ctx, "status") && (await isUserInitiatedSpendApplyEnabled()));
      const brief =
        args.level === "adset"
          ? await briefForAdSet(ctx.tenant_id, args.object_id, new Date())
          : await briefForCampaign(ctx.tenant_id, args.object_id, new Date());
      const cgoOriginated = !operatorDirected && !brief && (await isCgoOriginatedRun(ctx.tenant_id, ctx.run_id, ctx.agent_slug));
      const cutVerdict = evaluateCutGuard(brief, { operatorDirected, cgoOriginated });
      const objection = founderOrder ? evaluateCutGuard(brief, { operatorDirected: false, cgoOriginated: false }) : null;
      if (objection?.block) {
        cutGuardNote = (objection.guidance ?? "").slice(0, 300) || null;
        void logEvent({ level: "info", source: "meta-ads.propose", code: "founder_order.guard_overridden", tenant_id: ctx.tenant_id, meta: { gate_reason: objection.reason ?? "unknown" } });
      }
      if (cutVerdict.block) {
        const emit = ctx.emit_decision;
        const founder_card =
          args.level === "adset" && /^[0-9]{1,64}$/.test(args.object_id)
            ? await fileFounderPauseCard(
                emit,
                ctx.tenant_id,
                pausePastGuardBody({
                  ad_set_id: args.object_id,
                  at: new Date(),
                  verdict: cutVerdict,
                  brief,
                  spend_7d_usd: await adSetSpend7d(ctx.tenant_id, args.object_id),
                  name: args.name,
                  about: args.about,
                  rationale: args.rationale,
                }),
              )
            : null;
        return {
          ok: false as const,
          blocked: true as const,
          code: cutVerdict.reason,
          message: cutVerdict.guidance,
          founder_card: founder_card
            ? founder_card.filed
              ? `Filed a card for the founder to pause it themselves (${founder_card.id}). Do not propose this pause again.`
              : founder_card.why === "already_today"
                ? "The founder already has a card to pause it themselves today. Do not propose this pause again."
                : founder_card.why === "in_progress"
                  ? "Another Zavi run is filing the founder's card to pause it right now. Do not propose this pause again."
                  : founder_card.why === "uncertain"
                    ? "Filing the founder's card failed partway and it may still appear. Do not propose this pause again."
                    : "No founder card was filed."
            : null,
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

    const { cap } = await readTenantCapRowAndToday(ctx.tenant_id);
    const capEnabled = !!cap?.enabled;

    const decision_class = pickDecisionClass({
      op: "status",
      status: args.status,
      capEnabled,
      forceApproval: hasUntrustedContext(ctx) || isUnverifiedEmailRun(ctx) || isRulesSteered(ctx, "status"),
    });
    const auto = decision_class === "meta_ads.set_status";
    const body = {
      object_id: args.object_id,
      level: args.level,
      status: args.status,
      rationale: args.rationale,
      over_cap: !auto,
      ...(args.name ? { name: args.name } : {}),
      ...(args.about ? { about: args.about } : {}),
      ...(cutGuardNote ? { cut_guard_note: cutGuardNote } : {}),
      ...(await (await import("@/services/tools/_object-daily-budget")).metaObjectDailyBudget(ctx.tenant_id, args.object_id)),
    };

    const decision_id = await ctx.emit_decision(decision_class, body);
    return {
      decision_id,
      decision_class,
      will_auto_apply: auto,
    };
  },
};
