import { editedSocialDraft, recheckEditedPin, unverifiedPinChecks, type SocialDraftEdit } from "./social-draft-edit";
import { socialDraftVersion } from "./social-draft-version";

import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { TIKTOK_CHAT_EDIT_CLASSES } from "@/services/connectors/tiktok-ads/held-schema";
import { approveNeedsOwnerOrAdmin } from "./approve-role-gate";
import { readApprovalClass } from "@/agents/engineer/approval-class";
import { logDecisionNotTaken } from "@/services/agents/log-decision-not-taken";
import { logEvent } from "@/services/logging/logEvent";
import { stampOutcomeForDecision } from "@/services/memory/stamp-outcome";
import { bindActionOutcome } from "@/services/growth/bind-action-outcome";
import { trackApprovalCardDecided } from "@/services/analytics/action-events";
import { composioWriteFingerprint } from "@/services/connectors/composio/fingerprint";
import { isComposioDecisionClass } from "@/services/connectors/composio/write-classify";
import { isWebOnlyApproveClass, moneyCardSealIntact } from "./money-card";
import { EMAIL_CARD_APPROVE_MESSAGE, EMAIL_CARD_APPROVE_REQUIRED, isEmailCardClass } from "@/services/email-cards/approve-gate";

const EXTENSION_MONEY_STEP_CLASS = "extension.money_step";

export type DecideAction = "approve" | "reject";

export type DecideActor = {
  user_id: string;
};

export type DecideOutcomeCode =
  | "ok"
  | "not_found"
  | "cross_tenant"
  | "not_member"
  | "not_authorized"
  | "requires_ship_red_override"
  | "invalid_edit"
  | "plan_required"
  | "stale_card"
  | "schedule_changed"
  | "email_card_required"
  | "paired_move_waits"
  | "budget_unreadable"
  | "budget_choice_in_zavi"
  | "budget_choice_required"
  | "budget_raise_changed"
  | "budget_raise_failed"
  | "move_waits_on_cuts"
  | "card_changed"
  | "decision_closed"
  | "requires_unverified_confirm"
  | "rpc_error";

export { OWNER_ONLY_APPROVE_CLASSES, approveNeedsOwnerOrAdmin } from "./approve-role-gate";

export type DecideResult = {
  ok: boolean;
  code: DecideOutcomeCode;
  changed: boolean;
  status: string | null;
  decision_id: string;
  decision_class: string | null;
  allowlisted: boolean;
  detail?: string;
  current_scheduled_at?: string | null;
  unverified?: string[];
  open_in_zavi?: string;
  email_card_code?: string;
  run_alone?: import("@/services/growth/move-group").RunAloneConfirm;
  budget_choice?: import("./budget-choice").BudgetChoiceView | null;
  plan_refusal?: import("@/services/agents/email-send-tier").EmailSendHttpRefusal;
};

export function sameScheduledAt(a: unknown, b: unknown): boolean {
  const ms = (v: unknown) => (typeof v === "string" ? new Date(v).getTime() : null);
  const x = ms(a);
  const y = ms(b);
  if (x === null || y === null) return x === y;
  return !Number.isNaN(x) && x === y;
}

async function refuseUnfinishedSocialCopy(payload: unknown): Promise<string | null> {
  const { checkPublishText } = await import("@/services/connectors/social-publish-content-guard");
  return checkPublishText(payload ?? {})?.message ?? null;
}

function fireRejectStamp(decision_id: string, tenant_id: string): void {
  void stampOutcomeForDecision(decision_id, tenant_id).catch((e) =>
    console.warn(
      `[inline-stamp] best-effort failed for ${decision_id}: ${(e as Error).message}`,
    ),
  );
}

const APPROVED_SEND_ATTEMPTS = 3;
const APPROVED_SEND_BACKOFF_MS = 250;

export async function decideOnDecision(args: {
  decision_id: string;
  tenant_id: string;
  action: DecideAction;
  actor: DecideActor;
  always_allow?: boolean;
  staff_override?: boolean;
  approver_source?: "cgo";
  ship_anyway?: boolean;
  scheduled_at?: string | null;
  payload_edit?: SocialDraftEdit;
  expected_fingerprint?: string;
  expected_post_revision?: string;
  expected_scheduled_at?: string | null;
  email_variant?: number;
  request_id?: string;
  business_controls?: unknown;
  run_alone?: boolean;
  offer_run_alone?: boolean;
  surface?: "web";
  raise_budget_to_usd?: number;
  raise_daily_limit_to_usd?: number;
  confirm_unverified?: boolean;
}): Promise<DecideResult> {
  const {
    decision_id,
    tenant_id,
    action,
    actor,
    always_allow,
    staff_override,
    approver_source,
    ship_anyway,
    scheduled_at,
    payload_edit,
    expected_fingerprint,
    expected_post_revision,
    expected_scheduled_at,
    email_variant,
    request_id,
    run_alone,
    offer_run_alone,
    surface,
    raise_budget_to_usd,
    raise_daily_limit_to_usd,
    confirm_unverified,
  } = args;
  const svc = serviceClient();

  const { data: row } = await svc
    .from("decisions")
    .select("id, tenant_id, status, decision_class, agent_run_id, body")
    .eq("id", decision_id)
    .maybeSingle();

  if (!row) {
    return { ok: false, code: "not_found", changed: false, status: null, decision_id, decision_class: null, allowlisted: false };
  }

  const decisionRow = row as {
    tenant_id: string;
    status: string;
    decision_class: string | null;
    agent_run_id: string | null;
    body: Record<string, unknown> | null;
  };

  if (decisionRow.tenant_id !== tenant_id) {
    return {
      ok: false,
      code: "cross_tenant",
      changed: false,
      status: decisionRow.status,
      decision_id,
      decision_class: decisionRow.decision_class ?? null,
      allowlisted: false,
    };
  }

  if (approver_source && isFounderRequestedBody(decisionRow.body)) {
    void logEvent({
      level: "warn",
      source: "decide-service",
      code: "approvals.founder_order_refused_for_cgo",
      tenant_id,
      meta: { decision_class: decisionRow.decision_class ?? "unknown" },
    });
    return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
  }

  if (decisionRow.decision_class === "growth.save_business_controls") {
    const result = (code: DecideOutcomeCode, detail?: string): DecideResult => ({
      ok: false, code, changed: false, status: decisionRow.status, decision_id,
      decision_class: decisionRow.decision_class, allowlisted: false, detail,
    });
    if (staff_override || approver_source) return result("not_authorized");
    const role = await loadTenantRoleFor(actor.user_id, tenant_id).catch(() => null);
    if (role !== "owner" && role !== "admin") return result("not_authorized");
    if (action === "approve") {
      if (args.business_controls === undefined) return result("stale_card", "Open the Business results card, review its values, then click Approve and save.");
      try {
        const { approveBusinessControls } = await import("@/services/growth/business-control-proposal");
        const out = await approveBusinessControls(tenant_id, actor.user_id, decision_id, args.business_controls);
        if (out.status === "saved") {
          if (out.changed === true) {
            trackApprovalCardDecided({ tenant_id, user_id: actor.user_id, decision_class: decisionRow.decision_class, outcome: "approved", staff: false });
          }
          return { ...result("ok"), ok: true, changed: out.changed === true, status: "acted" };
        }
        if (out.status === "not_found") return result("not_found");
        if (out.status === "plan_required") return result("plan_required", "A Pro plan is required to enable business-result controls. Upgrade to Pro, or turn off Use business-result controls and save the disabled policy.");
        if (out.status === "invalid_edit") return result("invalid_edit", "Check the business-control values.");
        return result("stale_card", "The proposal or saved limits changed. Ask Zavi for a new proposal before saving.");
      } catch {
        return result("invalid_edit", "Could not confirm the save. Reload the card to check its status before retrying; check your plan and permissions if it remains pending.");
      }
    }
  }

  if (action === "approve" && staff_override && (isComposioDecisionClass(decisionRow.decision_class) || TIKTOK_CHAT_EDIT_CLASSES.has(decisionRow.decision_class ?? ""))) {
    return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
  }

  if (!staff_override) {
    let actorRole: string | null;
    try {
      actorRole = await loadTenantRoleFor(actor.user_id, tenant_id);
    } catch {
      return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
    if (actorRole === "viewer") {
      return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
  }

  if (action === "approve" && isEmailCardClass(decisionRow.decision_class)) {
    const { approveEmailCard, emailCardLink, EMAIL_CARD_MESSAGES } = await import("@/services/email-cards/cards");
    const refused = (code: string): DecideResult => ({
      ok: false,
      code: code === "not_authorized" ? "not_authorized" : "email_card_required",
      changed: false,
      status: decisionRow.status,
      decision_id,
      decision_class: decisionRow.decision_class ?? null,
      allowlisted: false,
      detail: EMAIL_CARD_MESSAGES[code] ?? EMAIL_CARD_APPROVE_MESSAGE,
      open_in_zavi: emailCardLink("decisions", decision_id, tenant_id),
      email_card_code: code,
    });
    if (email_variant === undefined || staff_override || approver_source) {
      if (decisionRow.status !== "proposed") {
        return { ok: true, code: "ok", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
      }
      return { ...refused("email_card_required"), detail: EMAIL_CARD_APPROVE_MESSAGE };
    }
    const { emailSendHttpRefusal } = await import("@/services/agents/email-send-tier");
    const tier = await emailSendHttpRefusal(tenant_id);
    if (tier) {
      return { ok: false, code: "plan_required", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false, detail: tier.body.error.message, plan_refusal: tier };
    }
    const out = await approveEmailCard(tenant_id, "decisions", decision_id, email_variant, actor.user_id, request_id ?? `decide:${decision_id}:${actor.user_id}`);
    if (!out.ok) return refused(out.code);
    return { ok: true, code: "ok", changed: out.changed, status: "approved", decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
  }

  if (
    action === "approve" &&
    !staff_override &&
    decisionRow.decision_class &&
    approveNeedsOwnerOrAdmin(decisionRow.decision_class, decisionRow.body)
  ) {
    let role: string | null;
    try {
      role = await loadTenantRoleFor(actor.user_id, tenant_id);
    } catch {
      return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
    const allowed = role === "owner" || role === "admin";
    if (!allowed) {
      return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
  }

  if (action === "approve" && isComposioDecisionClass(decisionRow.decision_class)) {
    const b = decisionRow.body ?? {};
    const current = composioWriteFingerprint({
      toolkit: b.toolkit,
      tool_slug: b.tool_slug,
      arguments: b.arguments,
      classification: b.classification,
      labels: b.labels,
      decision_class: decisionRow.decision_class,
      connected_account_id: b.connected_account_id,
      auth_config_id: b.auth_config_id,
    });
    if (
      typeof b.fingerprint !== "string" ||
      b.fingerprint !== current ||
      typeof expected_fingerprint !== "string" ||
      expected_fingerprint !== current
    ) {
      return { ok: false, code: "stale_card", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
  }

  if (action === "approve" && isWebOnlyApproveClass(decisionRow.decision_class)) {
    const cls = decisionRow.decision_class as string;
    const refused = (code: DecideOutcomeCode): DecideResult => ({ ok: false, code, changed: false, status: decisionRow.status, decision_id, decision_class: cls, allowlisted: false });
    if (staff_override || approver_source) return refused("not_authorized");
    if (cls === EXTENSION_MONEY_STEP_CLASS) {
      const owner = decisionRow.body?.run_owner_user_id;
      if (typeof owner !== "string" || owner.length === 0 || owner !== actor.user_id) {
        return refused("not_authorized");
      }
    } else {
      let role: string | null;
      try {
        role = await loadTenantRoleFor(actor.user_id, tenant_id);
      } catch {
        return refused("not_authorized");
      }
      if (role !== "owner" && role !== "admin") return refused("not_authorized");
    }
    if (!moneyCardSealIntact(cls, decisionRow.body) || expected_fingerprint !== decisionRow.body?.fingerprint) {
      return refused("stale_card");
    }
  }

  if (
    action === "approve" &&
    !staff_override &&
    ship_anyway !== true &&
    readApprovalClass(decisionRow.body) === "ship_red"
  ) {
    return {
      ok: false,
      code: "requires_ship_red_override",
      changed: false,
      status: decisionRow.status,
      decision_id,
      decision_class: decisionRow.decision_class ?? null,
      allowlisted: false,
    };
  }

  const socialApproval = action === "approve" && !staff_override && decisionRow.decision_class === "social.publish.v2";
  const socialExpectedBody = decisionRow.body;
  if (socialApproval && decisionRow.status === "proposed" &&
    ((expected_post_revision !== undefined && expected_post_revision !== socialDraftVersion(socialExpectedBody)) ||
      (socialExpectedBody?.post_draft && expected_post_revision === undefined))) {
    return { ok: false, code: "stale_card", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class, allowlisted: false, detail: "This post changed. Reload it and review again before publishing." };
  }

  if (
    action === "approve" &&
    !staff_override &&
    expected_scheduled_at !== undefined &&
    decisionRow.decision_class === "social.publish.v2" &&
    !sameScheduledAt(decisionRow.body?.scheduled_at ?? null, expected_scheduled_at)
  ) {
    const current = decisionRow.body?.scheduled_at;
    return {
      ok: false,
      code: "schedule_changed",
      changed: false,
      status: decisionRow.status,
      decision_id,
      decision_class: decisionRow.decision_class ?? null,
      allowlisted: false,
      current_scheduled_at: typeof current === "string" ? current : null,
    };
  }

  if (
    action === "approve" &&
    !staff_override &&
    (scheduled_at !== undefined || payload_edit !== undefined) &&
    decisionRow.decision_class === "social.publish.v2"
  ) {
    const nextBody: Record<string, unknown> = {
      ...(decisionRow.body ?? {}),
      ...(scheduled_at !== undefined ? { scheduled_at } : {}),
    };
    if (payload_edit) {
      try {
        if (nextBody.post_draft_original === undefined && decisionRow.body) {
          nextBody.post_draft_original = decisionRow.body;
        }
        const edited = editedSocialDraft(tenant_id, nextBody, payload_edit);
        nextBody.channel = edited.channel;
        nextBody.payload = edited.payload;
      } catch (e) {
        return {
          ok: false,
          code: "invalid_edit",
          changed: false,
          status: decisionRow.status,
          decision_id,
          decision_class: decisionRow.decision_class ?? null,
          allowlisted: false,
          detail: (e as Error).message.slice(0, 300),
        };
      }
    }
    const pinRecheck =
      payload_edit && nextBody.channel === "pinterest_pin" && decisionRow.status === "proposed"
        ? await recheckEditedPin(tenant_id, decisionRow.body?.payload, nextBody.payload as Record<string, unknown>)
        : null;
    if (pinRecheck && !pinRecheck.ok) {
      return { ok: false, code: "invalid_edit", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false, detail: pinRecheck.reason };
    }
    if (pinRecheck?.ok && pinRecheck.board_name) {
      nextBody.payload = { ...(nextBody.payload as Record<string, unknown>), board_name: pinRecheck.board_name };
      nextBody.readiness = pinRecheck.readiness;
    }
    const editRefusal =
      decisionRow.status === "proposed" ? await refuseUnfinishedSocialCopy(nextBody.payload) : null;
    if (editRefusal) {
      return {
        ok: false,
        code: "invalid_edit",
        changed: false,
        status: decisionRow.status,
        decision_id,
        decision_class: decisionRow.decision_class ?? null,
        allowlisted: false,
        detail: editRefusal,
      };
    }
    decisionRow.body = nextBody;
  }

  if (action === "approve" && decisionRow.decision_class === "social.publish.v2" && decisionRow.status === "proposed") {
    const refusal = await refuseUnfinishedSocialCopy(
      (decisionRow.body as Record<string, unknown> | null)?.payload,
    );
    if (refusal) {
      return {
        ok: false,
        code: "invalid_edit",
        changed: false,
        status: decisionRow.status,
        decision_id,
        decision_class: decisionRow.decision_class ?? null,
        allowlisted: false,
        detail: refusal,
      };
    }
  }

  if (
    action === "approve" &&
    confirm_unverified !== true &&
    decisionRow.decision_class === "social.publish.v2" &&
    decisionRow.status === "proposed" &&
    decisionRow.body?.channel === "pinterest_pin"
  ) {
    const unverified = unverifiedPinChecks(decisionRow.body?.readiness);
    if (unverified.length > 0) {
      return {
        ok: false,
        code: "requires_unverified_confirm",
        changed: false,
        status: decisionRow.status,
        decision_id,
        decision_class: decisionRow.decision_class,
        allowlisted: false,
        unverified,
        detail: `Zavi could not check everything on this pin. ${unverified.join(" ")}`,
      };
    }
  }

  const budgetChoiceOn =
    action === "approve" && decisionRow.status === "proposed" && !!decisionRow.decision_class && /^(meta_ads|google_ads)\./.test(decisionRow.decision_class)
      ? await (await import("@/services/decisions/ad-budget-choice-flag")).adBudgetChoiceEnabled()
      : false;
  const hasMoveCardStamp =
    budgetChoiceOn && !approver_source && !staff_override && (await import("@/services/growth/move-card")).moveAfterOf(decisionRow.body) !== null;
  if (!hasMoveCardStamp && action === "approve" && decisionRow.status === "proposed" && decisionRow.decision_class) {
    const mg = await import("@/services/growth/move-group");
    const leg = { id: decision_id, exec_class: decisionRow.decision_class, body: decisionRow.body };
    const v = await mg.checkPairedLeg(tenant_id, leg);
    if (v.kind === "wait") {
      const person = !staff_override && !approver_source;
      if (run_alone === true && person) {
        const alone = mg.leaveMoveGroup(decisionRow.body, actor.user_id, new Date().toISOString());
        const { data: editRes, error: editErr } = await svc.rpc("edit_decision_body_if_proposed", {
          p_decision_id: decision_id,
          p_tenant_id: tenant_id,
          p_actor_user_id: actor.user_id,
          p_body: alone,
        });
        if (editErr || (editRes as { ok?: boolean } | null)?.ok !== true) {
          return { ok: false, code: "rpc_error", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class, allowlisted: false };
        }
        decisionRow.body = alone;
        void logEvent({ level: "info", source: "decide-service", code: "approvals.paired_move_run_alone", tenant_id, meta: { decision_class: decisionRow.decision_class } });
      } else {
        void logEvent({ level: "info", source: "decide-service", code: "approvals.paired_move_waits", tenant_id, meta: { decision_class: decisionRow.decision_class } });
        return {
          ok: false,
          code: "paired_move_waits",
          changed: false,
          status: decisionRow.status,
          decision_id,
          decision_class: decisionRow.decision_class,
          allowlisted: false,
          detail: mg.pairWaitMessage(v.why),
          ...(person && offer_run_alone === true ? { run_alone: await mg.runAloneConfirm(tenant_id, leg, v) } : {}),
        };
      }
    }
  }

  let preFlipped: { changed: boolean; status: string } | null = null;
  if (budgetChoiceOn && !approver_source) {
    const { legSide } = await import("@/services/growth/move-group");
    if (legSide(decisionRow.decision_class!, decisionRow.body) === "adds") {
      const refuse = (code: DecideOutcomeCode, detail: string, view?: DecideResult["budget_choice"]): DecideResult => ({
        ok: false, code, changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false, detail,
        ...(view !== undefined ? { budget_choice: view } : {}),
      });
      if (hasMoveCardStamp) {
        const v = await (await import("@/services/growth/move-card")).checkMoveAfter(tenant_id, decisionRow.body);
        if (v !== "go") {
          void logEvent({ level: "info", source: "decide-service", code: "approvals.move_waits_on_cuts", tenant_id, meta: { decision_class: decisionRow.decision_class } });
          return refuse("move_waits_on_cuts", v === "wait" ? "The cuts in this move are still being applied. The raise runs after them." : "A cut this raise needs did not go through, so the raise has not run. Retry the cut or reject the move.");
        }
      }
      const bc = await import("./budget-choice");
      if (staff_override) {
        const fit = await (await import("@/services/decisions/ad-month-counter")).readRaiseFit(tenant_id, decisionRow.decision_class!, decisionRow.body);
        const view = bc.budgetChoiceView(fit);
        const r = bc.budgetChoiceRefusal(view, "other", {});
        if (r) return refuse(r.code, r.detail, view);
      } else {
        const r = await bc.approveRaiseWithBudget({
          tenant_id, decision_id, actor_user_id: actor.user_id, decision_class: decisionRow.decision_class!, body: decisionRow.body,
          surface: surface === "web" ? "web" : "other",
          ask: {
            ...(raise_budget_to_usd !== undefined ? { raise_budget_to_usd } : {}),
            ...(raise_daily_limit_to_usd !== undefined ? { raise_daily_limit_to_usd } : {}),
          },
        });
        if (r.kind === "refused") {
          void logEvent({ level: "info", source: "decide-service", code: `approvals.${r.code}`, tenant_id, meta: { decision_class: decisionRow.decision_class } });
          return refuse(r.code, r.detail, r.view);
        }
        if (r.kind === "approved") preFlipped = { changed: r.changed, status: "approved" };
      }
    }
  }

  if (staff_override && approver_source) {
    return { ok: false, code: "not_authorized", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
  }
  const { data: rpcData, error: rpcErr } = preFlipped
    ? { data: preFlipped, error: null }
    : await svc.rpc(
    socialApproval
      ? "approve_social_draft_as_actor"
      : staff_override
      ? "decide_decision_as_staff"
      : approver_source === "cgo"
        ? "decide_decision_as_cgo"
        : "decide_decision_as_actor",
    {
      p_decision_id: decision_id,
      p_tenant_id: tenant_id,
      p_actor_user_id: actor.user_id,
      ...(socialApproval
        ? { p_expected_body: socialExpectedBody, p_body: decisionRow.body, p_source: approver_source ?? null }
        : { p_action: action }),
    },
  );

  if (rpcErr) {
    const msg = rpcErr.message || "";
    if (msg.includes("stale_card")) {
      return { ok: false, code: "stale_card", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false, detail: "This post changed. Reload it and review again before publishing." };
    }
    if (msg.includes(EMAIL_CARD_APPROVE_REQUIRED)) {
      return { ok: false, code: "email_card_required", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false, detail: EMAIL_CARD_APPROVE_MESSAGE };
    }
    if (msg.includes("cross_tenant")) {
      return { ok: false, code: "cross_tenant", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
    if (msg.includes("not_member")) {
      return { ok: false, code: "not_member", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
    }
    if (msg.includes("not found")) {
      return { ok: false, code: "not_found", changed: false, status: null, decision_id, decision_class: null, allowlisted: false };
    }
    return { ok: false, code: "rpc_error", changed: false, status: decisionRow.status, decision_id, decision_class: decisionRow.decision_class ?? null, allowlisted: false };
  }

  const result = (rpcData ?? {}) as { changed?: boolean; status?: string };
  const changed = result.changed === true;
  const status = result.status ?? decisionRow.status;

  if (changed) {
    trackApprovalCardDecided({
      tenant_id,
      user_id: actor.user_id,
      decision_class: decisionRow.decision_class ?? "unknown",
      outcome: action === "approve" ? "approved" : "rejected",
      staff: staff_override === true,
    });
  }

  if (action === "approve" && (changed || status === "approved")) {
    const event = {
      id: `approve:${decision_id}`,
      name: "decision.approved",
      data: {
        decision_id,
        tenant_id,
        decision_class: decisionRow.decision_class ?? "unknown",
      },
    } as const;
    for (let attempt = 1; ; attempt++) {
      try {
        await inngest.send(event);
        break;
      } catch (e) {
        if (attempt >= APPROVED_SEND_ATTEMPTS) throw e;
        console.warn(`[decide-service] decision.approved send for ${decision_id} failed (attempt ${attempt}); retrying: ${(e as Error)?.message ?? String(e)}`);
        await new Promise((r) => setTimeout(r, APPROVED_SEND_BACKOFF_MS * attempt));
      }
    }
  }

  if (changed && action === "reject") {
    try {
      const { error: suppErr } = await svc.rpc("suppress_decision", {
        p_decision_id: decision_id,
        p_source: "reject",
      });
      if (suppErr) {
        console.warn(
          `[decide-service] suppress_decision failed for ${decision_id}: ${suppErr.message}`,
        );
      }
    } catch (e) {
      console.warn(
        `[decide-service] suppress_decision threw for ${decision_id}: ${(e as Error)?.message ?? "unknown"}`,
      );
    }

    void logDecisionNotTaken({
      tenant_id,
      rejection_type: "founder_override",
      agent_run_id: decisionRow.agent_run_id ?? null,
      decision_class: decisionRow.decision_class ?? null,
      reason_code: "operator_reject",
    });
    fireRejectStamp(decision_id, tenant_id);
    if (decisionRow.decision_class === "cgo.dispatch-specialist") {
      void import("@/services/growth/goal-attention").then(({ sendGoalAttention }) =>
        sendGoalAttention({ tenant_id, reason: "card_rejected", decision_id }),
      );
    }
    void (async () => {
      const { resumeAfterDecision } = await import(
        "@/services/agents/approve-resume-dispatch"
      );
      const { enqueueAgentRun } = await import("@/services/agents/runner");
      await resumeAfterDecision(
        {
          tenant_id,
          agent_run_id: decisionRow.agent_run_id ?? null,
          approved: false,
          toolName: decisionRow.decision_class ?? "the proposed action",
        },
        { enqueue: (input) => enqueueAgentRun(input), svc },
      );
    })().catch((e) =>
      console.warn(
        `[decide-service] reject-resume failed for ${decision_id}: ${(e as Error).message}`,
      ),
    );
  }

  if (changed && decisionRow.decision_class) {
    void bindActionOutcome({
      decisionId: decision_id,
      tenantId: tenant_id,
      decisionClass: decisionRow.decision_class,
      decisionOutcome: action === "approve" ? "approved" : "rejected",
      body: decisionRow.body ?? {},
    }).catch((e) =>
      console.warn(
        `[bind-action-outcome] best-effort failed for ${decision_id}: ${(e as Error).message}`,
      ),
    );
  }

  let allowlisted = false;
  if (always_allow === true && changed && action === "approve" && decisionRow.decision_class) {
    try {
      const { data: alData, error: alErr } = await svc.rpc("allowlist_class_for_tenant", {
        p_tenant_id: tenant_id,
        p_decision_class: decisionRow.decision_class,
        p_actor_user_id: actor.user_id,
      });
      if (alErr) {
        console.warn(
          `[allowlist-class] best-effort failed for ${decision_id} (${decisionRow.decision_class}): ${alErr.message}`,
        );
      } else {
        allowlisted = (alData as { ok?: boolean } | null)?.ok === true;
      }
    } catch (e) {
      console.warn(
        `[allowlist-class] threw for ${decision_id} (${decisionRow.decision_class}): ${(e as Error).message}`,
      );
    }
  }

  return {
    ok: true,
    code: "ok",
    changed,
    status,
    decision_id,
    decision_class: decisionRow.decision_class ?? null,
    allowlisted,
  };
}

export function isFounderRequestedBody(body: unknown): boolean {
  const o = (body && typeof body === "object" ? (body as { origin?: unknown }).origin : undefined);
  return o === "user_initiated_chat" || o === "user_initiated_ledger";
}
