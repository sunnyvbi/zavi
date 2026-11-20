
import sgMail, { MailService } from "@sendgrid/mail";
import { serviceClient } from "@/services/supabase";
import { renderOtpEmail } from "./templates/otp";
import { renderResetPasswordEmail } from "./templates/reset-password";
import { renderEmailChangeEmail } from "./templates/email-change";
import { renderLaunchVideoClaimEmail } from "./templates/launch-video-claim";
import {
  renderStartCardConfirmEmail,
  renderStartCardReadyEmail,
  renderStartCardRemoveEmail,
  renderSeedNoticeEmail,
  type StartCardReadyCard,
} from "./templates/start-card";
import { resolveAuthRedirectBase } from "../services/auth/redirect-base";
import { INVITER_FALLBACK, renderWorkspaceInviteEmail } from "./templates/workspace-invite";
import { renderAppInviteEmail } from "./templates/app-invite";
import { renderWelcomeEmail } from "./templates/welcome";
import { renderOnboardingSequenceEmail, type ResultsContent } from "./templates/onboarding-sequence";
import { EmailNotSentError } from "../services/onboarding-emails/send-errors";
import type { SequenceStep } from "../services/onboarding-emails/steps";
import { renderWelcomeBuildEmail } from "./templates/welcome-build";
import { renderBuildNotStartedEmail } from "./templates/build-not-started";
import { renderPreviewReadyEmail } from "./templates/preview-ready";
import { renderBuildLiveEmail } from "./templates/build-live";
import { renderSiteAdminLoginEmail } from "./templates/site-admin-login";
import { renderUpgradeActionsReadyEmail } from "./templates/upgrade-actions-ready";
import { renderPlanReadyEmail } from "./templates/plan-ready";
import { renderMorningDigestEmail } from "./templates/morning-digest";
import type { MorningBriefResponse } from "../services/workspace/morning-brief-assembler";
import { assertRenderedClean } from "../services/workspace/morning-brief-sanitize";
import { logEvent } from "../services/logging/logEvent";
import { recordDigestSendAudit } from "../services/workspace/digest-send-audit";
import { systemSender } from "./system-identity";
import { resolveAgentSendingIdentity } from "./sending-identity";
import { sendAgentOwnedEmail } from "./sendAgentOwnedEmail";
import { emailSubjectLine } from "./theme";

function systemKey(): string {
  const k = process.env.SYSTEM_SENDGRID_API_KEY;
  if (!k) {
    throw new Error(
      "SYSTEM_SENDGRID_API_KEY env var is missing. Set in apps/backend/.env locally + " +
        "AWS Secrets Manager (praxis-envprod-1) for prod. Required for auth emails.",
    );
  }
  return k;
}

function systemFrom(): { email: string; name: string } {
  return systemSender();
}

type ActionLinkType = "magiclink" | "recovery";

function parseUrl(s: string | null | undefined): URL | null {
  if (!s) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function redirectParamOf(actionLink: string): string | null {
  return parseUrl(actionLink)?.searchParams.get("redirect_to") ?? null;
}

function redirectPreserved(want: URL, gotRaw: string | null): boolean {
  const got = parseUrl(gotRaw);
  if (!got) return false;
  return (
    got.pathname === want.pathname &&
    got.searchParams.get("next") === want.searchParams.get("next")
  );
}

function selfMintableOrigin(want: URL): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const host = want.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

export async function mintActionLink(
  svc: ReturnType<typeof serviceClient>,
  type: ActionLinkType,
  email: string,
  redirectTo: string,
  direct?: (want: URL, hashedToken: string) => string | null,
): Promise<string> {
  const mint = async (rt: string): Promise<{ link: string; hashedToken: string | null }> => {
    const res = await svc.auth.admin.generateLink({
      type,
      email,
      options: { redirectTo: rt },
    });
    if (res.error) {
      throw new Error(`auth.admin.generateLink(${type}) failed: ${res.error.message}`);
    }
    const link = res.data?.properties?.action_link;
    if (!link) {
      throw new Error(`auth.admin.generateLink(${type}) returned no action_link`);
    }
    return { link, hashedToken: res.data?.properties?.hashed_token ?? null };
  };

  const want = parseUrl(redirectTo);
  const first = await mint(redirectTo);
  if (!want) return first.link;
  const own = direct && first.hashedToken ? direct(want, first.hashedToken) : null;
  if (own) return own;

  const got = redirectParamOf(first.link);
  if (redirectPreserved(want, got)) return first.link;

  if (first.hashedToken && selfMintableOrigin(want)) {
    const own = new URL(want.toString());
    own.searchParams.set("token_hash", first.hashedToken);
    own.searchParams.set("type", type);
    return own.toString();
  }

  const fallbackOrigin = parseUrl(got)?.origin;
  if (!fallbackOrigin || fallbackOrigin === want.origin) return first.link;
  const healed = `${fallbackOrigin}${want.pathname}${want.search}`;
  return (await mint(healed)).link;
}

export async function resolveTenantOwnerEmail(
  tenant_id: string,
): Promise<string | null> {
  const u = await resolveTenantOwnerUser(tenant_id);
  return u?.email ?? null;
}

export async function resolveTenantOwnerEmailOrThrow(
  tenant_id: string,
): Promise<string | null> {
  const u = await resolveTenantOwnerUser(tenant_id, true);
  return u?.email ?? null;
}

export async function resolveMemberEmail(user_id: string): Promise<string | null> {
  try {
    const { data, error } = await serviceClient().auth.admin.getUserById(user_id);
    return error ? null : (data?.user?.email ?? null);
  } catch {
    return null;
  }
}

export async function resolveLoginEmail(user_id: string): Promise<{ email: string | null; confirmed: boolean } | null> {
  try {
    const { data, error } = await serviceClient().auth.admin.getUserById(user_id);
    if (error || !data?.user) return null;
    return { email: data.user.email ?? null, confirmed: !!data.user.email_confirmed_at };
  } catch {
    return null;
  }
}

export async function resolveTenantOwnerName(
  tenant_id: string,
): Promise<string | null> {
  const u = await resolveTenantOwnerUser(tenant_id);
  return pickDisplayName(u?.user_metadata);
}

export function pickDisplayName(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as { full_name?: unknown; name?: unknown };
  for (const v of [meta.full_name, meta.name]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function resolveTenantOwnerUser(
  tenant_id: string,
  strict = false,
): Promise<{ email?: string | null; user_metadata?: unknown } | null> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("tenant_users")
    .select("user_id, created_at")
    .eq("tenant_id", tenant_id)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ user_id: string; created_at: string }>();
  if (error && strict) throw new Error("owner lookup failed");
  if (error || !data?.user_id) return null;

  const { data: u, error: uErr } = await svc.auth.admin.getUserById(data.user_id);
  if (uErr && strict) throw new Error("owner lookup failed");
  if (uErr) return null;
  return u?.user ?? null;
}

export async function sgSend(
  to: string,
  subject: string,
  html: string,
  text: string,
  from?: { email: string; name?: string | null },
  opts?: { customArgs?: Record<string, string>; headers?: Record<string, string>; noTracking?: boolean },
): Promise<void> {
  sgMail.setApiKey(systemKey());
  const sender = from?.email
    ? { email: from.email, name: from.name ?? from.email }
    : systemFrom();
  await sgMail.send({
    to,
    from: sender,
    subject: emailSubjectLine(subject),
    text,
    html,
    ...(opts?.customArgs ? { customArgs: opts.customArgs } : {}),
    ...(opts?.headers ? { headers: opts.headers } : {}),
    ...(opts?.noTracking
      ? { trackingSettings: { clickTracking: { enable: false, enableText: false }, openTracking: { enable: false } } }
      : {}),
  });
}

export async function sendOtpEmail(email: string, onCreated?: (userId: string) => Promise<void>): Promise<{ sent: true }> {
  const svc = serviceClient();

  const created = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  const err = created.error;
  const isDuplicateEmail =
    !!err &&
    (err.code === "email_exists" ||
      (err.code == null &&
        err.status === 422 &&
        /already\b.*\b(registered|exists)/i.test(err.message)));
  if (err && !isDuplicateEmail) {
    throw new Error(`auth.admin.createUser failed: ${err.message}`);
  }

  if (!err && created.data.user && onCreated) {
    void onCreated(created.data.user.id).catch(() => console.warn("[signup-location] capture unavailable"));
  }

  const link = await svc.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (link.error) {
    throw new Error(`auth.admin.generateLink failed: ${link.error.message}`);
  }
  const code = link.data?.properties?.email_otp;
  if (!code) {
    throw new Error("auth.admin.generateLink returned no email_otp");
  }

  const rendered = renderOtpEmail({ code });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });

  return { sent: true };
}

export async function sendSignupCodeEmail(email: string, code: string): Promise<void> {
  const rendered = renderOtpEmail({ code, purpose: "signup" });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
}

export async function sendEmailChangeLinkEmail(email: string, actionUrl: string, side: "new" | "current", newEmail: string): Promise<void> {
  const rendered = renderEmailChangeEmail({ actionUrl, side, newEmail });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
}

export async function sendRecoveryLinkEmail(email: string, actionUrl: string): Promise<void> {
  const rendered = renderResetPasswordEmail({ actionUrl });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
}

export async function sendLaunchVideoClaimEmail(
  email: string,
  jobId: string,
): Promise<{ sent: true }> {
  const svc = serviceClient();

  const created = await svc.auth.admin.createUser({ email, email_confirm: true });
  const err = created.error;
  const isDuplicateEmail =
    !!err &&
    (err.code === "email_exists" ||
      (err.code == null && err.status === 422 && /already\b.*\b(registered|exists)/i.test(err.message)));
  if (err && !isDuplicateEmail) {
    throw new Error(`auth.admin.createUser failed: ${err.message}`);
  }

  const base =
    resolveAuthRedirectBase() ??
    process.env.PRAXIS_WEB_ORIGIN ??
    "https://www.zaviagent.com";
  const next = `/launch-video/claim?job=${encodeURIComponent(jobId)}`;
  const redirectTo = `${base}/auth/callback?next=${encodeURIComponent(next)}`;
  const actionUrl = await mintActionLink(svc, "magiclink", email, redirectTo);

  const rendered = renderLaunchVideoClaimEmail({ actionUrl });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });

  return { sent: true };
}

export function recoveryAppLink(want: URL, hashedToken: string): string | null {
  const base = resolveAuthRedirectBase();
  if (!base) return null;
  const link = new URL("/auth/reset", base);
  link.searchParams.set("next", want.searchParams.get("next") ?? "/reset-password");
  link.searchParams.set("token_hash", hashedToken);
  link.searchParams.set("type", "recovery");
  link.searchParams.set("deeplink", "reset");
  return link.toString();
}

export async function sendResetPasswordEmail(
  email: string,
  redirectTo: string,
): Promise<{ sent: true }> {
  const svc = serviceClient();
  let actionUrl: string;
  try {
    actionUrl = await mintActionLink(svc, "recovery", email, redirectTo, recoveryAppLink);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/user.*not.*found|user.*does.*not.*exist/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.warn("[auth-email] reset requested for unknown email");
      return { sent: true };
    }
    throw e;
  }

  const rendered = renderResetPasswordEmail({ actionUrl });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });

  return { sent: true };
}

export async function sendWorkspaceInviteEmail(args: {
  to: string;
  acceptUrl: string;
  inviterLabel: string;
  inviterEmail?: string | null;
  tenantName: string | null;
}): Promise<{ sent: true }> {
  const rendered = renderWorkspaceInviteEmail({
    actionUrl: args.acceptUrl,
    inviterLabel: args.inviterLabel,
    inviterEmail: args.inviterEmail ?? null,
    tenantName: args.tenantName,
  });
  await sgSend(args.to, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
  return { sent: true };
}

export async function resolveInviteSender(
  tenant_id: string,
  inviter_user_id: string | null,
): Promise<{ tenantName: string | null; inviterLabel: string; inviterEmail: string | null }> {
  let tenantName: string | null = null;
  let name: string | null = null;
  let email: string | null = null;
  try {
    const { data, error } = await serviceClient()
      .from("tenants")
      .select("display_name")
      .eq("id", tenant_id)
      .maybeSingle<{ display_name: string | null }>();
    if (error) throw new Error(error.message);
    const n = typeof data?.display_name === "string" ? data.display_name.trim() : "";
    tenantName = n || null;
  } catch (e) {
    console.warn(`[invite-email] workspace name read failed, sending without it: ${(e as Error).message}`);
  }
  if (inviter_user_id) {
    try {
      const { data, error } = await serviceClient().auth.admin.getUserById(inviter_user_id);
      if (error) throw new Error(error.message);
      name = pickDisplayName(data?.user?.user_metadata);
      email = data?.user?.email?.trim() || null;
    } catch (e) {
      console.warn(`[invite-email] inviter read failed, sending without a name: ${(e as Error).message}`);
    }
  }
  return {
    tenantName,
    inviterLabel: name ?? email ?? INVITER_FALLBACK,
    inviterEmail: name ? email : null,
  };
}

export async function sendAppInviteEmail(
  tenantId: string,
  email: string,
  args: { inviteUrl: string; siteHost: string; role: "user" | "admin"; expiresAt: string },
): Promise<{ sent: true }> {
  const rendered = renderAppInviteEmail(args);
  const identity = await resolveAgentSendingIdentity(tenantId);
  await sgSend(email, rendered.subject, rendered.html, rendered.text, { email: identity.from, name: identity.name }, { noTracking: true });
  return { sent: true };
}

export async function sendWelcomeEmail(args: {
  user_id: string;
  displayName: string;
  workspaceUrl: string;
}): Promise<{ sent: boolean }> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.getUserById(args.user_id);
  if (error) {
    throw new Error(`auth.admin.getUserById failed: ${error.message}`);
  }
  const email = data?.user?.email;
  if (!email) {
    return { sent: false };
  }

  const rendered = renderWelcomeEmail({
    displayName: args.displayName,
    workspaceUrl: args.workspaceUrl,
  });
  await sgSend(email, rendered.subject, rendered.html, rendered.text);

  return { sent: true };
}

export type SequenceRecipient = {
  email: string;
  verified: boolean;
  name: string | null;
};

export async function resolveSequenceRecipient(user_id: string): Promise<SequenceRecipient | null> {
  const { data, error } = await serviceClient().auth.admin.getUserById(user_id);
  if (error) {
    throw new Error(`auth.admin.getUserById failed: ${error.message}`);
  }
  const user = data?.user;
  if (!user?.email) return null;
  return {
    email: user.email,
    verified: Boolean(user.email_confirmed_at),
    name: pickDisplayName(user.user_metadata),
  };
}

export async function sendOnboardingSequenceEmail(args: {
  to: string;
  step: SequenceStep;
  firstName: string;
  workspaceUrl: string;
  imageBaseUrl: string;
  unsubscribeUrl: string;
  results?: ResultsContent;
}): Promise<void> {
  let rendered: ReturnType<typeof renderOnboardingSequenceEmail>;
  try {
    rendered = renderOnboardingSequenceEmail({
      step: args.step,
      firstName: args.firstName,
      workspaceUrl: args.workspaceUrl,
      imageBaseUrl: args.imageBaseUrl,
      unsubscribeUrl: args.unsubscribeUrl,
      results: args.results,
    });
  } catch (e) {
    throw new EmailNotSentError(`render failed: ${(e as Error).message}`);
  }
  await sgSend(args.to, rendered.subject, rendered.html, rendered.text, undefined, {
    headers: {
      "List-Unsubscribe": `<${args.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

export async function sendWelcomeBuildEmail(args: {
  user_id: string;
  displayName: string;
  buildUrl: string;
}): Promise<{ sent: boolean }> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.getUserById(args.user_id);
  if (error) {
    throw new Error(`auth.admin.getUserById failed: ${error.message}`);
  }
  const email = data?.user?.email;
  if (!email) {
    return { sent: false };
  }

  const rendered = renderWelcomeBuildEmail({
    displayName: args.displayName,
    buildUrl: args.buildUrl,
  });
  await sgSend(email, rendered.subject, rendered.html, rendered.text);

  return { sent: true };
}

export async function sendBuildNotStartedEmail(args: {
  user_id: string;
  displayName: string;
  workspaceUrl: string;
  reason: string;
}): Promise<{ sent: boolean }> {
  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.getUserById(args.user_id);
  if (error) {
    throw new Error(`auth.admin.getUserById failed: ${error.message}`);
  }
  const email = data?.user?.email;
  if (!email) {
    return { sent: false };
  }

  const rendered = renderBuildNotStartedEmail({
    displayName: args.displayName,
    workspaceUrl: args.workspaceUrl,
    reason: args.reason,
  });
  await sgSend(email, rendered.subject, rendered.html, rendered.text);

  return { sent: true };
}

export async function sendBuildLiveEmail(args: {
  tenant_id: string;
  siteName: string;
  liveUrl: string;
  workspaceUrl: string;
  admin?: { adminUrl: string; setupUrl: string } | null;
  ownerLogin?: { email: string; mint: () => Promise<string> } | null;
  ownerAdminUrl?: string | null;
}): Promise<{ sent: boolean; owner_login?: boolean }> {
  const email = await resolveTenantOwnerEmail(args.tenant_id);
  if (!email) return { sent: false };
  let ownerLoginUrl: string | null = null;
  const isOwner = !!args.ownerLogin && args.ownerLogin.email.trim().toLowerCase() === email.trim().toLowerCase();
  if (isOwner && args.ownerLogin) {
    try {
      ownerLoginUrl = await args.ownerLogin.mint();
    } catch (e) {
      console.warn(`[build-live-email] owner login link not minted: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      ownerLoginUrl = null;
    }
  }
  const rendered = renderBuildLiveEmail({
    siteName: args.siteName,
    liveUrl: args.liveUrl,
    workspaceUrl: args.workspaceUrl,
    ...(args.admin ? { admin: args.admin } : {}),
    ...(ownerLoginUrl ? { ownerLoginUrl } : {}),
    ...(isOwner && args.ownerAdminUrl ? { ownerAdminUrl: args.ownerAdminUrl } : {}),
  });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
  return { sent: true, owner_login: ownerLoginUrl !== null };
}

export async function sendSiteAdminLoginEmail(args: {
  tenant_id: string;
  siteName: string;
  adminUrl: string;
  workspaceUrl: string;
  ownerLogin: { email: string; mint: () => Promise<string> };
}): Promise<{ sent: boolean; reason?: "no_recipient" | "not_owner" }> {
  const email = await resolveTenantOwnerEmail(args.tenant_id);
  if (!email) return { sent: false, reason: "no_recipient" };
  if (args.ownerLogin.email.trim().toLowerCase() !== email.trim().toLowerCase()) return { sent: false, reason: "not_owner" };
  const loginUrl = await args.ownerLogin.mint();
  const rendered = renderSiteAdminLoginEmail({
    siteName: args.siteName,
    adminUrl: args.adminUrl,
    loginUrl,
    workspaceUrl: args.workspaceUrl,
  });
  await sgSend(email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
  return { sent: true };
}

export async function sendPreviewReadyEmail(args: {
  tenant_id: string;
  displayName: string;
  total: number;
  channelNames: readonly string[];
  planName: string;
  planUsd: number;
  channelsUrl: string;
  realCards?: number;
}): Promise<{ sent: boolean }> {
  const email = await resolveTenantOwnerEmail(args.tenant_id);
  if (!email) return { sent: false };
  const rendered = renderPreviewReadyEmail(args);
  await sgSend(email, rendered.subject, rendered.html, rendered.text);
  return { sent: true };
}

export async function sendPlanReadyEmail(args: {
  to: string;
  firstName: string;
  company: string;
  planUrl: string;
  imageBaseUrl: string;
  unsubscribeUrl: string;
}): Promise<void> {
  let rendered: ReturnType<typeof renderPlanReadyEmail>;
  try {
    rendered = renderPlanReadyEmail(args);
  } catch (e) {
    throw new EmailNotSentError(`render failed: ${(e as Error).message}`);
  }
  await sgSend(
    args.to,
    rendered.subject,
    rendered.html,
    rendered.text,
    undefined,
    args.unsubscribeUrl
      ? {
          headers: {
            "List-Unsubscribe": `<${args.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : undefined,
  );
}

export async function sendUpgradeActionsReadyEmail(args: {
  tenant_id: string;
  total: number;
  channelsUrl: string;
}): Promise<{ sent: boolean }> {
  const email = await resolveTenantOwnerEmail(args.tenant_id);
  if (!email) return { sent: false };
  const rendered = renderUpgradeActionsReadyEmail(args);
  await sgSend(email, rendered.subject, rendered.html, rendered.text);
  return { sent: true };
}

export async function sendMorningDigestEmail(args: {
  owner_user_id: string;
  tenant_id: string;
  brief: MorningBriefResponse;
  workspaceUrl: string;
  approvalsUrl: string;
  displayName?: string;
  yesterdayLines?: string[];
  trendLines?: string[];
}): Promise<{ sent: boolean; reason?: string; violations?: string[] }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    return { sent: false, reason: "no_system_key" };
  }

  const svc = serviceClient();
  const { data, error } = await svc.auth.admin.getUserById(args.owner_user_id);
  if (error) {
    throw new Error(`auth.admin.getUserById failed: ${error.message}`);
  }
  const email = data?.user?.email;
  if (!email) {
    return { sent: false, reason: "no_email" };
  }

  const rendered = renderMorningDigestEmail(args.brief, {
    workspaceUrl: args.workspaceUrl,
    approvalsUrl: args.approvalsUrl,
    displayName: args.displayName,
    yesterdayLines: args.yesterdayLines,
    trendLines: args.trendLines,
  });

  const violations = assertRenderedClean(rendered);
  if (violations.length > 0) {
    await logEvent({
      level: "warn",
      source: "morning-digest-email",
      code: "blocked_content",
      message: `morning digest send blocked: ${violations.join(",")}`,
      tenant_id: args.tenant_id,
    });
    await recordDigestSendAudit({
      tenant_id: args.tenant_id,
      source_worker: "autopilot-digest-push",
      subject: rendered.subject,
      verdict: "blocked_content",
      violations,
    });
    return { sent: false, reason: "blocked_content", violations };
  }

  await sendAgentOwnedEmail({
    tenant_id: args.tenant_id,
    agent_slug: "cgo",
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fallbackFrom: systemFrom(),
  });

  const preSendViolations = Array.isArray(args.brief._sanitize_violations)
    ? args.brief._sanitize_violations
    : [];
  await recordDigestSendAudit({
    tenant_id: args.tenant_id,
    source_worker: "autopilot-digest-push",
    subject: rendered.subject,
    verdict: "sent",
    violations: preSendViolations,
  });

  return { sent: true };
}

export async function sendStartCardConfirmEmail(args: {
  email: string;
  domain: string;
  confirmUrl: string;
}): Promise<{ sent: boolean; reason?: "no_system_key" }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    console.error("[start-card] SYSTEM_SENDGRID_API_KEY is unset — confirm email NOT sent");
    return { sent: false, reason: "no_system_key" };
  }
  const rendered = renderStartCardConfirmEmail({ domain: args.domain, confirmUrl: args.confirmUrl });
  await sgSend(args.email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
  return { sent: true };
}

export async function sendStartCardRemoveEmail(args: {
  email: string;
  domain: string;
  removeUrl: string;
}): Promise<{ sent: boolean; reason?: "no_system_key" }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    console.error("[start-card] SYSTEM_SENDGRID_API_KEY is unset — removal email NOT sent");
    return { sent: false, reason: "no_system_key" };
  }
  const rendered = renderStartCardRemoveEmail({ domain: args.domain, removeUrl: args.removeUrl });
  await sgSend(args.email, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
  return { sent: true };
}

export async function sendStartCardReadyEmail(args: {
  email: string;
  domain: string;
  strategyUrl: string;
  card?: StartCardReadyCard;
}): Promise<{ sent: boolean; reason?: "no_system_key" }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    console.error("[start-card] SYSTEM_SENDGRID_API_KEY is unset — card email NOT sent");
    return { sent: false, reason: "no_system_key" };
  }
  const rendered = renderStartCardReadyEmail({ domain: args.domain, strategyUrl: args.strategyUrl, card: args.card });
  await sgSend(args.email, rendered.subject, rendered.html, rendered.text);
  return { sent: true };
}

export async function sendSeedNoticeEmail(args: {
  email: string;
  domain: string;
  cardUrl: string;
  removeUrl: string;
  oneClickUrl: string;
  source: "yc" | "product_hunt" | null;
  card: StartCardReadyCard;
  noticeKey: string;
  from: { email: string; name: string };
  apiKey: string;
}): Promise<{ messageId: string }> {
  const rendered = renderSeedNoticeEmail(args);
  const client = new MailService();
  client.setApiKey(args.apiKey);
  const [res] = await client.send({
    to: args.email,
    from: args.from,
    replyTo: { email: "support@zaviagent.com", name: "Zavi" },
    subject: emailSubjectLine(rendered.subject),
    text: rendered.text,
    html: rendered.html,
    customArgs: { seed_notice_key: args.noticeKey },
    headers: { "List-Unsubscribe": `<${args.oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false },
    },
  });
  const raw = (res?.headers as Record<string, unknown> | undefined)?.["x-message-id"];
  const messageId = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  return { messageId: messageId || `accepted:${args.noticeKey}` };
}
