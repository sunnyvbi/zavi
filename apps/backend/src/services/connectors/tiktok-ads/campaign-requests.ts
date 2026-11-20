import { asTenantId, tenantClient } from "@/services/tenant-client";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { describeTiktokAction } from "@/services/tools/tiktok-ads/_exec-action";
import { tiktokAdsProposeLaunchTool } from "@/services/tools/tiktok-ads/launch";
import { tiktokAdsProposeBudgetChangeTool, tiktokAdsProposeStatusChangeTool } from "@/services/tools/tiktok-ads/propose_changes";
import { ExpectedToolError } from "@/services/tools/types";
import { readSettingsObject, proposeSettingsBody } from "./campaign-settings";
import { TIKTOK_SET_STATUS_CLASS, TIKTOK_UPDATE_BUDGET_CLASS } from "./held-schema";
import { tiktokCampaignsUrl } from "./composio-read";
import { isNoWriteEmitError } from "@/services/agents/emit-no-write";
import { CampaignFilingOutcomeUnknown } from "./campaign-request-errors";
import { logEvent } from "@/services/logging/logEvent";

const CHANNEL = "tiktok_ads";
const RATIONALE = "You requested this change in the TikTok campaign editor.";

async function file(tenantId: string, userId: string, cls: string, raw: unknown): Promise<string> {
  const payload: Record<string, unknown> = { ...(raw as Record<string, unknown>), origin: "user_initiated_ledger" };
  const description = describeTiktokAction(cls, payload);
  const now = new Date().toISOString();
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("agent_runs").insert({
    agent_slug: CHANNEL, channel_slug: CHANNEL, agent_definition_hash: "tiktok_founder_campaign_editor",
    trigger: "manual", status: "running", enqueued_at: now, started_at: now, finished_at: null,
    enqueued_by: userId, parse_ok: false, cost_tokens: 0, cost_usd: 0, tool_calls: [],
    output_text: "Preparing your campaign change for approval.",
    payload: { stage: "tiktok_founder_campaign_editor" },
  }).select("id");
  const runId = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (error || !runId) throw new Error("Could not record the campaign request.");
  const finish = async (status: "success" | "failed", text: string) => {
    const { error } = await tenantClient(asTenantId(tenantId)).from("agent_runs").update({
      status, parse_ok: status === "success", finished_at: new Date().toISOString(),
      output_text: text, error: status === "failed" ? text : null,
    }).eq("id", runId);
    if (error) throw new Error("Could not record the campaign request outcome.");
  };
  try {
    const out = await recordChannelExecAction({
      tenantId, runId, channelSlug: CHANNEL, execClass: cls, execPayload: payload,
      actionType: description.actionType, title: description.title,
      body: {
        step: { title: description.title, body: description.sentence, blocking: false, effort: "minutes", evidence: [] },
        change_sentence: description.sentence, exact_change: { rows: description.rows }, decision_evidence: null,
        link: tiktokCampaignsUrl(String(payload.advertiser_id)),
      },
    }, undefined, { enabled: () => false, cgoDoor: false });
    await finish("success", "A campaign change was prepared from your form. It awaits your approval.");
    return out.id;
  } catch (error: unknown) {
    const refused = isNoWriteEmitError(error);
    const unknown = new CampaignFilingOutcomeUnknown();
    const failure = refused ? error : unknown;
    await finish("failed", refused
      ? "The campaign change could not be submitted for approval. No approval card was created."
      : unknown.message).catch(() => {
        void logEvent({ level: "warn", source: "tiktok.campaign_request", code: "filing_outcome_not_saved", tenant_id: tenantId, run_id: runId });
      });
    throw failure;
  }
}

export async function requestCampaignCreation(tenantId: string, userId: string, inputs: Record<string, unknown>) {
  const result = await tiktokAdsProposeLaunchTool.execute({
    tenant_id: tenantId, agent_slug: CHANNEL, log: () => {}, top_action_run: true,
    emit_decision: (cls, body) => file(tenantId, userId, cls, body),
  }, { ...inputs, rationale: "You created this campaign in the TikTok campaign editor." });
  return result;
}

export type CampaignEditInput = {
  advertiser_id: string; campaign_id: string; level: "campaign" | "ad_group" | "ad";
  object_id: string; revision: string; changes: Record<string, unknown>;
};

export async function requestCampaignEdit(tenantId: string, userId: string, input: CampaignEditInput): Promise<{ action_id: string }> {
  const keys = Object.keys(input.changes);
  if (keys.length === 1 && (keys[0] === "daily_budget_usd" || keys[0] === "status")) {
    const current = await readSettingsObject(tenantId, input.advertiser_id, input.campaign_id, input.level, input.object_id);
    if (!current || current.revision !== input.revision) throw new ExpectedToolError("tiktok_ads_object_drifted", "These settings changed. Close and reopen the editor before trying again.");
    const tool = keys[0] === "daily_budget_usd" ? tiktokAdsProposeBudgetChangeTool : tiktokAdsProposeStatusChangeTool;
    let actionId: string | undefined;
    await tool.execute({ tenant_id: tenantId, agent_slug: CHANNEL, log: () => {}, emit_decision: async (cls, raw) => {
      const body = raw as Record<string, unknown>;
      const beforeBudget = cls === TIKTOK_UPDATE_BUDGET_CLASS ? body.expected_current_daily_budget_usd : body.daily_budget_usd;
      if (body.campaign_id !== input.campaign_id || body.object_id !== input.object_id || body.expected_current_status !== current.status ||
        (cls === TIKTOK_UPDATE_BUDGET_CLASS && beforeBudget !== current.budget) ||
        (cls === TIKTOK_SET_STATUS_CLASS && body.status === "ACTIVE" && !body.resume_plan && beforeBudget !== current.budget)) {
        throw new ExpectedToolError("tiktok_ads_object_drifted", "This campaign changed while you were editing. Reopen it before trying again.");
      }
      if (cls === TIKTOK_SET_STATUS_CLASS && body.status === "ACTIVE" && body.resume_plan) {
        const latest = await readSettingsObject(tenantId, input.advertiser_id, input.campaign_id, input.level, input.object_id);
        if (latest.revision !== current.revision) throw new ExpectedToolError("tiktok_ads_object_drifted", "This campaign changed while the resume was prepared. Refresh before trying again.");
      }
      actionId = await file(tenantId, userId, cls, body);
      return actionId;
    } }, { advertiser_id: input.advertiser_id, object_id: input.object_id, level: input.level, ...input.changes, rationale: RATIONALE });
    if (!actionId) throw new Error("No campaign change was recorded.");
    return { action_id: actionId };
  }
  const body = await proposeSettingsBody(tenantId, input);
  return { action_id: await file(tenantId, userId, "tiktok_ads.update_settings", body) };
}
