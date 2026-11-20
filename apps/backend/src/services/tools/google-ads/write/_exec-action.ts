
import type { ServerFounder } from "@/services/growth/founder-marks";
import { adChangeHeadline, type ActionType } from "@zavi/shared";
import { gadsChangeRows } from "./_change-rows";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import {
  resolveChannelExecEmit,
  type EmitDecisionFn,
  type ExecEmitCtx,
} from "@/services/channels/exec-emit";
import { MONEY_AT_STAKE_KEY } from "@/services/channels/money-at-stake-card";
import { readCardMoneyAtStake } from "./_stake-budget";

const SWITCHED_ADS_CHANNELS: ReadonlySet<string> = new Set(["google_ads", "youtube_ads"]);

export type { EmitDecisionFn, ExecEmitCtx };

export function execActionType(execClass: string, body: Record<string, unknown>): ActionType {
  if (execClass.startsWith("google_ads.set_status")) {
    return body.status === "PAUSED" ? "pause_ad" : "update_ad";
  }
  if (execClass === "google_ads.remove_resource") return "pause_ad";
  if (execClass.startsWith("google_ads.create_") || execClass === "google_ads.add_keywords") {
    return "create_ad";
  }
  return "update_ad";
}

export function buildExecCardBody(
  execClass: string,
  body: Record<string, unknown>,
): { title: string; card: Record<string, unknown> } {
  const change = gadsChangeRows(execClass, body);
  const ev = (body.decision_evidence ?? null) as Record<string, unknown> | null;
  const headline = typeof ev?.headline === "string" ? ev.headline.trim().slice(0, 80) : "";
  const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
  const sentence = change?.change_sentence ?? null;
  const serverTitle = adChangeHeadline(execClass, body);
  const title = serverTitle ?? ((headline.length >= 3 ? headline : change?.title) || `Apply ${execClass}`);
  const prose = [sentence, rationale].filter((s): s is string => !!s).join("\n\n");
  return {
    title: title.slice(0, 300),
    card: {
      step: {
        title: title.slice(0, 300),
        body: prose || title,
        blocking: false,
        effort: "minutes",
        evidence: Array.isArray(ev?.evidence)
          ? (ev.evidence as unknown[]).filter((e): e is string => typeof e === "string").slice(0, 10)
          : [],
      },
      change_sentence: sentence,
      exact_change: change && change.rows.length ? { rows: change.rows } : null,
      decision_evidence: ev,
      link: null,
    },
  };
}

export async function resolveGoogleAdsEmit(
  ctx: ExecEmitCtx,
  serverFounder: ServerFounder = null,
): Promise<EmitDecisionFn | undefined> {
  return resolveChannelExecEmit(SWITCHED_ADS_CHANNELS, ctx, async (a) => {
    const { title, card } = buildExecCardBody(a.decision_class, a.body);
    const stake = await readCardMoneyAtStake(a.tenant_id, a.decision_class, a.body);
    const { id } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: a.body,
      serverFounder,
      actionType: execActionType(a.decision_class, a.body),
      title,
      body: stake ? { ...card, [MONEY_AT_STAKE_KEY]: stake } : card,
    });
    return id;
  });
}
