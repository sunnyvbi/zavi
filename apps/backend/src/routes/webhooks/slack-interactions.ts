
import type { Request, Response } from "express";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { slackFetch } from "@/services/tools/slack/_client";
import { verifySlackSignature } from "@/services/slack/verify-signature";
import { resolveSlackApprover } from "@/services/slack/resolve-member";
import { decideOnDecision, type DecideAction } from "@/services/approvals/decide-service";
import { decisionClosedElsewhere } from "@/services/approvals/decision-closed";
import { UNEDITABLE_FIELD_HINT } from "@/services/connectors/social-publish-content-guard";
import { refreshApprovalCard } from "@/services/slack/approval-post-target";
import {
  SLACK_ACTION_APPROVE,
  SLACK_ACTION_APPROVE_ALWAYS,
  SLACK_ACTION_REJECT,
  SLACK_ACTION_APPROVE_ALL,
  SLACK_ACTION_REJECT_ALL,
  SLACK_ACTION_EDIT,
  EDIT_CALLBACK_ID,
  EDIT_BUDGET_ACTION_ID,
  isEditableBudgetClass,
  readProposedDailyBudget,
  buildEditBudgetModal,
  readBodyCurrency,
  parseBatchValue,
  parseApproveValue,
} from "@/services/approvals/slack-approval-blocks";
import {
  SLACK_ACTION_CUSTOM_AGENT_CONFIRM,
  runCustomAgentConfirm,
  parseConfirmButtonValue,
  CONFIRM_INVALID_REPLY,
  CONFIRM_FAILED_REPLY,
} from "@/services/agents/custom-agent-chat";
import { SLACK_ACTION_RULE_DISMISS, SLACK_ACTION_RULE_SAVE } from "@/services/rules/slack";
import { RuleError, activateRule, dismissRule } from "@/services/rules/store";

type SlackBlockAction = { action_id?: string; value?: string };
type SlackViewStateField = { value?: string; selected_option?: { value?: string } };
type SlackView = {
  callback_id?: string;
  private_metadata?: string;
  state?: { values?: Record<string, Record<string, SlackViewStateField>> };
};
type SlackInteractionPayload = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  response_url?: string;
  trigger_id?: string;
  actions?: SlackBlockAction[];
  view?: SlackView;
  message?: { text?: string; blocks?: unknown[] };
};

const ORACLE_CALLBACK_IDS = new Set<string>([
  "oracle_did_it_work",
  "oracle_fact_check",
]);

function viewFieldValue(view: SlackView | undefined, actionId: string): string {
  const blocks = view?.state?.values ?? {};
  for (const block of Object.values(blocks)) {
    const field = block?.[actionId];
    if (field) return String(field.selected_option?.value ?? field.value ?? "");
  }
  return "";
}

export function scheduleMovedSentence(current: string | null): string {
  const ms = current ? new Date(current).getTime() : NaN;
  if (Number.isNaN(ms)) return "This was changed to publish when approved. Approve again?";
  const unix = Math.floor(ms / 1000);
  return `This was moved to <!date^${unix}^{date_short_pretty} at {time}|${new Date(ms).toISOString()}>. Approve again?`;
}

function replyEphemeral(responseUrl: string, text: string): void {
  void fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  }).catch((e) => console.warn(`[slack-interactions] ephemeral reply failed: ${(e as Error).message}`));
}

function updateSlackMessage(responseUrl: string, text: string): void {
  void fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
  }).catch((e) =>
    console.warn(`[slack-interactions] response_url update failed: ${(e as Error).message}`),
  );
}

function ephemeralSlackReply(responseUrl: string, text: string): void {
  void fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
  }).catch((e) =>
    console.warn(`[slack-interactions] response_url reply failed: ${(e as Error).message}`),
  );
}

async function handleRuleAction(
  payload: SlackInteractionPayload,
  actionId: string,
  ruleId: string,
  res: Response,
): Promise<void> {
  const teamId = String(payload.team?.id ?? "");
  const slackUserId = String(payload.user?.id ?? "");
  if (!teamId || !slackUserId || !/^[0-9a-f-]{36}$/i.test(ruleId)) {
    res.status(403).json({ error: { code: "unresolved_actor", message: "missing team, user or rule" } });
    return;
  }
  const svc = serviceClient();
  const { data: meta, error: metaErr } = await svc
    .from("slack_workspaces")
    .select("tenant_id")
    .eq("team_id", teamId)
    .maybeSingle();
  if (metaErr || !meta?.tenant_id) {
    res.status(403).json({ error: { code: "unknown_team", message: "no tenant for slack team" } });
    return;
  }
  const tenantId = meta.tenant_id as string;
  const actorId = await resolveSlackApprover(svc, {
    tenant_id: tenantId,
    team_id: teamId,
    slack_user_id: slackUserId,
  });
  if (!actorId) {
    res.status(403).json({ error: { code: "not_authorized", message: "not an authorized approver" } });
    return;
  }
  res.status(200).json({ ok: true });
  try {
    const r =
      actionId === SLACK_ACTION_RULE_SAVE
        ? await activateRule(tenantId, actorId as string, ruleId)
        : await dismissRule(tenantId, actorId as string, ruleId);
    if (!payload.response_url) return;
    if (r.status === "active") {
      updateSlackMessage(payload.response_url, `Saved as a rule by <@${slackUserId}>. Agents follow it from their next run.`);
    } else if (r.status === "dismissed") {
      updateSlackMessage(payload.response_url, `Not kept as a rule (<@${slackUserId}>).`);
    } else {
      ephemeralSlackReply(payload.response_url, "This suggestion was already handled.");
    }
  } catch (e) {
    const msg = e instanceof RuleError ? e.message : "Could not save the rule. Try again in Zavi.";
    if (payload.response_url) ephemeralSlackReply(payload.response_url, msg);
  }
}

export async function slackInteractionsWebhook(req: Request, res: Response): Promise<void> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    res.status(500).json({ error: { code: "no_signing_secret", message: "SLACK_SIGNING_SECRET unset" } });
    return;
  }

  const timestamp = String(req.header("x-slack-request-timestamp") ?? "");
  const signature = String(req.header("x-slack-signature") ?? "");
  const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
  const rawBody = Buffer.isBuffer(rawBuf) ? rawBuf.toString("utf8") : String(rawBuf);

  if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
    res.status(403).json({ error: { code: "bad_signature", message: "slack signature invalid" } });
    return;
  }

  let payload: SlackInteractionPayload;
  try {
    const raw = new URLSearchParams(rawBody).get("payload");
    if (!raw) {
      res.status(400).json({ error: { code: "no_payload", message: "missing payload field" } });
      return;
    }
    payload = JSON.parse(raw) as SlackInteractionPayload;
  } catch {
    res.status(400).json({ error: { code: "bad_json", message: "invalid payload json" } });
    return;
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === EDIT_CALLBACK_ID) {
    await handleEditBudgetSubmission(payload, res);
    return;
  }

  if (payload.type === "view_submission" && process.env.SLACK_ORACLE_FORMS_ENABLED === "true") {
    await handleOracleSubmission(payload, res);
    return;
  }

  if (payload.type !== "block_actions") {
    res.status(200).json({ ok: true, ignored: payload.type ?? "unknown" });
    return;
  }

  const action = (payload.actions ?? [])[0];
  const actionId = action?.action_id ?? "";

  if (actionId.startsWith("cgo_q:")) {
    await handleCgoQuestionAction(payload, actionId, res);
    return;
  }

  if (actionId.startsWith("cgo_link:")) {
    res.status(200).json({ ok: true });
    return;
  }

  if (actionId === SLACK_ACTION_CUSTOM_AGENT_CONFIRM) {
    await handleCustomAgentConfirm(payload, action?.value ?? "", res);
    return;
  }

  if (actionId === SLACK_ACTION_RULE_SAVE || actionId === SLACK_ACTION_RULE_DISMISS) {
    await handleRuleAction(payload, actionId, action?.value ?? "", res);
    return;
  }

  const isBatchApproveAll = actionId === SLACK_ACTION_APPROVE_ALL;
  const isBatchRejectAll = actionId === SLACK_ACTION_REJECT_ALL;
  const isBatch = isBatchApproveAll || isBatchRejectAll;
  const isEdit = actionId === SLACK_ACTION_EDIT;

  let decideAction: DecideAction = "approve";
  let decisionId = "";
  let alwaysAllow = false;
  let expectedScheduledAt: string | null | undefined;
  if (!isBatch && !isEdit) {
    const parsedValue =
      actionId === SLACK_ACTION_REJECT ? { decisionId: action?.value ?? "" } : parseApproveValue(action?.value ?? "");
    decisionId = parsedValue.decisionId;
    expectedScheduledAt = "expected_scheduled_at" in parsedValue ? parsedValue.expected_scheduled_at : undefined;
    if (actionId === SLACK_ACTION_APPROVE) decideAction = "approve";
    else if (actionId === SLACK_ACTION_APPROVE_ALWAYS) {
      decideAction = "approve";
      alwaysAllow = true;
    } else if (actionId === SLACK_ACTION_REJECT) decideAction = "reject";
    else {
      res.status(200).json({ ok: true, ignored: `action ${actionId}` });
      return;
    }
    if (!decisionId) {
      res.status(400).json({ error: { code: "no_decision_id", message: "action has no decision id" } });
      return;
    }
  }

  const teamId = String(payload.team?.id ?? "");
  const slackUserId = String(payload.user?.id ?? "");
  if (!teamId || !slackUserId) {
    res.status(403).json({ error: { code: "unresolved_actor", message: "missing team or user" } });
    return;
  }

  const svc = serviceClient();

  const { data: meta, error: metaErr } = await svc
    .from("slack_workspaces")
    .select("tenant_id")
    .eq("team_id", teamId)
    .maybeSingle();
  if (metaErr || !meta?.tenant_id) {
    res.status(403).json({ error: { code: "unknown_team", message: "no tenant for slack team" } });
    return;
  }
  const tenantId = meta.tenant_id as string;

  const approverId = await resolveSlackApprover(svc, {
    tenant_id: tenantId,
    team_id: teamId,
    slack_user_id: slackUserId,
  });
  if (!approverId) {
    res.status(403).json({ error: { code: "not_authorized", message: "not an authorized approver" } });
    return;
  }

  if (isBatch) {
    const { runId, cutoffMs } = parseBatchValue(action?.value ?? "");
    if (!runId) {
      res.status(400).json({ error: { code: "no_run_id", message: "batch action has no run id" } });
      return;
    }
    await inngest.send({
      id: `slack-batch:${tenantId}:${runId}:${isBatchApproveAll ? "approve" : "reject"}:${cutoffMs}`,
      name: "slack.batch.decide",
      data: {
        tenant_id: tenantId,
        run_id: runId,
        actor_user_id: approverId as string,
        action: isBatchApproveAll ? "approve" : "reject",
        cutoff_ms: cutoffMs,
        response_url: payload.response_url ?? null,
      },
    });
    res.status(200).json({ ok: true, queued: "batch", action: isBatchApproveAll ? "approve" : "reject" });
    return;
  }

  if (isEdit) {
    const editDecisionId = action?.value ?? "";
    const triggerId = payload.trigger_id ?? "";
    if (!editDecisionId || !triggerId) {
      res.status(200).json({ ok: true, ignored: "edit missing id/trigger" });
      return;
    }
    const { data: dec } = await svc
      .from("decisions")
      .select("id, tenant_id, decision_class, status, body")
      .eq("id", editDecisionId)
      .maybeSingle();
    const decRow = dec as
      | { tenant_id: string; decision_class: string | null; status: string; body: unknown }
      | null;
    if (
      !decRow ||
      decRow.tenant_id !== tenantId ||
      !isEditableBudgetClass(decRow.decision_class) ||
      decRow.status !== "proposed"
    ) {
      if (payload.response_url) {
        updateSlackMessage(payload.response_url, "ℹ️ This can no longer be edited (already handled).");
      }
      res.status(200).json({ ok: true, ignored: "not editable" });
      return;
    }
    const current = readProposedDailyBudget(decRow.body);
    try {
      await slackFetch(
        tenantId,
        "views.open",
        { trigger_id: triggerId, view: JSON.stringify(buildEditBudgetModal(editDecisionId, current, readBodyCurrency(decRow.body))) },
        teamId,
      );
    } catch (e) {
      console.warn(`[slack-interactions] views.open failed for ${editDecisionId}: ${(e as Error).message}`);
    }
    res.status(200).json({ ok: true, opened: "edit_modal" });
    return;
  }

  const result = await decideOnDecision({
    decision_id: decisionId,
    tenant_id: tenantId,
    action: decideAction,
    actor: { user_id: approverId as string },
    always_allow: alwaysAllow,
    ...(decideAction === "approve" && expectedScheduledAt !== undefined
      ? { expected_scheduled_at: expectedScheduledAt }
      : {}),
  });

  if (!result.ok) {
    if (result.code === "schedule_changed") {
      void refreshApprovalCard({ tenant_id: tenantId, decision_id: decisionId }).catch(() => undefined);
      if (payload.response_url) {
        replyEphemeral(payload.response_url, scheduleMovedSentence(result.current_scheduled_at ?? null));
      }
      res.status(200).json({ ok: true, ignored: "schedule_changed" });
      return;
    }
    if (result.code === "requires_ship_red_override") {
      if (payload.response_url) {
        updateSlackMessage(
          payload.response_url,
          "This change broke a test that was passing on the base branch, so it can't be approved with one click. Approve it from the web Approvals page (which asks you to confirm), or reply `ship red` in chat.",
        );
      }
      res.status(200).json({ ok: true, ignored: "requires_ship_red_override" });
      return;
    }
    if (result.code === "paired_move_waits") {
      if (payload.response_url) replyEphemeral(payload.response_url, `Not approved yet. ${result.detail ?? "Approve the matching cut first."} To run it by itself, approve it in Zavi.`);
      res.status(200).json({ ok: true, ignored: "paired_move_waits" });
      return;
    }
    if (result.code?.startsWith("budget_") || result.code === "move_waits_on_cuts" || result.code === "card_changed") {
      if (payload.response_url) replyEphemeral(payload.response_url, `Not approved. ${result.detail ?? "Open it in Zavi."}`);
      res.status(200).json({ ok: true, ignored: result.code });
      return;
    }
    if (result.code === "requires_unverified_confirm") {
      if (payload.response_url) {
        replyEphemeral(payload.response_url, `Not posted. ${result.detail ?? "Zavi could not check everything on this pin."} Open the Pinterest channel in Zavi to review it and post it anyway.`);
      }
      res.status(200).json({ ok: true, ignored: "requires_unverified_confirm" });
      return;
    }
    if (result.code === "invalid_edit") {
      if (payload.response_url) {
        const detail = result.detail ?? "The post is not ready to publish.";
        const hint = detail.includes(UNEDITABLE_FIELD_HINT) ? "" : " Edit it on the web Approvals page, then approve.";
        updateSlackMessage(payload.response_url, `Not approved. ${detail}${hint}`);
      }
      res.status(200).json({ ok: true, ignored: "invalid_edit" });
      return;
    }
    if (result.code === "email_card_required") {
      if (payload.response_url) {
        const link = result.open_in_zavi ? ` Open in Zavi: ${result.open_in_zavi}` : "";
        updateSlackMessage(payload.response_url, `This email is still waiting for approval. ${result.detail ?? "Approve this email from its card in Zavi."}${link}`);
      }
      res.status(200).json({ ok: true, ignored: "email_card_required" });
      return;
    }
    if (result.code === "stale_card") {
      if (payload.response_url) {
        updateSlackMessage(
          payload.response_url,
          result.detail ?? "This action changes something in a connected app, so it can't be approved from Slack. Approve it from its card in the Zavi chat where it was proposed.",
        );
      }
      res.status(200).json({ ok: true, ignored: "stale_card" });
      return;
    }
    const status = result.code === "not_found" ? 404 : result.code === "rpc_error" ? 500 : 403;
    res.status(status).json({ error: { code: result.code, message: `decision ${result.code}` } });
    return;
  }

  if (payload.response_url) {
    const allowNote = result.allowlisted ? " Won't ask again for this kind." : "";
    const note = !result.changed
      ? decisionClosedElsewhere(decideAction, result) ?? `ℹ️ Already ${result.status}.`
      : decideAction === "approve"
        ? `☑️ Approval recorded — dispatch queued.${allowNote} I'll post the result here.`
        : `✅ Rejected via Slack.${allowNote}`;
    updateSlackMessage(payload.response_url, note);
  }
  res
    .status(200)
    .json({ ok: true, changed: result.changed, status: result.status, allowlisted: result.allowlisted });
}

async function handleOracleSubmission(
  payload: SlackInteractionPayload,
  res: Response,
): Promise<void> {
  const view = payload.view;
  const callbackId = String(view?.callback_id ?? "");

  if (!ORACLE_CALLBACK_IDS.has(callbackId)) {
    res.status(200).json({ ok: true, ignored: `callback ${callbackId || "unknown"}` });
    return;
  }

  const teamId = String(payload.team?.id ?? "");
  const slackUserId = String(payload.user?.id ?? "");
  if (!teamId || !slackUserId) {
    res.status(403).json({ error: { code: "unresolved_actor", message: "missing team or user" } });
    return;
  }

  const svc = serviceClient();

  const { data: meta, error: metaErr } = await svc
    .from("slack_workspaces")
    .select("tenant_id")
    .eq("team_id", teamId)
    .maybeSingle();
  if (metaErr || !meta?.tenant_id) {
    res.status(403).json({ error: { code: "unknown_team", message: "no tenant for slack team" } });
    return;
  }
  const tenantId = meta.tenant_id as string;

  const approverId = await resolveSlackApprover(svc, {
    tenant_id: tenantId,
    team_id: teamId,
    slack_user_id: slackUserId,
  });
  if (!approverId) {
    res.status(403).json({ error: { code: "not_authorized", message: "not an authorized approver" } });
    return;
  }

  let runId = "";
  let agentSlug = "";
  try {
    const pm = JSON.parse(String(view?.private_metadata ?? "{}")) as {
      run_id?: string;
      agent_slug?: string;
    };
    runId = String(pm.run_id ?? "");
    agentSlug = String(pm.agent_slug ?? "");
  } catch {
  }
  const verdict = viewFieldValue(view, "oracle_verdict") === "fail" ? "fail" : "pass";
  const correction = viewFieldValue(view, "oracle_correction").slice(0, 4000);

  if (!runId || !agentSlug) {
    res.status(200).json({
      response_action: "errors",
      errors: { oracle_correction: "Missing the run this golden is for. Please reopen the form." },
    });
    return;
  }

  const { error: writeErr } = await svc.rpc("insert_oracle_correction", {
    p_tenant_id: tenantId,
    p_run_id: runId,
    p_agent_slug: agentSlug,
    p_verdict: verdict,
    p_correction: correction,
    p_callback_id: callbackId,
  });
  if (writeErr) {
    const code = (writeErr as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: { code: "cross_tenant", message: "run does not belong to tenant" } });
      return;
    }
    res.status(200).json({
      response_action: "errors",
      errors: { oracle_correction: "Could not record this golden. Check the run and try again." },
    });
    return;
  }

  res.status(200).json({ response_action: "clear" });
}

async function handleEditBudgetSubmission(
  payload: SlackInteractionPayload,
  res: Response,
): Promise<void> {
  const view = payload.view;
  const teamId = String(payload.team?.id ?? "");
  const slackUserId = String(payload.user?.id ?? "");
  if (!teamId || !slackUserId) {
    res.status(403).json({ error: { code: "unresolved_actor", message: "missing team or user" } });
    return;
  }

  const svc = serviceClient();

  const { data: meta, error: metaErr } = await svc
    .from("slack_workspaces")
    .select("tenant_id")
    .eq("team_id", teamId)
    .maybeSingle();
  if (metaErr || !meta?.tenant_id) {
    res.status(403).json({ error: { code: "unknown_team", message: "no tenant for slack team" } });
    return;
  }
  const tenantId = meta.tenant_id as string;

  const approverId = await resolveSlackApprover(svc, {
    tenant_id: tenantId,
    team_id: teamId,
    slack_user_id: slackUserId,
  });
  if (!approverId) {
    res.status(403).json({ error: { code: "not_authorized", message: "not an authorized approver" } });
    return;
  }

  let decisionId = "";
  try {
    const pm = JSON.parse(String(view?.private_metadata ?? "{}")) as { decision_id?: string };
    decisionId = String(pm.decision_id ?? "");
  } catch {
  }
  if (!decisionId) {
    res.status(200).json({
      response_action: "errors",
      errors: { [EDIT_BUDGET_ACTION_ID]: "Lost the action this edits. Reopen and try again." },
    });
    return;
  }

  const raw = viewFieldValue(view, EDIT_BUDGET_ACTION_ID).trim().replace(/^[$₹]/, "");
  const newBudget = Number(raw);
  if (!Number.isFinite(newBudget) || newBudget <= 0 || newBudget > 100000) {
    res.status(200).json({
      response_action: "errors",
      errors: { [EDIT_BUDGET_ACTION_ID]: "Enter a daily budget between $1 and $100,000." },
    });
    return;
  }

  const { data: dec } = await svc
    .from("decisions")
    .select("id, tenant_id, decision_class, status, body")
    .eq("id", decisionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const decRow = dec as
    | { decision_class: string | null; status: string; body: Record<string, unknown> | null }
    | null;
  if (!decRow || !isEditableBudgetClass(decRow.decision_class) || decRow.status !== "proposed") {
    res.status(200).json({
      response_action: "errors",
      errors: { [EDIT_BUDGET_ACTION_ID]: "This can no longer be edited (already handled)." },
    });
    return;
  }

  const patchedBody = { ...(decRow.body ?? {}), daily_budget_usd: newBudget };

  const { data: editRes, error: editErr } = await svc.rpc("edit_decision_body_if_proposed", {
    p_decision_id: decisionId,
    p_tenant_id: tenantId,
    p_actor_user_id: approverId as string,
    p_body: patchedBody,
  });
  const edited = (editRes as { ok?: boolean } | null)?.ok === true;
  if (editErr || !edited) {
    res.status(200).json({
      response_action: "errors",
      errors: { [EDIT_BUDGET_ACTION_ID]: "Couldn't save the edit (it may have just been handled). Try again." },
    });
    return;
  }

  const decideRes = await decideOnDecision({
    decision_id: decisionId,
    tenant_id: tenantId,
    action: "approve",
    actor: { user_id: approverId as string },
  });
  if (!decideRes.ok) {
    res.status(200).json({
      response_action: "errors",
      errors: { [EDIT_BUDGET_ACTION_ID]: decideRes.code === "paired_move_waits" && decideRes.detail ? `Saved the edit. ${decideRes.detail}` : "Saved the edit but couldn't approve. Approve it from the message." },
    });
    return;
  }

  res.status(200).json({ response_action: "clear" });
}

async function handleCustomAgentConfirm(
  payload: SlackInteractionPayload,
  value: string,
  res: Response,
): Promise<void> {
  const say = (text: string) => {
    if (payload.response_url) updateSlackMessage(payload.response_url, text);
  };
  const teamId = String(payload.team?.id ?? "");
  const slackUserId = String(payload.user?.id ?? "");
  if (!teamId || !slackUserId) {
    res.status(403).json({ error: { code: "unresolved_actor", message: "missing team or user" } });
    return;
  }
  const { data: meta, error: metaErr } = await serviceClient()
    .from("slack_workspaces")
    .select("tenant_id")
    .eq("team_id", teamId)
    .maybeSingle();
  if (metaErr || !meta?.tenant_id) {
    res.status(403).json({ error: { code: "unknown_team", message: "no tenant for slack team" } });
    return;
  }
  const tenantId = meta.tenant_id as string;
  const parsed = parseConfirmButtonValue(value);
  if (!parsed) {
    say(CONFIRM_INVALID_REPLY);
    res.status(200).json({ ok: true, custom_agent: "invalid" });
    return;
  }
  res.status(200).json({ ok: true, queued: "custom_agent_confirm" });
  try {
    const result = await runCustomAgentConfirm(
      tenantId,
      { code: parsed.code, surface: "slack", external_user_id: slackUserId, slack_team_id: teamId, draft_hash: parsed.hash },
      { created_by: null, slack_user_id: slackUserId },
    );
    say(result.text);
  } catch (e) {
    console.warn(`[slack-interactions] custom agent confirm failed: ${(e as Error).message}`);
    say(CONFIRM_FAILED_REPLY);
  }
}

async function handleCgoQuestionAction(payload: SlackInteractionPayload, actionId: string, res: Response): Promise<void> {
  const { parseCgoQuestionAction } = await import("@/services/growth/cgo-note-slack");
  const parsed = parseCgoQuestionAction(actionId);
  const teamId = String(payload.team?.id ?? "");
  const slackUserId = String(payload.user?.id ?? "");
  if (!parsed || !teamId || !slackUserId) {
    res.status(200).json({ ok: true, ignored: "bad cgo question action" });
    return;
  }
  const svc = serviceClient();
  const { handleCgoQuestionClick } = await import("@/services/slack/cgo-question-click");
  const { answerQuestion, deferredWake } = await import("@/services/growth/cgo-answers");
  const later = deferredWake();
  const r = await handleCgoQuestionClick(
    { team_id: teamId, slack_user_id: slackUserId, question_id: parsed.question_id, answer: parsed.answer, message_blocks: payload.message?.blocks },
    {
      tenantForTeam: async (team) => {
        const { data, error } = await svc.from("slack_workspaces").select("tenant_id").eq("team_id", team).maybeSingle();
        return error ? null : ((data as { tenant_id?: string } | null)?.tenant_id ?? null);
      },
      ownerSlackUser: async (tenant_id, team) => {
        const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
        const email = await resolveTenantOwnerEmail(tenant_id);
        if (!email) return null;
        const who = await slackFetch<{ user?: { id?: string } }>(tenant_id, "users.lookupByEmail", { email }, team);
        return who.user?.id ?? null;
      },
      ownerUserId: async (tenant_id) => {
        const { data } = await svc.from("tenant_users").select("user_id").eq("tenant_id", tenant_id).eq("role", "owner").limit(1).maybeSingle();
        return (data as { user_id?: string } | null)?.user_id ?? null;
      },
      answer: (a) => answerQuestion({ ...a, via: "slack" }, { wake: later.wake }),
    },
  ).catch((e) => {
    console.warn(`[slack-interactions] cgo question click failed: ${(e as Error).message}`);
    return null;
  });
  if (!r) {
    res.status(200).json({ ok: false, error: "answer_failed" });
    return;
  }
  if (!r.ok) {
    res.status(403).json({ error: { code: r.code, message: "not allowed to answer this question" } });
    return;
  }
  if (payload.response_url && (r.blocks || r.ephemeral)) {
    const body = r.blocks
      ? { replace_original: true, text: payload.message?.text ?? "Your growth note", blocks: r.blocks }
      : { response_type: "ephemeral", replace_original: false, text: r.ephemeral };
    void fetch(payload.response_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch((e) =>
      console.warn(`[slack-interactions] cgo question redraw failed: ${(e as Error).message}`),
    );
  }
  res.status(200).json({ ok: true, outcome: r.outcome.outcome });
  await later.run();
}
