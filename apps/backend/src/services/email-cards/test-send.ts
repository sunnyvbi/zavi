
import { randomBytes } from "node:crypto";
import { BULK_TRACKING_SETTINGS } from "@/services/comms/bulk-outbound/wire";
import { SENDING_ADDRESS_NOT_VERIFIED } from "@/services/comms/bulk-outbound/notices";
import { readAndCompare, readVerifyMode, reportContentVerdict } from "@/services/connectors/email-campaign/content-verify";
import { resolveSendgridAccount } from "@/services/connectors/email-campaign/sendgrid-account";
import { EMAIL_PROVIDERS, EmailToolError, toolStatus } from "@/services/connectors/email-campaign/providers";
import { NotConnected, connectedCall, type EmailSendBody } from "@/services/connectors/email-campaign/execute-send";
import { isAccountHeld, isKeyRejected, keyRejectedText, plainToolSentence, toolErrorText, toolRefusalText, toolSaid, vendorRefusal } from "@/services/connectors/email-campaign/provider-errors";
import { sendgridHttpCall, sendgridTestSender } from "@/services/connectors/email-campaign/providers-sendgrid";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { composioExecuteTool } from "@/services/connectors/composio/api";
import { UNSUBSCRIBE_HREF } from "@/services/email-templates/render";
import { bulkSendgridKey } from "@/services/comms/bulk-outbound/config";
import { checkBulkSender } from "@/services/comms/bulk-outbound/readiness";
import { unsubscribeUrl } from "@/services/tools/email/safety-net";
import { resolveBulkReplyTo } from "@/services/comms/bulk-outbound/reply-to";
import type { ChosenVersion } from "./variants";

export class TestSendError extends Error {
  constructor(
    readonly code: "email_unverified" | "not_connected" | "provider_refused" | "provider_unavailable" | "sender_not_ready" | "sending_address_not_verified",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export { SENDING_ADDRESS_NOT_VERIFIED };

export async function confirmedEmailOf(
  userId: string,
  read: (id: string) => Promise<{ email: string | null; confirmed: boolean } | null> = readAuthUser,
): Promise<string> {
  const u = await read(userId);
  if (u === null) {
    throw new TestSendError("provider_unavailable", "Zavi could not check your login email right now, so nothing was sent. Try the test again in a minute.");
  }
  if (!u.email || !u.confirmed) {
    throw new TestSendError("email_unverified", "Confirm your login email address first, then send the test again.");
  }
  return u.email;
}

async function readAuthUser(id: string): Promise<{ email: string | null; confirmed: boolean } | null> {
  return (await import("@/email/sendAuthEmail")).resolveLoginEmail(id);
}

const MAIL_SEND = "https://api.sendgrid.com/v3/mail/send";

type MailSend = {
  key: string;
  keyOwner: "zavi" | "workspace";
  to: string;
  from: { email: string; name?: string | null };
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  asmGroupId?: number;
  customArgs?: Record<string, string>;
  trackingSettings?: Record<string, unknown>;
};

export async function postMailSend(m: MailSend, fetchImpl: typeof fetch = fetch): Promise<void> {
  const payload = {
    personalizations: [{ to: [{ email: m.to }] }],
    from: m.from.name ? { email: m.from.email, name: m.from.name } : { email: m.from.email },
    ...(m.replyTo ? { reply_to: { email: m.replyTo } } : {}),
    subject: m.subject,
    content: [
      { type: "text/plain", value: m.text },
      { type: "text/html", value: m.html },
    ],
    ...(m.asmGroupId ? { asm: { group_id: m.asmGroupId } } : {}),
    ...(m.customArgs ? { custom_args: m.customArgs } : {}),
    ...(m.trackingSettings ? { tracking_settings: m.trackingSettings } : {}),
  };
  let status = 0;
  try {
    const r = await fetchImpl(MAIL_SEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${m.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    status = r.status;
  } catch {
    throw new TestSendError("provider_unavailable", "The test email could not be sent right now. Try again in a minute.");
  }
  if (status >= 500 || status === 0) {
    throw new TestSendError("provider_unavailable", "The email provider did not answer clearly. Try the test again in a minute.", status);
  }
  if (status < 200 || status >= 300) {
    throw new TestSendError("provider_refused", refusedSentence(m.keyOwner, status), status);
  }
}

function refusedSentence(keyOwner: MailSend["keyOwner"], status: number): string {
  if (keyOwner === "zavi") return "Zavi could not send the test email right now. Nothing was sent. Try again later.";
  if (status === 401 || status === 403) {
    return "SendGrid rejected your SendGrid API key. Reconnect SendGrid on the Connectors page, then send the test again. Nothing was sent.";
  }
  return "SendGrid did not accept the test email. Nothing was sent.";
}

const subjectOf = (v: ChosenVersion) => `[Test] ${v.subject}`.slice(0, 200);
const fill = (v: ChosenVersion, tag: string, htmlValue: string, textValue: string) => ({
  html: v.html.split(tag).join(htmlValue),
  text: v.text.split(tag).join(textValue),
});

export type TestSendDeps = {
  fetch: typeof fetch;
  resolveSendgrid: typeof resolveSendgridAccount;
  resolveAccount: typeof resolveOwnedComposioAccount;
  exec: typeof composioExecuteTool;
  checkSender: typeof checkBulkSender;
  bulkKey: () => string | null;
  recheckDomain: (tenantId: string) => Promise<unknown>;
  replyTo: (tenantId: string) => Promise<string | null>;
  reportLeftDraft: (tenantId: string, draft: LeftDraft) => Promise<void>;
  cleanupTimeoutMs: number;
  cleanupBackoffMs: number;
  draftDeleteDelayMs: number;
  draftMarker: () => string;
};

export type LeftDraft = { tool: "mailchimp"; campaign_id: string | null; name: string };

const LIVE: TestSendDeps = {
  fetch: (...a) => fetch(...a),
  resolveSendgrid: resolveSendgridAccount,
  resolveAccount: resolveOwnedComposioAccount,
  exec: composioExecuteTool,
  checkSender: checkBulkSender,
  bulkKey: bulkSendgridKey,
  recheckDomain: async (tenantId) => (await import("@/services/comms/bulk-outbound/sending-domain")).markSendingDomainUnverified(tenantId),
  replyTo: resolveBulkReplyTo,
  reportLeftDraft,
  cleanupTimeoutMs: 10_000,
  cleanupBackoffMs: 1_000,
  draftDeleteDelayMs: 5 * 60_000,
  draftMarker: () => randomBytes(4).toString("hex").toUpperCase(),
};

const DRAFT_DELETE_ATTEMPTS = 3;

export const testDraftName = (v: ChosenVersion, marker: string) => `ZAVI TEST ${marker}, DO NOT SEND: ${v.subject}`.slice(0, 100);

export function leftDraftSentence(d: LeftDraft): string {
  return `Zavi could not delete its test draft "${d.name}" from Mailchimp. Delete that draft in Mailchimp now so it is never sent to your list.`;
}

async function deleteDraft(call: ReturnType<typeof connectedCall>, campaignId: string, deps: TestSendDeps): Promise<boolean> {
  for (let i = 0; i < DRAFT_DELETE_ATTEMPTS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, deps.cleanupBackoffMs * i));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        call("MAILCHIMP_DELETE_CAMPAIGN", { campaign_id: campaignId }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deps.cleanupTimeoutMs);
        }),
      ]);
      if (r && (r.ok || (!r.outcome_unknown && r.status === 404))) return true;
    } catch {
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return false;
}

const LEFT_TEST_DRAFT = /^ZAVI TEST [0-9A-F]{8}, DO NOT SEND: /;

function campaignRows(data: unknown): Record<string, unknown>[] {
  let d = data;
  for (let i = 0; i < 4 && d && typeof d === "object" && !Array.isArray(d); i++) {
    const o = d as Record<string, unknown>;
    if (Array.isArray(o.campaigns)) return o.campaigns.filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c));
    d = o.data;
  }
  return [];
}

async function sweepLeftTestDrafts(call: ReturnType<typeof connectedCall>, deps: TestSendDeps): Promise<LeftDraft[]> {
  const r = await call("MAILCHIMP_LIST_CAMPAIGNS", { count: 200, sort_field: "create_time", sort_dir: "DESC" }).catch(() => null);
  if (!r?.ok) return [];
  const cutoff = Date.now() - deps.draftDeleteDelayMs;
  const left: LeftDraft[] = [];
  for (const c of campaignRows(r.data)) {
    const settings = c.settings && typeof c.settings === "object" ? (c.settings as Record<string, unknown>) : {};
    const id = typeof c.id === "string" ? c.id : null;
    const title = typeof settings.title === "string" ? settings.title : "";
    const created = typeof c.create_time === "string" ? Date.parse(c.create_time) : NaN;
    if (!id || c.status !== "save" || !LEFT_TEST_DRAFT.test(title) || !(created <= cutoff)) continue;
    if (!(await deleteDraft(call, id, deps))) left.push({ tool: "mailchimp", campaign_id: id, name: title });
  }
  return left;
}

const MAILCHIMP_TEST_UNCONFIRMED =
  "Mailchimp did not confirm the test email, so it may not arrive. Nothing was sent to your list. Check your inbox and spam folder in a few minutes, and check your account status in Mailchimp; if nothing arrives, send the test again.";

const MAILCHIMP_TEST_ACCOUNT_HELD =
  "Mailchimp did not send the test email: your Mailchimp account is on hold, suspended or under a compliance review. Nothing was sent to your list. Check your account status and any message from Mailchimp, then send the test again.";

function mailchimpTestFailure(r: { ok: boolean; status: number; data: unknown; error: unknown; outcome_unknown: boolean }): string | null {
  const refusal = r.ok ? vendorRefusal(r.data) : null;
  const raw = r.ok && !refusal ? (typeof r.error === "string" ? r.error.trim() : "") : refusal?.said || toolErrorText(r.error, r.status);
  if (r.ok && !refusal && !raw) return null;
  console.warn(`[email-test] Mailchimp test send not confirmed: ${toolErrorText(raw, refusal?.status ?? r.status)}`);
  if (r.outcome_unknown || (r.ok && !refusal)) return MAILCHIMP_TEST_UNCONFIRMED;
  const refusedAs = new EmailToolError(raw, false, refusal?.status ?? toolStatus(r), null, (refusal ?? vendorRefusal(r.data))?.said || null);
  if (isAccountHeld(toolSaid(refusedAs))) return MAILCHIMP_TEST_ACCOUNT_HELD;
  if (isKeyRejected(refusedAs)) return keyRejectedText("Mailchimp");
  if (!refusal) return "Mailchimp did not accept the test email. Nothing was sent to your list. Check the campaign and your account status in Mailchimp, then send the test again.";
  const said = plainToolSentence(refusal.said, "Mailchimp");
  return `Mailchimp did not send the test email.${said ? ` Mailchimp said: "${said}"` : ""} Nothing was sent to your list. Fix this in Mailchimp, then send the test again.`;
}

async function reportLeftDraft(tenantId: string, d: LeftDraft): Promise<void> {
  const msg = d.campaign_id
    ? `mailchimp test draft ${d.campaign_id} could not be deleted and is still on the audience`
    : `mailchimp test draft "${d.name}" may have been created with its id lost and could not be found to delete`;
  await import("@/services/logging/logEvent")
    .then(({ logEvent }) =>
      logEvent({ level: "error", source: "email-card-test-send", code: "email_test.draft_left", message: msg, tenant_id: tenantId, meta: { tool_name: d.tool } }),
    )
    .catch(() => undefined);
  await import("@/services/tenant-client")
    .then(({ asTenantId, tenantRpc }) =>
      tenantRpc(asTenantId(tenantId), "enqueue_ops_alert", {
        p_dedupe_key: `email_test_draft_left:${d.campaign_id ?? `${tenantId}:${d.name}`}`,
        p_source: "email-card-test-send",
        p_code: "email_test_draft_left",
        p_tenant_id: tenantId,
        p_msg: msg,
      }),
    )
    .catch(() => undefined);
}

export async function sendToolCardTest(
  tenantId: string,
  body: EmailSendBody,
  v: ChosenVersion,
  to: string,
  depsIn: Partial<TestSendDeps> = {},
): Promise<{ via: string; warning?: string }> {
  const deps = { ...LIVE, ...depsIn };
  if (body.tool === "sendgrid") {
    const sg = await deps.resolveSendgrid(tenantId);
    if (!sg) throw new TestSendError("not_connected", "SendGrid is not connected. Reconnect SendGrid, then send the test again.");
    const parts = fill(v, UNSUBSCRIBE_HREF.sendgrid, "<%asm_group_unsubscribe_raw_url%>", "<%asm_group_unsubscribe_raw_url%>");
    await postMailSend(
      {
        key: sg.api_key,
        keyOwner: "workspace",
        to,
        from: { email: body.from_email, name: body.from_name },
        replyTo: body.reply_to,
        subject: subjectOf(v),
        ...parts,
        asmGroupId: Number(body.sendgrid_suppression_group_id),
      },
      deps.fetch,
    );
    return { via: "SendGrid" };
  }
  if (body.tool === "mailchimp") {
    let createReached = false;
    const call = connectedCall(tenantId, body, {
      ...deps,
      exec: (...a: Parameters<typeof composioExecuteTool>) => {
        if (a[0].tool_slug === "MAILCHIMP_ADD_CAMPAIGN") createReached = true;
        return deps.exec(...a);
      },
    });
    const p = EMAIL_PROVIDERS.mailchimp;
    const name = testDraftName(v, deps.draftMarker());
    const sweptLeft = await sweepLeftTestDrafts(call, deps).catch((): LeftDraft[] => []);
    let campaignId: string | null = null;
    let failure: TestSendError | null = null;
    let createLost = false;
    try {
      campaignId = await p.createCampaign(call, {
        title: name,
        audience_id: body.audience_id,
        subject: v.subject.slice(0, 200),
        preview_text: v.preview_text,
        from_name: body.from_name,
        from_email: body.from_email,
        reply_to: body.reply_to,
      });
      await p.setContent(call, campaignId, { title: name, html: v.html, text: v.text });
      const verdict = await readAndCompare("mailchimp", call, campaignId, { html: v.html, text: v.text });
      if (verdict.status !== "match") {
        const mode = await readVerifyMode("mailchimp");
        await reportContentVerdict(tenantId, "mailchimp", "test_send", verdict, mode);
        if (mode === "enforce") {
          throw new TestSendError("provider_refused", "Mailchimp does not hold exactly this email, so Zavi did not send the test. Nothing was sent. Try again.");
        }
      }
      const r = await call("MAILCHIMP_SEND_TEST_EMAIL", { campaign_id: campaignId, test_emails: [to], send_type: "html" });
      const failed = mailchimpTestFailure(r);
      if (failed) throw new TestSendError("provider_refused", failed);
    } catch (e) {
      if (!campaignId) createLost = createReached && !(e instanceof EmailToolError && !e.outcome_unknown);
      if (e instanceof TestSendError) failure = e;
      else if (e instanceof EmailToolError) {
        failure = new TestSendError(
          "provider_refused",
          isKeyRejected(e)
            ? keyRejectedText("Mailchimp")
            : e.outcome_unknown
              ? "Mailchimp did not answer clearly, so the test was not sent. Nothing was sent. Try the test again in a minute."
              : isAccountHeld(toolSaid(e))
                ? MAILCHIMP_TEST_ACCOUNT_HELD
                : toolRefusalText("Mailchimp", e.message),
        );
      }
      else failure = new TestSendError("not_connected", "Mailchimp is not connected. Nothing was sent.");
    }
    let warning: string | undefined;
    const leave = async (campaign_id: string | null, draftName: string = name) => {
      const left: LeftDraft = { tool: "mailchimp", campaign_id, name: draftName };
      await deps.reportLeftDraft(tenantId, left).catch(() => undefined);
      warning = warning ? `${warning} ${leftDraftSentence(left)}` : leftDraftSentence(left);
    };
    for (const d of sweptLeft) await leave(d.campaign_id, d.name);
    if (campaignId && !failure) {
      const id = campaignId;
      setTimeout(() => {
        void deleteDraft(call, id, deps)
          .then((gone) => (gone ? undefined : deps.reportLeftDraft(tenantId, { tool: "mailchimp", campaign_id: id, name })))
          .catch(() => undefined);
      }, deps.draftDeleteDelayMs).unref();
    } else if (campaignId) {
      if (!(await deleteDraft(call, campaignId, deps))) await leave(campaignId);
    } else if (createLost) {
      const found = await p.findCampaignsByTitle(call, name).catch(() => null);
      const drafts = (found ?? []).filter((c) => c.title === name && c.phase === "draft");
      if (drafts.length === 0) await leave(null);
      for (const d of drafts) {
        if (!(await deleteDraft(call, d.id, deps))) await leave(d.id);
      }
    }
    if (failure) throw warning ? new TestSendError(failure.code, `${failure.message} ${warning}`, failure.status) : failure;
    return warning ? { via: "Mailchimp", warning } : { via: "Mailchimp" };
  }
  await proveKlaviyo(tenantId, body, deps);
  const sender = await deps.checkSender(tenantId);
  const key = sender.ok ? deps.bulkKey() : null;
  if (!sender.ok || !key) {
    const own = await klaviyoTestThroughOwnSendgrid(tenantId, body, v, to, deps);
    if (!own) {
      throw new TestSendError(
        "sender_not_ready",
        sender.ok
          ? "Zavi's sender for test emails is not set up, so the Klaviyo test was not sent. Connect SendGrid to test through your own account. Nothing was sent."
          : sender.code === "bulk_check_failed"
            ? "Zavi could not check your sending address right now, so the Klaviyo test was not sent. Nothing was sent. Try the test again in a minute."
            : `Klaviyo has no test send, so Zavi sends Klaviyo tests from your verified sending address in Email campaigns settings, or through your own SendGrid once it is connected with a verified sender. ${sender.sentence} Nothing was sent.`,
      );
    }
    await proveKlaviyoAfterTest(tenantId, body, deps);
    return { via: KLAVIYO_TEST_VIA_OWN_SENDGRID };
  }
  const parts = fill(v, UNSUBSCRIBE_HREF.klaviyo, "#", "(unsubscribe link)");
  try {
    await postMailSend(
      {
        key,
        keyOwner: "zavi",
        to,
        from: { email: sender.sender.from_address, name: sender.sender.from_name },
        replyTo: body.reply_to,
        subject: subjectOf(v),
        text: `Klaviyo has no test API, so Zavi sent this copy of your email itself.\n\n${parts.text}`,
        html: withPreviewBanner(parts.html),
        customArgs: { tenant_id: tenantId, email_card_test: "1" },
        trackingSettings: BULK_TRACKING_SETTINGS,
      },
      deps.fetch,
    );
  } catch (e) {
    if (e instanceof TestSendError && e.code === "provider_refused" && e.status === 403) {
      await deps.recheckDomain(tenantId).catch(() => undefined);
      throw new TestSendError("sending_address_not_verified", SENDING_ADDRESS_NOT_VERIFIED, 403);
    }
    throw e;
  }
  await proveKlaviyoAfterTest(tenantId, body, deps);
  return { via: "Zavi (Klaviyo has no test API)" };
}

export const KLAVIYO_TEST_VIA_OWN_SENDGRID = "your SendGrid (Klaviyo has no test API)";

async function klaviyoTestThroughOwnSendgrid(tenantId: string, body: EmailSendBody, v: ChosenVersion, to: string, deps: TestSendDeps): Promise<boolean> {
  const sg = await deps.resolveSendgrid(tenantId).catch(() => null);
  if (!sg) return false;
  let from: { email: string; name: string | null } | null;
  try {
    from = await sendgridTestSender(sendgridHttpCall(sg.api_key, deps.fetch), body.from_email);
  } catch (e) {
    if (isKeyRejected(e)) throw new TestSendError("not_connected", keyRejectedText("SendGrid"));
    throw new TestSendError("provider_unavailable", "Zavi could not read your senders from SendGrid, so the Klaviyo test was not sent. Nothing was sent. Try the test again in a minute.");
  }
  if (!from) return false;
  const parts = fill(v, UNSUBSCRIBE_HREF.klaviyo, "#", "(unsubscribe link)");
  await postMailSend(
    {
      key: sg.api_key,
      keyOwner: "workspace",
      to,
      from,
      replyTo: body.reply_to,
      subject: subjectOf(v),
      text: `Klaviyo has no test API, so Zavi sent this copy of your email through your SendGrid.\n\n${parts.text}`,
      html: withPreviewBanner(parts.html, "sent through your own SendGrid"),
    },
    deps.fetch,
  );
  return true;
}

async function proveKlaviyoAfterTest(tenantId: string, body: EmailSendBody, deps: TestSendDeps): Promise<void> {
  try {
    await proveKlaviyo(tenantId, body, deps);
  } catch (e) {
    if (e instanceof TestSendError && e.code === "not_connected") {
      throw new TestSendError("not_connected", `The test email went out, but Zavi cannot count it. ${e.message}`);
    }
  }
}

const klaviyoPreviewBanner = (sentBy: string) =>
  `<div style="padding:10px 16px;background-color:#fff7ed;color:#9a3412;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:13px;line-height:1.4;text-align:center;">Klaviyo has no test API, so this is a Zavi preview copy of your email, ${sentBy}.</div>`;

export function withPreviewBanner(html: string, sentBy = "sent by Zavi itself"): string {
  const banner = klaviyoPreviewBanner(sentBy);
  const m = html.match(/<body[^>]*>/i);
  if (!m || m.index === undefined) return `${banner}${html}`;
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}${banner}${html.slice(at)}`;
}

const KLAVIYO_TEST_ACCOUNT_HELD =
  "Klaviyo did not allow the test email: your Klaviyo account is on hold, suspended or under a compliance review. Nothing was sent. Check your account status and any message from Klaviyo, then send the test again.";

async function proveKlaviyo(tenantId: string, body: EmailSendBody, deps: TestSendDeps): Promise<void> {
  const call = connectedCall(tenantId, body, deps);
  let audience: unknown;
  try {
    audience = await EMAIL_PROVIDERS.klaviyo.getAudience(call, body.audience_id);
  } catch (e) {
    if (e instanceof NotConnected) {
      throw new TestSendError("not_connected", "Klaviyo is not connected. Reconnect Klaviyo, then send the test again.");
    }
    if (isKeyRejected(e)) throw new TestSendError("not_connected", keyRejectedText("Klaviyo"));
    if (e instanceof EmailToolError && isAccountHeld(toolSaid(e))) throw new TestSendError("provider_refused", KLAVIYO_TEST_ACCOUNT_HELD);
    throw new TestSendError("provider_unavailable", "Zavi could not check Klaviyo right now, so the test was not sent. Nothing was sent. Try the test again in a minute.");
  }
  if (!audience) throw new TestSendError("not_connected", "The list on this email is no longer in the connected Klaviyo account. Ask Zavi for a new draft.");
}

export async function sendBulkTestEmail(
  tenantId: string,
  body: { from_address: string; reply_to?: string | null },
  v: ChosenVersion,
  to: string,
  depsIn: Partial<TestSendDeps> = {},
): Promise<{ via: string }> {
  const deps = { ...LIVE, ...depsIn };
  const sender = await deps.checkSender(tenantId);
  if (!sender.ok) throw new TestSendError("sender_not_ready", sender.sentence);
  if (sender.sender.from_address.toLowerCase() !== body.from_address.toLowerCase()) {
    throw new TestSendError("sender_not_ready", "Your sending address changed after this email was drafted. Ask Zavi to draft it again.");
  }
  let replyTo: string | null;
  try {
    replyTo = await deps.replyTo(tenantId);
  } catch {
    throw new TestSendError("sender_not_ready", "Zavi could not check where replies go. Try the test again in a minute.");
  }
  if ((replyTo ?? "").toLowerCase() !== (body.reply_to ?? "").toLowerCase()) {
    throw new TestSendError("sender_not_ready", "Where replies go changed after this email was drafted. Ask Zavi to draft it again.");
  }
  const key = deps.bulkKey();
  if (!key) throw new TestSendError("provider_refused", "Zavi cannot send test emails right now. Try again later.");
  const url = unsubscribeUrl("test-send");
  const parts = fill(v, UNSUBSCRIBE_HREF.zavi_list, url.replace(/&/g, "&amp;"), url);
  try {
    await postMailSend(
      {
        key,
        keyOwner: "zavi",
        to,
        from: { email: sender.sender.from_address, name: sender.sender.from_name },
        replyTo,
        subject: subjectOf(v),
        ...parts,
        customArgs: { tenant_id: tenantId, email_card_test: "1" },
        trackingSettings: BULK_TRACKING_SETTINGS,
      },
      deps.fetch,
    );
  } catch (e) {
    if (e instanceof TestSendError && e.code === "provider_refused" && e.status === 403) {
      await deps.recheckDomain(tenantId).catch(() => undefined);
      throw new TestSendError("sending_address_not_verified", SENDING_ADDRESS_NOT_VERIFIED, 403);
    }
    throw e;
  }
  return { via: "your sending address" };
}
