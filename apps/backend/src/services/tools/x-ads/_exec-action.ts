import type { ActionType } from "@zavi/shared";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { resolveChannelExecEmit, type EmitDecisionFn, type ExecEmitCtx } from "@/services/channels/exec-emit";
import { ExpectedToolError } from "@/services/tools/types";
import { xCampaignsUrl } from "@/services/connectors/x-ads/client";
import { X_MANAGE_CLASS } from "@/services/connectors/x-ads/management-schema";

export const X_SET_STATUS_CLASS = "x_ads.set_status";
export const X_UPDATE_CAMPAIGN_CLASS = "x_ads.update_campaign";
export const X_CREATE_CAMPAIGN_CLASS = "x_ads.create_campaign";

const TITLES: Record<string, (b: Record<string, unknown>) => string> = {
  [X_MANAGE_CLASS]: (b) => `${String((b.request as { operation?: string } | undefined)?.operation ?? "change objects").replaceAll("_", " ")} in the X campaign "${b.name}"`,
  [X_SET_STATUS_CLASS]: (b) => (b.status === "PAUSED" ? `Pause the X campaign "${b.name}"` : `Turn the X campaign "${b.name}" back on`),
  [X_UPDATE_CAMPAIGN_CLASS]: (b) => `Change the X campaign "${b.name}"`,
  [X_CREATE_CAMPAIGN_CLASS]: (b) => `Start the X campaign "${b.name}"`,
};

function actionTypeFor(cls: string, body: Record<string, unknown>): ActionType {
  if (cls === X_CREATE_CAMPAIGN_CLASS) return "create_ad";
  return cls === X_SET_STATUS_CLASS && body.status === "PAUSED" ? "pause_ad" : "update_ad";
}

export function buildXExecCardBody(cls: string, body: Record<string, unknown>): { title: string; card: Record<string, unknown> } {
  const title = TITLES[cls](body).slice(0, 300);
  const sentence = String(body.summary ?? "");
  return {
    title,
    card: {
      step: { title, body: [sentence, String(body.rationale ?? "").trim()].filter(Boolean).join("\n\n"), blocking: false, effort: "minutes", evidence: [] },
      change_sentence: sentence,
      exact_change: body.exact_change ?? null,
      decision_evidence: null,
      link: xCampaignsUrl(String(body.account_id ?? (body.request as { account_id?: string } | undefined)?.account_id ?? "")),
    },
  };
}

export async function resolveXAdsEmit(ctx: ExecEmitCtx): Promise<EmitDecisionFn | undefined> {
  return resolveChannelExecEmit(new Set(["x_ads"]), ctx, async (a) => {
    if (!Object.hasOwn(TITLES, a.decision_class)) {
      throw new ExpectedToolError(
        "channel_action_class_unknown",
        `Zavi does not know where a ${a.decision_class} proposal belongs on this channel, so nothing was written. This is a Zavi bug, not something to retry.`,
      );
    }
    const { title, card } = buildXExecCardBody(a.decision_class, a.body);
    const { id } = await recordChannelExecAction({
      tenantId: a.tenant_id,
      runId: a.run_id,
      channelSlug: a.channel_slug,
      execClass: a.decision_class,
      execPayload: a.body,
      actionType: actionTypeFor(a.decision_class, a.body),
      title,
      body: card,
    });
    return id;
  });
}
