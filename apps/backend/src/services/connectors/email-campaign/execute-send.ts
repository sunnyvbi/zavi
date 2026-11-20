
import { z } from "zod";
import { composioExecuteTool, type ComposioExecResult } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { readExecProgress, recordExecProgress, sendMayHaveHappened, type ExecProgress } from "@/services/channels/exec-progress";
import { safeExecReceipt, type ExecReceipt } from "@/services/channels/exec-receipt";
import { renderEmailHtml } from "./render-html";
import { neutralizeTags } from "@/services/email-templates/render";
import { sealedCredentialSchema, type SealedCredential } from "./credential";
import { sendgridHttpCall } from "./providers-sendgrid";
import { resolveSendgridAccount } from "./sendgrid-account";
import { ExpectedToolError } from "@/services/tools/types";
import {
  chosenVersion,
  countAtSendRefusal,
  readTestListKeys,
  sealedVariantFields,
  TEST_LIST_REFUSAL,
  testListKey,
} from "@/services/email-cards/variants";
import { accountHeldReason, isAccountHeld, isKeyRejected, keyRejectedText, toolRefusalText, toolSaid, vendorReason, vendorRefusal } from "./provider-errors";
import { readAndCompare, readVerifyMode, reportAudienceMismatch, reportContentVerdict, verdictCode, type ReadVerdict, type VerifyMode } from "./content-verify";
import {
  EMAIL_PROVIDERS,
  EMAIL_TOOL_LABEL,
  EMAIL_TOOLS,
  EmailToolError,
  toolErrorText,
  toolStatus,
  type CampaignState,
  type EmailTool,
  type ProviderCall,
} from "./providers";

export const EMAIL_SEND_CLASS = "email_campaign.create_and_send";

export const EMAIL_BODY_INVALID_SENTENCE = "Zavi could not read this email's draft, so nothing was sent. Ask Zavi to draft it again.";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const EMAIL_ADDRESS = /^[^\s@<>"']{1,200}@[^\s@<>"']{1,118}\.[A-Za-z]{2,}$/;

const PROVIDER_ID = /^\d{1,15}$/;

export const emailSendBodySchema = z.object({
  tool: z.enum(EMAIL_TOOLS),
  credential: sealedCredentialSchema.optional(),
  connected_account_id: z.string().min(1).max(200).optional(),
  auth_config_id: z.string().min(1).max(200).optional(),
  sendgrid_sender_id: z.string().regex(PROVIDER_ID).nullable().optional(),
  sendgrid_suppression_group_id: z.string().regex(PROVIDER_ID).nullable().optional(),
  audience_id: z.string().regex(ID),
  audience_name: z.string().min(1).max(300),
  audience_count: z.number().int().min(1),
  subject: z.string().min(1).max(200).optional(),
  preview_text: z.string().max(200).nullable().optional(),
  body_text: z.string().min(1).max(100_000).optional(),
  variants: sealedVariantFields.variants.optional(),
  template_snapshot: sealedVariantFields.template_snapshot.optional(),
  renderer_version: sealedVariantFields.renderer_version.optional(),
  chosen_variant: sealedVariantFields.chosen_variant,
  approved_count: sealedVariantFields.approved_count,
  from_name: z.string().min(1).max(100),
  from_email: z.string().regex(EMAIL_ADDRESS),
  reply_to: z.string().regex(EMAIL_ADDRESS).nullable(),
  learnings_read: z
    .object({
      status: z.enum(["ok", "empty", "read_failed", "snapshot_failed"]),
      items: z.array(z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(300) }).strict()).max(12),
    })
    .strict()
    .optional(),
  planned_send_id: z.string().regex(ID).optional(),
  plan_version: z.number().int().min(1).optional(),
});
export type EmailSendBody = z.infer<typeof emailSendBodySchema>;

export function sealedCredentialOf(b: Pick<EmailSendBody, "tool" | "credential" | "connected_account_id" | "auth_config_id">): SealedCredential | null {
  if (b.credential) {
    if (b.connected_account_id !== undefined || b.auth_config_id !== undefined) return null;
    if (b.tool === "sendgrid") return b.credential.kind === "sendgrid_key" ? b.credential : null;
    return b.credential.kind === "composio" ? b.credential : null;
  }
  if (b.tool === "sendgrid" || !b.connected_account_id || !b.auth_config_id) return null;
  return { kind: "composio", connected_account_id: b.connected_account_id, auth_config_id: b.auth_config_id };
}

export function isVersionsBody(b: Pick<EmailSendBody, "variants">): boolean {
  return Array.isArray(b.variants);
}

function oneForm(b: EmailSendBody): boolean {
  const text = b.subject !== undefined && b.body_text !== undefined && b.preview_text !== undefined;
  const versions = b.variants !== undefined && b.template_snapshot !== undefined && b.renderer_version !== undefined;
  if (text) return !versions && b.variants === undefined && b.chosen_variant === undefined;
  return versions && b.subject === undefined && b.body_text === undefined && b.preview_text === undefined;
}

export function parseEmailSendBody(x: unknown): EmailSendBody | null {
  const p = emailSendBodySchema.safeParse(x);
  if (!p.success || !sealedCredentialOf(p.data) || !oneForm(p.data)) return null;
  if (p.data.tool === "sendgrid" && !(p.data.sendgrid_sender_id && p.data.sendgrid_suppression_group_id)) return null;
  return p.data;
}

export function cardSubject(b: Pick<EmailSendBody, "subject" | "variants" | "chosen_variant">): string {
  if (b.subject) return b.subject;
  const v = b.variants?.[(b.chosen_variant ?? 1) - 1] ?? b.variants?.[0];
  return v?.content.subject ?? "";
}

export function campaignTitleFor(actionId: string, subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim();
  const short = s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s;
  return `Zavi: ${short} (${actionId.replace(/-/g, "").slice(0, 8)})`;
}

export function approvedCountOf(b: Pick<EmailSendBody, "approved_count" | "audience_count">): number {
  return b.approved_count ?? b.audience_count;
}

export function peopleWords(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;
}

export function sentReceipt(tool: EmailTool, n: number, url: string | null, counted = false): ExecReceipt {
  const who = counted ? peopleWords(n) : `a list of ${peopleWords(n)}`;
  return safeExecReceipt({ line: `${EMAIL_TOOL_LABEL[tool]} accepted this send for ${who}. Delivery is not confirmed yet`, url }) as ExecReceipt;
}

export const EMAIL_ALL_SUPPRESSED_ERROR =
  "Everyone on this list is unsubscribed in SendGrid, so SendGrid would deliver to nobody. Nothing was sent. Pick another list, or check Suppressions in SendGrid.";

export type EmailSendRow = {
  id: string;
  tenant_id: string;
  body: unknown;
  approved_by_source?: string | null;
  exec_source?: "channel_actions";
  claim_id?: string;
};

export type EmailSendResult = {
  ok: boolean;
  error?: string;
  code?: string;
  notice?: string;
  outcome_unknown?: boolean;
  reconcile_queued?: boolean;
  audience_mismatch?: boolean;
  not_sent?: boolean;
  held_for_founder?: boolean;
  receipt?: ExecReceipt;
  sent_to?: number;
};

export type EmailSendDeps = {
  resolveAccount: typeof resolveOwnedComposioAccount;
  exec: typeof composioExecuteTool;
  resolveSendgrid?: typeof resolveSendgridAccount;
  sendgridFetch?: typeof fetch;
  readProgress: typeof readExecProgress;
  recordProgress: typeof recordExecProgress;
  scheduleReconcile: (actionId: string, claimId: string) => Promise<void>;
  scheduleDecisionReconcile?: (decisionId: string) => Promise<void>;
  authorizeCgo: typeof import("@/services/growth/unattended-email").authorizeUnattendedEmail;
  testListKeys?: typeof readTestListKeys;
  notifyAutopilotSend: typeof import("@/services/growth/cgo-email").notifyFounderOfAutopilotSend;
  sleep: (ms: number) => Promise<void>;
  recordSendRef?: (tenantId: string, cardId: string, tool: EmailTool, campaignId: string) => Promise<boolean>;
  markSendRefNotSent?: (tenantId: string, cardId: string) => Promise<boolean>;
  verifyContent?: (tool: EmailTool, call: ProviderCall, campaignId: string, sealed: { html: string; text: string }) => Promise<ReadVerdict>;
  verifyMode?: (tool: EmailTool) => Promise<VerifyMode>;
  reportContent?: typeof reportContentVerdict;
  reportAudience?: typeof reportAudienceMismatch;
  setting?: (tenantId: string, fieldId: string) => Promise<string | null>;
  paused?: (tenantId: string) => Promise<boolean>;
};

const DEFAULT_DEPS: EmailSendDeps = {
  resolveAccount: resolveOwnedComposioAccount,
  exec: composioExecuteTool,
  resolveSendgrid: resolveSendgridAccount,
  sendgridFetch: (...args) => fetch(...args),
  readProgress: readExecProgress,
  recordProgress: recordExecProgress,
  scheduleReconcile: async (actionId, claimId) => {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: `exec-reconcile:${actionId}:${claimId}`, name: "channel-action.exec-reconcile", data: { action_id: actionId } });
  },
  scheduleDecisionReconcile: async (decisionId) => {
    const { inngest } = await import("@/../workers/client");
    await inngest.send({ id: `decision-email-reconcile:${decisionId}`, name: "decision.email-send-reconcile", data: { decision_id: decisionId } });
  },
  authorizeCgo: async (...args) => (await import("@/services/growth/unattended-email")).authorizeUnattendedEmail(...args),
  testListKeys: readTestListKeys,
  notifyAutopilotSend: async (...args) => (await import("@/services/growth/cgo-email")).notifyFounderOfAutopilotSend(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  recordSendRef: async (tenantId, cardId, tool, campaignId) => {
    const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
    const { data, error } = await tenantRpc(asTenantId(tenantId), "record_email_send_ref", {
      p_rail: "decisions",
      p_card_id: cardId,
      p_route: tool,
      p_provider_ref: campaignId,
    });
    return !error && data === true;
  },
  markSendRefNotSent,
  verifyContent: (tool, call, campaignId, sealed) => readAndCompare(tool, call, campaignId, sealed),
  verifyMode: readVerifyMode,
  reportContent: reportContentVerdict,
  setting: async (tenantId, fieldId) => (await import("@/services/comms/bulk-outbound/readiness")).readEmailSettingText(tenantId, fieldId),
  paused: async (tenantId) => (await import("@/services/email-cards/pause")).emailSendPaused(tenantId),
};

export const EMAIL_PAUSED_CODE = "email_paused";

export const EMAIL_PAUSED_ERROR =
  "Email sending is paused for this workspace, so Zavi did not start this send. Nothing was sent. Resume email in Email campaigns settings, then try again.";

export const EMAIL_PAUSED_MID_SEND_ERROR =
  "Email sending was paused while this send was waiting, so Zavi stopped it. Nothing was sent. The draft is still in the connected email tool. This card cannot be sent again: send the draft from there once email is resumed, or ask Zavi for a new one.";

export const EMAIL_PAUSED_ONE_TO_ONE_ERROR =
  "Email sending was paused for this workspace, so Zavi did not send this email and will not send it later. Nothing was sent. To send it, turn email sending back on in Email campaigns settings and ask Zavi again.";

export function autopilotListMatches(b: Pick<EmailSendBody, "audience_name">, audience: Pick<import("./providers").Audience, "name">): boolean {
  return audience.name.slice(0, 300) === b.audience_name;
}

export async function autopilotSenderMatches(
  tenantId: string,
  b: EmailSendBody,
  call: ProviderCall,
  audience: import("./providers").Audience,
  deps: Pick<EmailSendDeps, "setting"> = {},
): Promise<boolean> {
  const provider = EMAIL_PROVIDERS[b.tool];
  if (b.tool === "sendgrid") {
    let pinned: string | null;
    try {
      pinned = await (deps.setting ?? DEFAULT_DEPS.setting!)(tenantId, "sendgrid_sender_id");
    } catch {
      return false;
    }
    if (pinned) {
      if (pinned !== b.sendgrid_sender_id || !provider.verifiedSender) return false;
      const live = await provider.verifiedSender(call, pinned).catch(() => null);
      return !!live && live.email.toLowerCase() === b.from_email.toLowerCase() && (live.name ?? "") === b.from_name;
    }
  }
  const sender = await provider.defaultSender(call, audience).catch(() => ({ name: null, email: null }));
  return !!sender.name && !!sender.email && sender.name === b.from_name && sender.email.toLowerCase() === b.from_email.toLowerCase();
}

export async function autopilotSenderMatchesCard(tenantId: string, payload: unknown): Promise<boolean> {
  try {
    const b = parseEmailSendBody(payload);
    if (!b) return false;
    const call = connectedCall(tenantId, b, DEFAULT_DEPS);
    const audience = await EMAIL_PROVIDERS[b.tool].getAudience(call, b.audience_id);
    if (!audience) return false;
    return await autopilotSenderMatches(tenantId, b, call, audience);
  } catch {
    return false;
  }
}

export class NotConnected extends Error {}

const CONFIRM_READS = 3;
const CONFIRM_WAIT_MS = 2_000;
const PHASE_RETRY_MS = 1_000;
const SEND_BUSY_TRIES = 3;
const SEND_BUSY_WAIT_MS = 5_000;
const SEND_BUSY_MAX_WAIT_MS = 30_000;

function busyRefusal(r: ComposioExecResult): boolean {
  return !r.ok && !r.outcome_unknown && toolStatus(r) === 429;
}

export function connectedCall(
  tenantId: string,
  b: Pick<EmailSendBody, "tool" | "credential" | "connected_account_id" | "auth_config_id">,
  deps: Pick<EmailSendDeps, "resolveAccount" | "exec"> & Partial<Pick<EmailSendDeps, "resolveSendgrid" | "sendgridFetch">>,
): ProviderCall {
  return async (tool_slug, args) => {
    if (!sealedCredentialOf(b)) throw new NotConnected();
    if (b.tool === "sendgrid") {
      const sg = await (deps.resolveSendgrid ?? resolveSendgridAccount)(tenantId);
      if (!sg) throw new NotConnected();
      return sendgridHttpCall(sg.api_key, deps.sendgridFetch ?? fetch)(tool_slug, args);
    }
    const account = await deps.resolveAccount(tenantId, b.tool);
    if (!account) throw new NotConnected();
    return deps.exec({ tool_slug, user_id: account.tenant_id, connected_account_id: account.connected_account_id, arguments: args });
  };
}

type Message = { subject: string; preview_text: string | null; html: string; text: string; versions: boolean };

export function messageOf(b: EmailSendBody): { ok: true; m: Message } | { ok: false; reason: string } {
  if (isVersionsBody(b)) {
    const c = chosenVersion({ variants: b.variants ?? [], renderer_version: b.renderer_version ?? "", chosen_variant: b.chosen_variant });
    if (!c.ok) return c;
    return { ok: true, m: { subject: c.version.subject, preview_text: c.version.preview_text, html: c.version.html, text: c.version.text, versions: true } };
  }
  const safe = (s: string) => (b.tool === "klaviyo" ? neutralizeTags(s) : s);
  const subject = safe(b.subject ?? "");
  const preview = b.preview_text == null ? null : safe(b.preview_text);
  const text = safe(b.body_text ?? "");
  const html = b.tool === "sendgrid" ? renderEmailHtml(text, { preheader: preview }) : renderEmailHtml(text);
  return { ok: true, m: { subject, preview_text: preview, html, text, versions: false } };
}

export const OUTCOME_UNKNOWN_SUFFIX = " (exec_outcome_unknown)";

export const EMAIL_TOOL_SEND_BOUND_MS = 30 * 60 * 1000;

export function checkingLaterSentence(label: string): string {
  return `${label} did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Zavi checks ${label} in a few minutes and updates this card.`;
}

export const REDRAFT_REQUIRED_ERROR =
  "This email was drafted before emails had versions and a test send, so Zavi does not send it. Nothing was sent. Ask Zavi to draft it again.";

export async function markSendRefNotSent(tenantId: string, cardId: string): Promise<boolean> {
  const { asTenantId, tenantRpc } = await import("@/services/tenant-client");
  const { data, error } = await tenantRpc(asTenantId(tenantId), "mark_email_send_ref_not_sent", { p_rail: "decisions", p_card_id: cardId });
  return !error && data === true;
}

export async function executeEmailCampaignSendAndTell(
  d: EmailSendRow,
  depsIn: Partial<EmailSendDeps> = {},
  tell: (o: import("@/services/email-cards/outcome").SendOutcome) => Promise<unknown> = async (o) =>
    (await import("@/services/email-cards/outcome-tell")).tellEmailSendOutcomeOrQueue(o),
): Promise<EmailSendResult> {
  const parsed = parseEmailSendBody(d.body);
  if (parsed && !isVersionsBody(parsed)) return { ok: false, code: "email_redraft_required", error: REDRAFT_REQUIRED_ERROR };
  let r: EmailSendResult;
  try {
    r = await executeEmailCampaignSend(d, depsIn);
  } catch (e) {
    if (e instanceof ExpectedToolError) throw e;
    console.warn(`[email-campaign/execute-send] ${d.id}: send threw: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    return { ok: false, error: (await import("@/services/email-cards/cards")).SEND_FAILED_FALLBACK };
  }
  const b = parsed;
  const rail = d.exec_source === "channel_actions" ? "channel_actions" : "decisions";
  if (rail === "decisions" && r.not_sent) {
    await (depsIn.markSendRefNotSent ?? DEFAULT_DEPS.markSendRefNotSent!)(d.tenant_id, d.id).catch(() => false);
  }
  if (b && r.outcome_unknown && rail === "decisions") {
    const schedule = depsIn.scheduleDecisionReconcile ?? DEFAULT_DEPS.scheduleDecisionReconcile!;
    const queued = await schedule(d.id).then(
      () => true,
      () => false,
    );
    if (queued) return { ...r, reconcile_queued: true, error: checkingLaterSentence(EMAIL_TOOL_LABEL[b.tool]) };
    await tell({ tenant_id: d.tenant_id, rail, card_id: d.id, outcome: "unknown", sent: null, reason: r.error ?? null }).catch(() => undefined);
    return r;
  }
  if (!b || r.outcome_unknown || r.held_for_founder || r.code === EMAIL_PAUSED_CODE) return r;
  await tell(
    r.ok
      ? { tenant_id: d.tenant_id, rail, card_id: d.id, outcome: "sent", sent: r.sent_to ?? null }
      : r.audience_mismatch
        ? { tenant_id: d.tenant_id, rail, card_id: d.id, outcome: "failed", sent: null, reason: r.error ?? null, kind: "audience_mismatch" }
        : { tenant_id: d.tenant_id, rail, card_id: d.id, outcome: "failed", sent: 0, reason: r.error ?? null },
  ).catch(() => undefined);
  return r;
}

export async function executeEmailCampaignSend(d: EmailSendRow, depsIn: Partial<EmailSendDeps> = {}): Promise<EmailSendResult> {
  const deps = { ...DEFAULT_DEPS, ...depsIn };
  const b = parseEmailSendBody(d.body);
  if (!b) return { ok: false, code: "email_campaign_body_invalid", error: EMAIL_BODY_INVALID_SENTENCE };
  const label = EMAIL_TOOL_LABEL[b.tool];
  const picked = messageOf(b);
  if (!picked.ok) return { ok: false, code: "email_version_not_chosen", error: `${picked.reason} Nothing was sent. Open the email in Zavi and approve a version there.` };
  const m = picked.m;
  const env = { ...b, subject: m.subject, preview_text: m.preview_text };
  const provider = EMAIL_PROVIDERS[b.tool];
  const call = connectedCall(d.tenant_id, b, deps);
  const title = campaignTitleFor(d.id, m.subject);
  const byCgo = d.approved_by_source === "cgo";
  const claim = d.exec_source === "channel_actions" && d.claim_id ? d.claim_id : null;
  let refRecorded: string | null = null;

  const notConnected = (): EmailSendResult => ({
    ok: false,
    code: "email_tool_not_connected",
    error: `${label} is not connected. Nothing was sent. Reconnect ${label}, then approve again.`,
  });
  const refused = (why: string): EmailSendResult => ({ ok: false, code: "email_tool_refused", error: `${label} did not accept this: ${why} Nothing was sent.` });
  const changedSince = (what: string): EmailSendResult => ({
    ok: false,
    code: "email_tool_refused",
    error: `Zavi stopped this send: the ${what} in ${label} changed since the card was made. Nothing was sent. Ask Zavi for a new draft if the change is right.`,
  });
  const unknown = (): EmailSendResult => ({
    ok: false,
    code: "exec_outcome_unknown",
    outcome_unknown: true,
    error: claim
      ? checkingLaterSentence(label)
      : `${label} did not confirm whether this email was sent. Zavi will not send it again, so nobody gets it twice. Open ${label} to see whether it went out.`,
  });
  const stoppedAfterRefusal = (error: string, code: string = EMAIL_PAUSED_CODE, extra: Partial<EmailSendResult> = {}): EmailSendResult =>
    claim ? { ...extra, ok: false, code: "exec_partial", not_sent: true, error } : { ...extra, ok: false, code, not_sent: true, error };
  const pausedMidSend = claim ? EMAIL_PAUSED_MID_SEND_ERROR : `${EMAIL_PAUSED_ERROR} The draft is still in the connected email tool.`;
  const noRetryLeft = (error: string): string =>
    claim ? `${error.replace(/ (?:Approve it again|Try again)[^.]*\.$/, "")} This card cannot be sent again. Ask Zavi for a new draft.` : error;
  const senderChanged = (live: { email: string; name: string | null } | null): boolean =>
    !live || live.email.toLowerCase() !== b.from_email.toLowerCase() || (live.name !== null && live.name.trim() !== b.from_name.trim());
  const reconcileSoon = async () => {
    if (!claim) return;
    await deps.scheduleReconcile(d.id, claim).catch(() => undefined);
  };
  const progress = async (p: ExecProgress): Promise<boolean> => (claim ? deps.recordProgress(d.tenant_id, d.id, claim, p) : true);
  const interrupted: EmailSendResult = { ok: false, error: "This send was interrupted before anything went out. Nothing was sent. Approve it again." };

  let reachable: number | null = null;
  const sentResult = async (state: CampaignState, live: number | null = null, ours = false): Promise<EmailSendResult> => {
    const n = state.recipients && state.recipients > 0 ? state.recipients : reachable !== null ? reachable : live !== null ? live : approvedCountOf(b);
    const receipt = sentReceipt(b.tool, n, state.url, reachable !== null);
    if (claim) await deps.recordProgress(d.tenant_id, d.id, claim, { campaign_id: state.id, stage: "sent" }).catch(() => false);
    else if (deps.recordSendRef && refRecorded !== state.id) await deps.recordSendRef(d.tenant_id, d.id, b.tool, state.id).catch(() => false);
    if (!ours) void auditSentContent(d.tenant_id, b.tool, call, state.id, { html: m.html, text: m.text }, deps).catch(() => undefined);
    if (byCgo) {
      await deps
        .notifyAutopilotSend(d.tenant_id, { action_id: d.id, tool: b.tool, subject: m.subject, audience_name: b.audience_name, sent_to: n, url: receipt.url ?? null })
        .catch(() => undefined);
    }
    return { ok: true, notice: `${receipt.line}.`, receipt, sent_to: n };
  };

  const alreadyGoing = async (state: CampaignState): Promise<EmailSendResult> => {
    const namesOtherAudience = state.audience_ids.some((id) => id !== b.audience_id);
    if (state.phase === "sent" && state.emails_sent === 0 && !namesOtherAudience) {
      if (claim) await deps.recordProgress(d.tenant_id, d.id, claim, { campaign_id: state.id, stage: "send_requested" }).catch(() => false);
      await reconcileSoon();
      return { ...unknown(), error: claim ? unknown().error : notConfirmedSentence(label, state) };
    }
    if (sameAudience(state, b.audience_id)) return await sentResult(state);
    void (deps.reportAudience ?? reportAudienceMismatch)(d.tenant_id, d.id, b.tool).catch(() => undefined);
    return audienceMismatchResult(label);
  };

  if (byCgo && !claim) return { ok: false, held_for_founder: true, error: "Autopilot may only send from the Email campaigns channel. Nothing was sent." };

  let stored: ExecProgress | null = null;
  if (claim) {
    try {
      stored = await deps.readProgress(d.tenant_id, d.id);
    } catch {
      return { ok: false, error: "Zavi could not check how far this send got, so it did not start. Nothing was sent. Approve it again." };
    }
    if (sendMayHaveHappened(stored)) {
      await reconcileSoon();
      return unknown();
    }
    if (stored) {
      let prior: CampaignState | null;
      try {
        prior = await provider.getCampaign(call, stored.campaign_id);
      } catch {
        await reconcileSoon();
        return unknown();
      }
      if (!prior) stored = null;
      else if (prior.phase === "sent" || prior.phase === "sending") return await alreadyGoing(prior);
      else if (prior.phase !== "draft") return refused(`the campaign is ${prior.raw_status ?? "not a draft"} there.`);
    }
  }

  if (m.versions) {
    let marked: ReadonlySet<string>;
    try {
      marked = await (deps.testListKeys ?? readTestListKeys)(d.tenant_id);
    } catch {
      return { ok: false, error: "Zavi could not check whether this is one of your test lists, so it did not send. Nothing was sent. Approve it again." };
    }
    if (marked.has(testListKey(b.tool, b.audience_id))) return { ok: false, code: "email_test_list", error: TEST_LIST_REFUSAL };
  }
  const approvedCount = approvedCountOf(b);
  const plannedCard = !!d.body && typeof d.body === "object" && typeof (d.body as { planned_send_id?: unknown }).planned_send_id === "string";
  const grew = (now: number | null): EmailSendResult | null => {
    if (!m.versions) return null;
    if (now === null) {
      return { ok: false, code: "email_count_unreadable", error: `${label} did not say how many people are on "${b.audience_name}" right now, so Zavi did not send. Nothing was sent. Approve it again.` };
    }
    const why = countAtSendRefusal({ approved: approvedCount, live: now, byAutopilot: byCgo, planned: plannedCard });
    return why ? { ok: false, code: "email_list_grew", error: why, ...(byCgo ? { held_for_founder: true } : {}) } : null;
  };

  const nobody = (now: number | null): EmailSendResult | null =>
    now === 0
      ? { ok: false, code: "email_list_empty", error: `Nobody on "${b.audience_name}" can receive this right now, so Zavi did not send. Nothing was sent.`, ...(byCgo ? { held_for_founder: true } : {}) }
      : null;

  let sendRequested = false;
  try {
    const audience = await provider.getAudience(call, b.audience_id);
    if (!audience) {
      return { ok: false, code: "email_audience_missing", error: `The list "${b.audience_name}" is no longer in ${label}. Nothing was sent.` };
    }
    if (!autopilotListMatches(b, audience)) {
      return byCgo
        ? {
            ok: false,
            held_for_founder: true,
            error: `Autopilot did not send this on its own: the list with this id in ${label} is not named "${b.audience_name}". Nothing was sent. Send it yourself if the list is right.`,
          }
        : {
            ok: false,
            code: "email_list_renamed",
            error: `The list with this id in ${label} is now named "${audience.name.slice(0, 300)}", not "${b.audience_name}", so Zavi did not send. Nothing was sent. Ask Zavi for a new email to that list if it is the right one.`,
          };
    }
    const early = audience.member_count === null ? null : grew(audience.member_count);
    if (early) return early;

    const ids: SendIds | null =
      b.tool === "sendgrid" && b.sendgrid_sender_id && b.sendgrid_suppression_group_id
        ? { sender_id: b.sendgrid_sender_id, suppression_group_id: b.sendgrid_suppression_group_id }
        : null;

    let campaignId: string | null = stored?.campaign_id ?? null;
    let reused = campaignId !== null;
    if (!campaignId) {
      let matches = await provider.findCampaignsByTitle(call, title);
      if (matches.length === 0) {
        try {
          campaignId = await provider.createCampaign(call, {
            title,
            audience_id: b.audience_id,
            subject: m.subject,
            preview_text: m.preview_text,
            from_name: b.from_name,
            from_email: b.from_email,
            reply_to: b.reply_to,
            ...(ids ?? {}),
          });
        } catch (e) {
          if (!(e instanceof EmailToolError) || !e.outcome_unknown) throw e;
          matches = await provider.findCampaignsByTitle(call, title);
          if (matches.length === 0) {
            return { ok: false, error: `${label} did not confirm the new campaign. Nothing was sent. Approve it again: Zavi looks for the campaign first, so no second copy is made.` };
          }
        }
      }
      if (!campaignId) {
        if (matches.length > 1) return refused(`more than one campaign named "${title}" exists there, so Zavi cannot tell which is this one.`);
        const own = matches[0];
        if (own.phase === "sent" || own.phase === "sending") return await alreadyGoing(own);
        if (!sameAudience(own, b.audience_id)) return refused(`the campaign named "${title}" goes to a different list.`);
        if (own.phase !== "draft") return refused(`the campaign named "${title}" is ${own.raw_status ?? "not a draft"} there.`);
        campaignId = own.id;
        reused = true;
      }
      if (!(await progress({ campaign_id: campaignId, stage: "created" }))) return interrupted;
    }
    if (claim) {
      try {
        await deps.scheduleReconcile(d.id, claim);
      } catch {
        return { ok: false, error: "Zavi could not schedule its follow-up check, so it did not send. Nothing was sent. Approve it again." };
      }
    }

    if (reused) {
      await provider.setEnvelope(call, campaignId, { subject: m.subject, preview_text: m.preview_text, from_name: b.from_name, from_email: b.from_email, reply_to: b.reply_to, ...(ids ?? {}) });
    }
    await provider.setContent(call, campaignId, { title, html: m.html, text: m.text });
    if (!(await progress({ campaign_id: campaignId, stage: "content_set" }))) return interrupted;
    const ready = await provider.readiness(call, campaignId);
    if (!ready.ready) return refused(endStop(ready.reason ?? "its send checklist is not complete"));

    const before = await provider.getCampaign(call, campaignId);
    if (!before) return refused("the campaign is no longer there.");
    if (before.phase === "sent" || before.phase === "sending") {
      return await alreadyGoing(before);
    }
    if (!sameAudience(before, b.audience_id)) {
      return refused(before.narrowed ? "the campaign now goes to only part of the list (a segment or an exclusion was added)." : "the campaign now goes to a different list.");
    }
    if (before.phase !== "draft") return refused(`the campaign is ${before.raw_status ?? "not a draft"} there.`);
    const mismatch = envelopeMismatch(before, env, ids);
    if (mismatch) return changedSince(mismatch);
    if (ids && provider.verifiedSender) {
      const liveSender = await provider.verifiedSender(call, ids.sender_id);
      if (senderChanged(liveSender)) return changedSince("sender");
    }

    let live = await provider.liveRecipientCount(call, campaignId, b.audience_id, deps.sleep);
    const noneNow = nobody(live);
    if (noneNow) return noneNow;
    if (provider.suppressedOnList && b.sendgrid_suppression_group_id && live !== null && live > 0) {
      const sup = await provider.suppressedOnList(call, b.audience_id, b.sendgrid_suppression_group_id);
      if (sup.suppressed >= live) return { ok: false, code: "email_all_suppressed", error: EMAIL_ALL_SUPPRESSED_ERROR };
      reachable = sup.complete ? live - sup.suppressed : null;
      if (!sup.complete) console.warn(`[email-send] unsubscribes not fully read for ${d.id}`);
    }
    if (byCgo) {
      if (!(await autopilotSenderMatches(d.tenant_id, b, call, audience, deps))) {
        return {
          ok: false,
          held_for_founder: true,
          error: `Autopilot did not send this on its own: it is not from the sender picked in Email campaigns settings, or your default sender in ${label}. Nothing was sent. Send it yourself if the sender on the card is right.`,
        };
      }
      const v = await deps.authorizeCgo(
        d.tenant_id,
        { action_id: d.id, exec_class: EMAIL_SEND_CLASS, payload: b, audience_count: live },
        { where: "executor" },
      );
      if (v.verdict !== "allow") {
        const { heldEmailAsk } = await import("@/services/growth/unattended-email");
        return { ok: false, held_for_founder: true, error: heldEmailAsk(v.reasons) };
      }
    }

    const late = grew(live);
    if (late) return late;

    if (m.versions) {
      let marked: ReadonlySet<string>;
      try {
        marked = await (deps.testListKeys ?? readTestListKeys)(d.tenant_id);
      } catch {
        return { ok: false, error: "Zavi could not check whether this is one of your test lists, so it did not send. Nothing was sent. Approve it again." };
      }
      if (marked.has(testListKey(b.tool, b.audience_id))) return { ok: false, code: "email_test_list", error: TEST_LIST_REFUSAL };
    }
    const verdict = await (deps.verifyContent ?? DEFAULT_DEPS.verifyContent!)(b.tool, call, campaignId, { html: m.html, text: m.text });
    if (verdict.status !== "match") {
      const mode = await (deps.verifyMode ?? DEFAULT_DEPS.verifyMode!)(b.tool).catch((): VerifyMode => "shadow");
      void (deps.reportContent ?? DEFAULT_DEPS.reportContent!)(d.tenant_id, b.tool, "before_send", verdict, mode).catch(() => undefined);
      if (mode === "enforce") {
        const phaseNow = () => provider.getCampaign(call, campaignId).then((c) => ({ c }), () => null);
        let now = await phaseNow();
        if (!now) {
          await deps.sleep(PHASE_RETRY_MS);
          now = await phaseNow();
        }
        if (!now) {
          if (!claim) {
            return {
              ok: false,
              code: verdictCode(verdict) ?? "email_content_unverifiable",
              error: `Zavi could not confirm the campaign's state in ${label}. Nothing was sent by Zavi. Approve it again: Zavi checks the campaign first and never sends it twice.`,
            };
          }
          await reconcileSoon();
          return unknown();
        }
        if (now.c && (now.c.phase === "sent" || now.c.phase === "sending")) return await alreadyGoing(now.c);
        return contentRefusal(label, verdict);
      }
    }
    const last = await provider.getCampaign(call, campaignId);
    if (!last) return refused("the campaign is no longer there.");
    if (last.phase === "sent" || last.phase === "sending") return await alreadyGoing(last);
    if (last.phase !== "draft") return refused(`the campaign is ${last.raw_status ?? "not a draft"} there.`);

    let paused: boolean;
    try {
      paused = await (deps.paused ?? DEFAULT_DEPS.paused!)(d.tenant_id);
    } catch {
      return { ok: false, code: EMAIL_PAUSED_CODE, error: "Zavi could not verify whether email sending is paused, so it did not send. Nothing was sent. Try again." };
    }
    if (paused) return { ok: false, code: EMAIL_PAUSED_CODE, error: EMAIL_PAUSED_ERROR };

    if (!(await progress({ campaign_id: campaignId, stage: "send_requested" }))) return interrupted;
    if (!claim && deps.recordSendRef) {
      const recorded = await deps.recordSendRef(d.tenant_id, d.id, b.tool, campaignId).catch(() => false);
      if (!recorded) return { ok: false, error: "Zavi could not record which campaign this is, so it did not send. Nothing was sent. Approve it again." };
      refRecorded = campaignId;
    }
    sendRequested = true;
    let sent = await provider.send(call, campaignId);
    for (let tries = 1; tries < SEND_BUSY_TRIES && busyRefusal(sent); tries++) {
      const askedMs = (sent.retry_after_s ?? 0) * 1000;
      if (askedMs > SEND_BUSY_MAX_WAIT_MS) break;
      await deps.sleep(Math.max(askedMs, SEND_BUSY_WAIT_MS * tries));
      const still = await provider.getCampaign(call, campaignId).catch(() => null);
      if (still && (still.phase === "sent" || still.phase === "sending")) return await alreadyGoing(still);
      if (still?.phase !== "draft") break;
      try {
        paused = await (deps.paused ?? DEFAULT_DEPS.paused!)(d.tenant_id);
      } catch {
        return stoppedAfterRefusal("Zavi could not verify whether email sending is paused, so it did not retry. Nothing was sent. The draft is still in the connected email tool.");
      }
      if (paused) return stoppedAfterRefusal(pausedMidSend);
      try {
        if (!sameAudience(still, b.audience_id)) {
          void (deps.reportAudience ?? reportAudienceMismatch)(d.tenant_id, d.id, b.tool).catch(() => undefined);
          return stoppedAfterRefusal(
            `Zavi stopped this retry because the campaign in ${label} no longer goes to the approved list. Nothing was sent by Zavi. Ask Zavi for a new draft if the change is right.`,
            "email_tool_refused",
          );
        }
        const retryMismatch = envelopeMismatch(still, env, ids);
        if (retryMismatch) {
          const changed = changedSince(retryMismatch);
          return stoppedAfterRefusal(changed.error!, changed.code);
        }
        if (ids && provider.verifiedSender) {
          const liveSender = await provider.verifiedSender(call, ids.sender_id);
          if (senderChanged(liveSender)) {
            const changed = changedSince("sender");
            return stoppedAfterRefusal(changed.error!, changed.code);
          }
        }
        live = await provider.liveRecipientCount(call, campaignId, b.audience_id, deps.sleep);
        const noneOnRetry = nobody(live);
        if (noneOnRetry) return stoppedAfterRefusal(noneOnRetry.error!, noneOnRetry.code, noneOnRetry);
        if (byCgo) {
          if (!(await autopilotSenderMatches(d.tenant_id, b, call, audience, deps))) {
            return stoppedAfterRefusal(
              `Autopilot did not retry this on its own because the sender no longer matches Email campaigns settings. Nothing was sent.`,
              "email_tool_refused",
              { held_for_founder: true },
            );
          }
          const authorization = await deps.authorizeCgo(
            d.tenant_id,
            { action_id: d.id, exec_class: EMAIL_SEND_CLASS, payload: b, audience_count: live },
            { where: "executor" },
          );
          if (authorization.verdict !== "allow") {
            const { heldEmailAsk } = await import("@/services/growth/unattended-email");
            return stoppedAfterRefusal(heldEmailAsk(authorization.reasons), "email_tool_refused", { held_for_founder: true });
          }
        }
        const retryGrowth = grew(live);
        if (retryGrowth) return stoppedAfterRefusal(noRetryLeft(retryGrowth.error!), retryGrowth.code, retryGrowth);
        if (m.versions) {
          const marked = await (deps.testListKeys ?? readTestListKeys)(d.tenant_id);
          if (marked.has(testListKey(b.tool, b.audience_id))) {
            return stoppedAfterRefusal(TEST_LIST_REFUSAL, "email_test_list");
          }
        }
        const retryContent = await (deps.verifyContent ?? DEFAULT_DEPS.verifyContent!)(b.tool, call, campaignId, { html: m.html, text: m.text });
        if (retryContent.status !== "match") {
          const mode = await (deps.verifyMode ?? DEFAULT_DEPS.verifyMode!)(b.tool).catch((): VerifyMode => "shadow");
          void (deps.reportContent ?? DEFAULT_DEPS.reportContent!)(d.tenant_id, b.tool, "before_send", retryContent, mode).catch(() => undefined);
          if (mode === "enforce") {
            const refusal = contentRefusal(label, retryContent);
            return stoppedAfterRefusal(noRetryLeft(refusal.error!), refusal.code);
          }
        }
        const retryReady = await provider.readiness(call, campaignId);
        if (!retryReady.ready) {
          return stoppedAfterRefusal(`${label} did not accept this retry: ${endStop(retryReady.reason ?? "its send checklist is not complete")} Nothing was sent.`, "email_tool_refused");
        }
        paused = await (deps.paused ?? DEFAULT_DEPS.paused!)(d.tenant_id);
        if (paused) return stoppedAfterRefusal(pausedMidSend);
      } catch {
        return stoppedAfterRefusal(`Zavi could not recheck the campaign after ${label} asked it to wait, so it did not retry. Nothing was sent. The draft is still in ${label}.`, "email_tool_refused");
      }
      sent = await provider.send(call, campaignId);
    }
    if (!sent.ok && !sent.outcome_unknown) {
      const raw = toolErrorText(sent.error, sent.status);
      console.warn(`[email-send] ${b.tool} refused the send of ${d.id}: ${raw}`);
      const refusedAs = new EmailToolError(raw, false, toolStatus(sent), null, vendorRefusal(sent.data)?.said || null);
      const why = toolStatus(sent) === 429 ? `${label} was busy (rate limit) and did not take it` : isAccountHeld(toolSaid(refusedAs)) ? accountHeldReason(label) : vendorReason(label, sent.data, sent.error);
      const back = await provider.getCampaign(call, campaignId).catch(() => null);
      const keyRejected = isKeyRejected(refusedAs);
      return {
        ok: false,
        code: "exec_partial",
        ...(back?.phase === "draft" ? { not_sent: true } : {}),
        error: keyRejected
          ? keyRejectedText(label)
          : back?.phase === "draft"
            ? `${label} refused to send this${why ? `: ${why}` : ""}. Nothing was sent. The draft is in ${label}; send it from there, or ask Zavi for a new one.`
            : `${label} refused to send this${why ? `: ${why}` : ""}. Zavi could not read the campaign back to confirm nothing went out. Check it in ${label}; Zavi will not send it again.`,
      };
    }

    let after: CampaignState | null = null;
    for (let i = 0; i < CONFIRM_READS; i++) {
      after = await provider.getCampaign(call, campaignId).catch(() => null);
      if (goingOut(after)) break;
      if (i < CONFIRM_READS - 1) await deps.sleep(CONFIRM_WAIT_MS);
    }
    const confirmed = goingOut(after);
    if (!confirmed) {
      await reconcileSoon();
      return claim || !sent.ok ? unknown() : { ...unknown(), error: notConfirmedSentence(label, after) };
    }
    return await sentResult(after ?? before, live, true);
  } catch (e) {
    if (sendRequested) return unknown();
    if (e instanceof NotConnected) return notConnected();
    if (isKeyRejected(e)) return { ok: false, code: "email_tool_refused", error: keyRejectedText(label) };
    if (e instanceof EmailToolError) {
      console.warn(`[email-send] ${b.tool} error on ${d.id}: ${toolErrorText(e.message, e.status ?? 0)}`);
      if (e.outcome_unknown) return { ok: false, error: `${label} did not answer clearly. Nothing was sent. Approve it again: Zavi picks up where it stopped.` };
      if (isAccountHeld(toolSaid(e))) return refused(`${accountHeldReason(label)}.`);
      return { ok: false, code: "email_tool_refused", error: toolRefusalText(label, e.message) };
    }
    return { ok: false, error: `Zavi could not finish this in ${label}. Nothing was sent. Approve it again.` };
  }
}

export async function auditSentContent(
  tenantId: string,
  tool: EmailTool,
  call: ProviderCall,
  campaignId: string,
  sealed: { html: string; text: string },
  deps: Pick<EmailSendDeps, "reportContent"> & { read?: typeof readAndCompare } = {},
): Promise<void> {
  try {
    const v = await (deps.read ?? readAndCompare)(tool, call, campaignId, sealed, { deadlineMs: 8_000 });
    if (v.status !== "match") await (deps.reportContent ?? reportContentVerdict)(tenantId, tool, "after_send", v, "shadow");
  } catch {
  }
}

export function audienceMismatchResult(label: string): EmailSendResult {
  return {
    ok: false,
    code: "exec_partial",
    audience_mismatch: true,
    error: `${label} is sending this campaign to a different list than the card. Zavi did not start that send and will not send this card again. Check it in ${label}.`,
  };
}

function contentRefusal(label: string, v: ReadVerdict): EmailSendResult {
  const code = verdictCode(v) ?? "email_content_unverifiable";
  return code === "email_content_changed"
    ? { ok: false, code, error: `The email in ${label} was changed after Zavi wrote it, so Zavi did not send it. Nothing was sent. Try again to write it from the card.` }
    : { ok: false, code, error: `Zavi could not read the email back from ${label} to check it, so it did not send. Nothing was sent. Try again.` };
}

function goingOut(s: CampaignState | null): s is CampaignState {
  return !!s && (s.phase === "sending" || (s.phase === "sent" && s.emails_sent !== 0));
}

export function notConfirmedSentence(label: string, s: CampaignState | null): string {
  const where = !s
    ? "no longer readable"
    : s.phase === "draft"
      ? "still a draft"
      : s.phase === "sent" && s.emails_sent === 0
        ? `marked sent, but ${label} reports 0 emails sent`
        : `${(s.raw_status ?? "in an unknown state").replace(/[^A-Za-z ]/g, " ").trim().slice(0, 40) || "in an unknown state"}`;
  return `Zavi could not confirm whether this email went out. It is ${where}, and ${label} may be holding it if your account is suspended or under a compliance review, so check your account status in ${label}. Zavi will not send this card again. Check it in ${label}, or ask Zavi for a new one.`;
}

function endStop(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

export function sameAudience(c: CampaignState, audienceId: string): boolean {
  return c.audience_ids.length === 1 && c.audience_ids[0] === audienceId && !c.narrowed;
}

type SendIds = { sender_id: string; suppression_group_id: string };

export function envelopeMismatch(
  c: CampaignState,
  b: Pick<EmailSendBody, "tool" | "from_name" | "from_email" | "reply_to"> & { subject: string; preview_text: string | null },
  ids: SendIds | null = null,
): string | null {
  const e = c.envelope;
  if (!e) return "subject or sender";
  const same = (x: string | null, y: string | null) => (x ?? "").trim() === (y ?? "").trim();
  if (b.tool === "sendgrid") {
    if (!same(e.subject, b.subject)) return "subject";
    if (!ids || !same(e.sender_id ?? null, ids.sender_id)) return "sender";
    if (!same(e.suppression_group_id ?? null, ids.suppression_group_id)) return "unsubscribe group";
    return null;
  }
  const sameAddress = (x: string | null, y: string) => (x ?? "").trim().toLowerCase() === y.trim().toLowerCase();
  if (!same(e.subject, b.subject)) return "subject";
  if (!same(e.preview_text, b.preview_text)) return "preview text";
  if (!same(e.from_name, b.from_name)) return "sender name";
  if (b.tool === "klaviyo" && !sameAddress(e.from_email, b.from_email)) return "sender address";
  if (!sameAddress(e.reply_to ?? e.from_email, b.reply_to ?? b.from_email)) return "reply-to address";
  return null;
}
