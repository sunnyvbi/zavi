
import type { ServerFounder } from "@/services/growth/founder-marks";
import { type ActionType } from "@zavi/shared";
import { metaChangeRows } from "./_change-rows";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import {
  resolveChannelExecEmit,
  type EmitDecisionFn,
  type ExecEmitCtx,
} from "@/services/channels/exec-emit";
import { MONEY_AT_STAKE_KEY } from "@/services/channels/money-at-stake-card";
import { readMetaCardMoneyAtStake } from "./_stake-budget";
import { PENDING_STRATEGIST_CLASS } from "@/services/meta-ads/strategist-gate/constants";
import { ExpectedToolError } from "@/services/tools/types";

const SWITCHED_META_CHANNELS: ReadonlySet<string> = new Set(["meta_ads"]);

export type { EmitDecisionFn, ExecEmitCtx };

const EXECUTABLE_META_CLASSES: ReadonlySet<string> = new Set([
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget",
  "meta_ads.update_campaign_budget_review",
  "meta_ads.create_campaign",
  "meta_ads.update_campaign",
  "meta_ads.delete_campaign",
  "meta_ads.update_ad_set",
  "meta_ads.update_ad",
  "meta_ads.duplicate_ad",
  "meta_ads.create_creative",
  "meta_ads.update_creative",
  "meta_ads.upload_asset",
  "meta_ads.create_lookalike_audience",
  "meta_ads.create_custom_conversion",
  "meta_ads.create_lead_form",
  "meta_ads.set_status",
  "meta_ads.set_status_review",
  "meta_ads.pause_past_cut_guard",
  "meta_ads.replace_ad_set_geo_review",
  "meta_ads.create_ad_set",
  "meta_ads.duplicate_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.create_ad",
  "meta_ads.create_custom_audience",
  "meta_ads.launch_campaign",
]);

const INTERNAL_DECISION_CLASSES: ReadonlySet<string> = new Set([PENDING_STRATEGIST_CLASS]);

export function metaExecActionType(execClass: string, body: Record<string, unknown>): ActionType {
  if (execClass === "meta_ads.pause_past_cut_guard") return "pause_ad";
  if (execClass.startsWith("meta_ads.set_status")) {
    return body.status === "PAUSED" ? "pause_ad" : "update_ad";
  }
  if (execClass === "meta_ads.create_ad_set" || execClass === "meta_ads.create_campaign") return "create_ad";
  if (execClass === "meta_ads.delete_campaign") return "pause_ad";
  if (execClass === "meta_ads.update_ad" && body.status === "PAUSED") return "pause_ad";
  if (execClass === "meta_ads.duplicate_ad") return "create_ad";
  if (
    execClass === "meta_ads.create_creative" ||
    execClass === "meta_ads.upload_asset" ||
    execClass === "meta_ads.create_lookalike_audience" ||
    execClass === "meta_ads.create_custom_conversion" ||
    execClass === "meta_ads.create_lead_form"
  ) {
    return "setup";
  }
  if (
    execClass === "meta_ads.duplicate_ad_set" ||
    execClass === "meta_ads.duplicate_campaign" ||
    execClass === "meta_ads.create_ad" ||
    execClass === "meta_ads.launch_campaign"
  ) {
    return "create_ad";
  }
  return "update_ad";
}

export function buildMetaExecCardBody(
  execClass: string,
  body: Record<string, unknown>,
): { title: string; card: Record<string, unknown> } {
  const change = metaChangeRows(execClass, body);
  const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
  const about = typeof body.about === "string" ? body.about.trim() : "";
  const sentence = change?.change_sentence ?? null;
  const title = change?.title || `Apply ${execClass}`;
  const prose = [sentence, rationale, about].filter((s): s is string => !!s).join("\n\n");
  return {
    title: title.slice(0, 300),
    card: {
      step: {
        title: title.slice(0, 300),
        body: prose || title,
        blocking: false,
        effort: "minutes",
        evidence: [],
      },
      change_sentence: sentence,
      exact_change: change && change.rows.length ? { rows: change.rows } : null,
      decision_evidence: null,
      link: null,
    },
  };
}

export async function resolveMetaAdsEmit(
  ctx: ExecEmitCtx,
  serverFounder: ServerFounder = null,
): Promise<EmitDecisionFn | undefined> {
  return resolveChannelExecEmit(SWITCHED_META_CHANNELS, ctx, async (a) => {
    if (INTERNAL_DECISION_CLASSES.has(a.decision_class)) {
      return a.legacyEmit(a.decision_class, a.body);
    }
    if (!EXECUTABLE_META_CLASSES.has(a.decision_class)) {
      throw new ExpectedToolError(
        "channel_action_class_unknown",
        `Zavi does not know where a ${a.decision_class} proposal belongs on this channel, so nothing was written. This is a Zavi bug, not something to retry.`,
      );
    }

    const { title, card } = buildMetaExecCardBody(a.decision_class, a.body);
    const stake = await readMetaCardMoneyAtStake(a.tenant_id, a.decision_class, a.body);
    const { id } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: a.body,
      serverFounder,
      actionType: metaExecActionType(a.decision_class, a.body),
      title,
      body: stake ? { ...card, [MONEY_AT_STAKE_KEY]: stake } : card,
    });
    return id;
  });
}
