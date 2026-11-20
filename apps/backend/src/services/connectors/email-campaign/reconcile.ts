
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { composioExecuteTool } from "@/services/connectors/composio/api";
import { reconcileChannelActionExec } from "@/services/channels/exec-actions";
import { sendMayHaveHappened, toExecProgress } from "@/services/channels/exec-progress";
import { approvedCountOf, audienceMismatchResult, auditSentContent, cardSubject, EMAIL_SEND_CLASS, messageOf, notConfirmedSentence, parseEmailSendBody, sameAudience, connectedCall, sentReceipt } from "./execute-send";
import { reportAudienceMismatch } from "./content-verify";
import { resolveSendgridAccount } from "./sendgrid-account";
import { EMAIL_PROVIDERS, EMAIL_TOOL_LABEL, type CampaignState } from "./providers";

export type ReconcileTarget = {
  tenant_id: string;
  exec_class: string | null;
  exec_status: string | null;
  exec_result: Record<string, unknown> | null;
  exec_payload: unknown;
  exec_progress: unknown;
  approved_by_source: string | null;
  lease_expired: boolean;
};

export type ReconcileResult = {
  done: boolean;
  outcome: "sent" | "not_sent" | "interrupted" | "audience_mismatch" | "nothing_to_do" | "in_flight" | "could_not_read" | "too_early" | "founder_told" | "notify_failed" | "could_not_check";
};

export type ReconcileDeps = {
  resolveAccount: typeof resolveOwnedComposioAccount;
  exec: typeof composioExecuteTool;
  resolveSendgrid?: typeof resolveSendgridAccount;
  sendgridFetch?: typeof fetch;
  settle: typeof reconcileChannelActionExec;
  notifyAutopilotSend: typeof import("@/services/growth/cgo-email").notifyFounderOfAutopilotSend;
  tell?: (o: import("@/services/email-cards/outcome").SendOutcome) => Promise<unknown>;
  reportAudience?: typeof reportAudienceMismatch;
};

const DEFAULT_DEPS: ReconcileDeps = {
  resolveAccount: resolveOwnedComposioAccount,
  exec: composioExecuteTool,
  resolveSendgrid: resolveSendgridAccount,
  sendgridFetch: (...args) => fetch(...args),
  settle: reconcileChannelActionExec,
  notifyAutopilotSend: async (...args) => (await import("@/services/growth/cgo-email")).notifyFounderOfAutopilotSend(...args),
  tell: async (o) => (await import("@/services/email-cards/outcome-tell")).tellEmailSendOutcomeOrQueue(o),
};

export async function reconcileEmailSend(
  actionId: string,
  t: ReconcileTarget,
  opts: { finalPass: boolean; lastPass?: boolean },
  depsIn: Partial<ReconcileDeps> = {},
): Promise<ReconcileResult> {
  const deps = { ...DEFAULT_DEPS, ...depsIn };
  if (t.exec_class !== EMAIL_SEND_CLASS) return { done: true, outcome: "nothing_to_do" };
  const progress = toExecProgress(t.exec_progress);
  const parsedBody = parseEmailSendBody(t.exec_payload);
  if (!progress || !parsedBody) return { done: true, outcome: "nothing_to_do" };
  const body = { data: parsedBody };
  if (t.exec_status === "dispatching" && !t.lease_expired) return { done: false, outcome: "in_flight" };
  if (t.exec_status === "executed") {
    if (t.approved_by_source !== "cgo") return { done: true, outcome: "nothing_to_do" };
    const b = body.data;
    let n = approvedCountOf(b);
    let url: string | null = null;
    try {
      const state = await EMAIL_PROVIDERS[b.tool].getCampaign(connectedCall(t.tenant_id, b, deps), progress.campaign_id);
      if (state?.recipients && state.recipients > 0) n = state.recipients;
      url = state ? sentReceipt(b.tool, n, state.url).url ?? null : null;
    } catch {
    }
    try {
      await deps.notifyAutopilotSend(t.tenant_id, { action_id: actionId, tool: b.tool, subject: cardSubject(b), audience_name: b.audience_name, sent_to: n, url });
      return { done: true, outcome: "founder_told" };
    } catch {
      return { done: false, outcome: "notify_failed" };
    }
  }
  const unknownFailure = t.exec_status === "failed" && t.exec_result?.code === "exec_outcome_unknown";
  const abandoned = t.exec_status === "dispatching" && t.lease_expired;
  if (!unknownFailure && !abandoned) return { done: true, outcome: "nothing_to_do" };

  const b = body.data;
  const label = EMAIL_TOOL_LABEL[b.tool];
  const settle = (ok: boolean, result: Record<string, unknown>, error: string | null) =>
    deps.settle(t.tenant_id, { actionId, ok, result: { ...result, reconciled: true }, error, execClass: EMAIL_SEND_CLASS });

  let state: CampaignState | null;
  try {
    state = await EMAIL_PROVIDERS[b.tool].getCampaign(connectedCall(t.tenant_id, b, deps), progress.campaign_id);
  } catch {
    if (!opts.lastPass) return { done: false, outcome: "could_not_read" };
    const error = `Zavi could not check ${label} to see whether this email went out: ${label} is no longer connected the way it was when this email was approved, or it did not answer. Zavi will not send this email again, so nobody gets it twice. Check it in ${label}.`;
    await settle(false, { error, code: "exec_partial" }, error);
    if (b.variants) await deps.tell?.({ tenant_id: t.tenant_id, rail: "channel_actions", card_id: actionId, outcome: "unknown", sent: null, reason: error }).catch(() => undefined);
    return { done: true, outcome: "could_not_check" };
  }

  const zeroSent = state?.phase === "sent" && state.emails_sent === 0;
  if (state && !zeroSent && (state.phase === "sent" || state.phase === "sending") && !sendMayHaveHappened(progress) && !sameAudience(state, b.audience_id)) {
    const r = audienceMismatchResult(label);
    await settle(false, { error: r.error, code: r.code, audience_mismatch: true }, r.error ?? null);
    void (deps.reportAudience ?? reportAudienceMismatch)(t.tenant_id, actionId, b.tool).catch(() => undefined);
    if (b.variants) await deps.tell?.({ tenant_id: t.tenant_id, rail: "channel_actions", card_id: actionId, outcome: "failed", sent: null, reason: r.error ?? null, kind: "audience_mismatch" }).catch(() => undefined);
    return { done: true, outcome: "audience_mismatch" };
  }

  if (state && !zeroSent && (state.phase === "sent" || state.phase === "sending")) {
    const n = state.recipients && state.recipients > 0 ? state.recipients : approvedCountOf(b);
    const receipt = sentReceipt(b.tool, n, state.url);
    await settle(true, { notice: `${receipt.line}.`, receipt }, `${receipt.line}.`);
    const picked = messageOf(b);
    if (picked.ok) void auditSentContent(t.tenant_id, b.tool, connectedCall(t.tenant_id, b, deps), progress.campaign_id, { html: picked.m.html, text: picked.m.text }).catch(() => undefined);
    if (b.variants) await deps.tell?.({ tenant_id: t.tenant_id, rail: "channel_actions", card_id: actionId, outcome: "sent", sent: n }).catch(() => undefined);
    if (t.approved_by_source === "cgo") {
      try {
        await deps.notifyAutopilotSend(t.tenant_id, { action_id: actionId, tool: b.tool, subject: cardSubject(b), audience_name: b.audience_name, sent_to: n, url: receipt.url ?? null });
      } catch {
        return { done: false, outcome: "notify_failed" };
      }
    }
    return { done: true, outcome: "sent" };
  }

  if (zeroSent) {
    if (!opts.finalPass) return { done: false, outcome: "too_early" };
    const error = notConfirmedSentence(label, state);
    await settle(false, { error, code: "exec_partial" }, error);
    if (b.variants) await deps.tell?.({ tenant_id: t.tenant_id, rail: "channel_actions", card_id: actionId, outcome: "unknown", sent: null, reason: error }).catch(() => undefined);
    return { done: true, outcome: "not_sent" };
  }

  if (!sendMayHaveHappened(progress)) {
    const error = "This send was interrupted before anything went out. Nothing was sent. Approve it again.";
    await settle(false, { error, interrupted: true }, error);
    if (b.variants) await deps.tell?.({ tenant_id: t.tenant_id, rail: "channel_actions", card_id: actionId, outcome: "failed", sent: 0, reason: error }).catch(() => undefined);
    return { done: true, outcome: "interrupted" };
  }

  if (state?.phase === "draft" && !opts.finalPass) return { done: false, outcome: "too_early" };
  const where = state ? `It is ${state.phase === "draft" ? "still a draft" : (state.raw_status ?? "in an unknown state")} in ${label}.` : `It is no longer in ${label}.`;
  const error =
    state?.phase === "draft"
      ? `This email was not sent. ${where} Zavi will not send this card again. Send it from ${label}, or ask Zavi for a new one.`
      : `Zavi could not confirm whether this email went out. ${where} Zavi will not send this card again. Check it in ${label}, or ask Zavi for a new one.`;
  await settle(false, { error, code: "exec_partial", ...(state?.phase === "draft" ? { not_sent: true } : {}) }, error);
  const told = state?.phase === "draft" ? { outcome: "failed" as const, sent: 0 } : { outcome: "unknown" as const, sent: null };
  if (b.variants) await deps.tell?.({ tenant_id: t.tenant_id, rail: "channel_actions", card_id: actionId, ...told, reason: error }).catch(() => undefined);
  return { done: true, outcome: "not_sent" };
}
