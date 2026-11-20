import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { REDDIT_ACTION_SCHEMAS, redditId, operationKey, type RedditActionClass } from "@/services/connectors/reddit-ads/schema";
import { ownedAccount } from "@/services/connectors/reddit-ads/adapter";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { CORRECTABLE_CODES, CORRECT_PLAN_STEP, requestHash } from "@/services/connectors/reddit-ads/operations";
import { inngest } from "../../../../workers/client";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";

const operationInput = z.object({ operation_key: operationKey, ad_account_id: redditId, level: z.enum(["campaign", "ad_group", "ad"]).optional() }).strict();
const descriptions: Record<RedditActionClass, string> = {
  "reddit_ads.authorize_account": "Propose founder approval of a Reddit account, one active workspace goal (goal_id from check_readiness autopilot.active_goals; this run's goal when it has one), maximum daily and campaign lifetime budgets, permitted geolocations and expiry. Founder-only approval grants CGO operating authority; it never launches ads. One open card per account: a second proposal returns the open one. Autopilot, channel autorun and the shared budget must also be active.",
  "reddit_ads.prepare_campaign": "Propose a complete Standard traffic campaign (CLICKS, CPC, BIDLESS), one daily-budget ad group and 1–5 website image ads. All objects are created PAUSED after approval. start_time is ISO 8601 with Z or a UTC offset; the lifetime cap is at least $100. Use a unique operation_key and reuse it for recovery; use a new one only when the result says to correct the plan. USD only; an owned pixel is required. Each ad's picture is image_artifact_id (an image Zavi made for this workspace, e.g. report__render_social_image; signed only when the approved preparation creates the ad), image_path (a photo the founder attached in chat, its exact image_path from the stored photo references) or image_url (a public https JPG or PNG). No money is spent by preparation.",
  "reddit_ads.launch_campaign": "Propose enabling a fully prepared campaign by its original operation_key (check_readiness autopilot.prepared_not_launched). Refused when nothing is prepared under that key. Rechecks settings, ownership, pixel, founder edits, Autopilot and shared budget immediately before writing. Separate approval from preparation. Enabled or under review is not confirmed delivery.",
  "reddit_ads.update_budget": "Propose changing a non-CBO Reddit ad group's DAILY_SPEND budget in USD, with an expected current budget for drift detection. Increases reserve the shared budget first. Every budget change waits for the founder.",
  "reddit_ads.update_targeting": "Propose replacing one ad group's geolocations, excluded geolocations, communities and interests with the whole new targeting. Supply expected_modified_at from read_objects. Founder approval required. The pixel, objective and budget are not changed here.",
  "reddit_ads.update_ad": "Propose changing one ad's click link (destination_url) for tracking: it must be the same page as the ad's image post, only query parameters or the fragment may differ. Supply expected_modified_at from read_objects. Founder approval required. A different page, a new picture or a new headline is propose_replace_creative, never this.",
  "reddit_ads.replace_creative": "Propose a new image post and a new PAUSED ad in an owned ad group, with a new headline, picture (image_artifact_id, image_path or image_url, as for a preparation) and destination. The existing ad is untouched. Use a new unique operation_key and reuse it for recovery. Turning the new ad on, and pausing the old one, are separate set_object_status proposals.",
  "reddit_ads.rename_object": "Propose a new name for a campaign, ad group or ad, as the founder asked. Supply expected_modified_at from read_objects and the founder's new name as new_name; name is the object's current name. Nothing else changes. Founder approval required; Autopilot never approves it.",
  "reddit_ads.remove_object": "Propose archiving (mode archive) or deleting (mode delete) a campaign, ad group or ad, only when the founder asked for it. Archive needs the object PAUSED first (propose set_object_status PAUSED before it if it is on); delete needs it already ARCHIVED, and Reddit allows the delete only some hours after archiving. Neither can be undone. Supply expected_modified_at from read_objects. An owner or admin must approve; Autopilot never does.",
  "reddit_ads.set_object_status": "Propose PAUSED or ACTIVE on a campaign, ad group or ad. Supply expected_modified_at from read_objects. Founder approval required, including performance pauses; ACTIVE holds the ad group's daily budget first and an owner or admin must approve it. A campaign with several ad groups is turned on one ad group at a time.",
};
const proposals: Array<{ name: string; cls: RedditActionClass }> = [
  { name: "reddit_ads_propose_authorize_account", cls: "reddit_ads.authorize_account" },
  { name: "reddit_ads_propose_prepare_campaign", cls: "reddit_ads.prepare_campaign" },
  { name: "reddit_ads_propose_launch_campaign", cls: "reddit_ads.launch_campaign" },
  { name: "reddit_ads_propose_update_budget", cls: "reddit_ads.update_budget" },
  { name: "reddit_ads_propose_update_targeting", cls: "reddit_ads.update_targeting" },
  { name: "reddit_ads_propose_update_ad", cls: "reddit_ads.update_ad" },
  { name: "reddit_ads_propose_replace_creative", cls: "reddit_ads.replace_creative" },
  { name: "reddit_ads_propose_set_object_status", cls: "reddit_ads.set_object_status" },
  { name: "reddit_ads_propose_rename_object", cls: "reddit_ads.rename_object" },
  { name: "reddit_ads_propose_remove_object", cls: "reddit_ads.remove_object" },
];
async function cardBody(ctx: Parameters<ToolSpec["execute"]>[0], cls: RedditActionClass, input: unknown): Promise<Record<string, unknown>> {
  const parsed = REDDIT_ACTION_SCHEMAS[cls].parse(input) as Record<string, unknown>;
  const body: Record<string, unknown> = { ...parsed, origin: isHumanAuthoredCommand(ctx, "budget") ? "user_initiated_chat" : "specialist" };
  if (cls === "reddit_ads.prepare_campaign" || cls === "reddit_ads.replace_creative") {
    const { checkCreativeImage } = await import("@/services/connectors/reddit-ads/creative-images");
    const creatives = cls === "reddit_ads.prepare_campaign" ? (body as { creatives: Array<{ image_url?: string; image_artifact_id?: string; image_path?: string }> }).creatives : [(body as { creative: { image_url?: string; image_artifact_id?: string; image_path?: string } }).creative];
    for (const c of creatives) await checkCreativeImage(ctx.tenant_id, c);
  }
  return body;
}

async function openAuthorizeCard(tenantId: string, accountId: string): Promise<{ action_id: string; failed: boolean } | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("id,status,exec_status,exec_payload")
    .eq("channel_slug", "reddit_ads")
    .eq("exec_class", "reddit_ads.authorize_account")
    .in("status", ["pending", "snoozed", "acted"])
    .order("proposed_at", { ascending: false })
    .limit(50);
  if (error) throw new ExpectedToolError("reddit_ads_cards_unreadable", "Zavi could not check whether this account already has an authorization card waiting, so nothing was proposed. Try again in a minute.");
  type Row = { id: string; status: string; exec_status: string | null; exec_payload: Record<string, unknown> | null };
  const mine = ((data ?? []) as Row[]).filter((r) => r.exec_payload?.ad_account_id === accountId);
  const waiting = mine.find((r) => r.status === "pending" || r.status === "snoozed");
  if (waiting) return { action_id: waiting.id, failed: waiting.exec_status === "failed" };
  const running = mine.find((r) => r.exec_status === "queued" || r.exec_status === "dispatching");
  return running ? { action_id: running.id, failed: false } : null;
}

function alreadyOpen(open: { action_id: string; failed: boolean }) {
  return {
    action_id: open.action_id,
    approval_required: true,
    execution_state: open.failed ? "failed" : "awaiting_approval",
    delivery_state: "unconfirmed",
    already_open: true,
    failure_reason: open.failed ? "This account's authorization card is still on the Actions tab after its last attempt failed." : null,
    next_recovery_step: open.failed
      ? "Tell the founder to approve that card again or reject it on the Reddit Ads Actions tab; new limits can be proposed once it is gone. Do not propose another now."
      : "This account already has an authorization card waiting for the founder. Do not propose another; it is the next step.",
  };
}

async function assertActiveGoal(tenantId: string, goalId: string): Promise<void> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("autopilot_goals").select("id,status").eq("id", goalId).maybeSingle<{ id: string; status: string }>();
  if (error) throw new ExpectedToolError("reddit_ads_goal_unreadable", "Zavi could not read the workspace's goals, so nothing was proposed. Try again in a minute.");
  if (data?.status !== "active") throw new ExpectedToolError("reddit_ads_goal_invalid", `Goal ${goalId} is not an active goal of this workspace, so nothing was proposed. Fix: use a goal_id from reddit_ads__check_readiness autopilot.active_goals.`);
}

const proposalTools: ToolSpec[] = proposals.map(({ name, cls }) => {
  const schema = REDDIT_ACTION_SCHEMAS[cls];
  return {
  name,
  effect: "write", description: descriptions[cls], input_schema: schema,
  async execute(ctx, input) {
    schema.parse(input);
    if (!ctx.emit_decision) throw new ExpectedToolError("reddit_ads_propose_not_channel_run", "Start a Reddit Ads channel run to propose this action through its approval ledger.");
    const ad_account_id = (input as { ad_account_id: string }).ad_account_id;
    await ownedAccount(ctx.tenant_id, ad_account_id);
    if (cls === "reddit_ads.authorize_account") {
      const open = await openAuthorizeCard(ctx.tenant_id, ad_account_id);
      if (open) return alreadyOpen(open);
      await assertActiveGoal(ctx.tenant_id, (input as { goal_id: string }).goal_id);
    }
    const body = await cardBody(ctx, cls, input);
    if (cls === "reddit_ads.launch_campaign") await (await import("@/services/growth/pending-test-claim")).assertRedditLaunchRoom(ctx, body as { operation_key: string; ad_account_id: string });
    let action_id: string;
    try {
      action_id = await ctx.emit_decision(cls, body);
    } catch (e) {
      const open = cls === "reddit_ads.authorize_account" ? await openAuthorizeCard(ctx.tenant_id, ad_account_id).catch(() => null) : null;
      if (!open) throw e;
      return alreadyOpen(open);
    }
    const { data, error } = await tenantClient(asTenantId(ctx.tenant_id)).from("channel_actions").select("exec_status,exec_result,approved_by_source").eq("id", action_id).maybeSingle<{ exec_status: string | null; exec_result: unknown; approved_by_source: string | null }>();
    if (error || !data) return { action_id, approval_required: true, execution_state: "proposed", delivery_state: "unconfirmed", failure_reason: "Approval state could not be read", next_recovery_step: "Open the Reddit Ads Actions tab to check this action before proposing another." };
    return { action_id, approval_required: data.exec_status === null || data.exec_status === "failed", execution_state: data.exec_status ?? "awaiting_approval", delivery_state: "unconfirmed", approved_by_source: data.approved_by_source, result: data.exec_result, failure_reason: null, next_recovery_step: data.exec_status ? "Read the action result before continuing." : "Approve the action from the Reddit Ads Actions tab." };
  },
}; });
export const redditLifecycleTools: ToolSpec[] = [
  { name: "reddit_ads_read_operation", effect: "read", description: "Read and reconcile persisted preparation/launch steps through platform reads, including IDs and uncertain outcomes after partial completion or restart. Supply the selected account; for action_<action_id> patch keys supply the object level. Never recreate an unknown step. Missing or ambiguous matches require review.", input_schema: operationInput,
    async execute(ctx, input) { const b = operationInput.parse(input);
      const db = tenantClient(asTenantId(ctx.tenant_id));
      const initial = await db.from("reddit_ad_operations").select("action_id,state").eq("operation_key", b.operation_key).order("updated_at", { ascending: false }).limit(100);
      if (initial.error) throw initial.error;
      const actions = (initial.data ?? []) as Array<{ action_id: string; state: string }>;
      const pending = actions.find((a) => a.state === "unknown" || a.state === "running");
      const actionId = pending?.action_id ?? actions[0]?.action_id;
      if (!actionId) return { operation_key: b.operation_key, steps: [], failure_reason: "Operation not found in this workspace", next_recovery_step: "Check the original operation key." };
      const recovered = await (await import("@/services/connectors/reddit-ads/reconcile")).reconcileRedditOperation(ctx.tenant_id, b.operation_key, actionId, b.ad_account_id, b.level);
      const { data, error } = await db.from("reddit_ad_operations").select("step,state,result,updated_at").eq("operation_key", b.operation_key).order("created_at");
      if (error) throw error;
      let failureReason: string | null = null;
      if (!recovered.unresolved) {
        try { await inngest.send({ id: `reddit-recovery:${actionId}:${requestHash({ steps: data })}`, name: "channel-action.exec-reconcile", data: { action_id: actionId } }); }
        catch { failureReason = "Platform steps were recovered, but the approval reconciliation worker could not be queued. Read this operation again to retry settlement."; }
      }
      const failed = ((data ?? []) as Array<{ step: string; state: string; result: { error?: unknown; code?: unknown } | null }>).find((row) => row.state === "failed");
      const failedReason = failed ? `Step ${failed.step} failed: ${typeof failed.result?.error === "string" ? failed.result.error : "Reddit refused it"}` : null;
      const failedStep = failed ? (CORRECTABLE_CODES.includes(String(failed.result?.code)) ? CORRECT_PLAN_STEP : "Resolve the cause, then approve the original action again; completed steps are retained.") : null;
      const executionState = recovered.unresolved ? "outcome_unknown" : failed ? "failed" : "reconciled";
      return { action_id: actionId, operation_key: b.operation_key, external_ids: recovered.ids, steps: data, execution_state: executionState, failed_step: failed?.step ?? null, failure_reason: failureReason ?? failedReason, next_recovery_step: failureReason ?? (recovered.unresolved ? "Review missing or ambiguous matches in Reddit Ads Manager. No duplicate will be created." : failedStep ?? "The approval reconciliation worker can now settle the action. Continue its remaining steps with the same operation key.") }; } },
  ...proposalTools,
];
