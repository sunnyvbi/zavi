
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { sendAppInviteEmail } from "@/email/sendAuthEmail";
import { logEvent } from "@/services/logging/logEvent";
import { siteHasSignupPage } from "@/services/website/site-signup";
import { serverClientFromBearer } from "@/services/supabase";
import { consumeTenantRateLimit, type TenantId } from "@/services/tenant-client";
import { AppDataError, auditRoleValue } from "@/services/website/app-data";
import {
  APP_INVITE_ROLES,
  activateAppInvite,
  createAppInvite,
  listPendingAppInvites,
  revokeAppInvite,
} from "@/services/website/app-invites";
import { resolveLegacyAppHostUrl } from "@/services/sites/legacy-app";

const WRITE_ROLES = ["owner", "admin"] as const;
const createSchema = z
  .object({ role: z.enum(APP_INVITE_ROLES), email: z.string().trim().toLowerCase().email().max(254).optional() })
  .strict();

export const EMAILED_INVITES_PER_HOUR = 20;

function emailRateLimited(res: Response): void {
  res.status(429).json({
    error: {
      code: "invite_email_rate_limited",
      message: `You can email up to ${EMAILED_INVITES_PER_HOUR} invites an hour. Try again later, or create a link instead.`,
    },
  });
}

export function __resetEmailedInvitesForTests(): void {
}

export const ACTIVATION_ATTEMPTS = 3;
const ACTIVATION_BACKOFF_MS = 150;

async function activateEmailedInvite(tenantId: TenantId, inviteId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ACTIVATION_ATTEMPTS; attempt++) {
    try {
      await activateAppInvite(tenantId, inviteId);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof AppDataError && error.code === "app_invite_not_found") break;
      if (attempt < ACTIVATION_ATTEMPTS) await new Promise((r) => setTimeout(r, ACTIVATION_BACKOFF_MS * attempt));
    }
  }
  throw lastError;
}

function bearerToken(req: Request): string {
  const h = (req.headers.authorization as string | undefined) ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : h;
}

function sendError(res: Response, error: unknown): void {
  if (!(error instanceof AppDataError)) {
    res.status(500).json({ error: { code: "unavailable", message: "The app database is unavailable." } });
    return;
  }
  const status =
    error.code === "roles_not_configured" ? 409
      : error.code === "app_invite_not_found" ? 404
        : error.code === "app_db_not_ready" || error.code === "app_db_secret_missing" ? 503
          : 400;
  res.status(status).json({ error: { code: error.code, message: error.message } });
}

async function logFailure(tenantId: string, code: string, error: unknown): Promise<void> {
  if (error instanceof AppDataError) return;
  await logEvent({ level: "error", source: "website.app_invites", code, tenant_id: tenantId, error });
}

export async function createWebsiteAppInviteHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const emailIssue = parsed.error.issues.some((issue) => issue.path[0] === "email");
    res.status(400).json({
      error: emailIssue
        ? { code: "invalid_email", message: "Enter a valid email address." }
        : { code: "invalid_body", message: "role must be 'user' or 'admin'." },
    });
    return;
  }
  let deployedUrl: string | null;
  try {
    deployedUrl = await resolveLegacyAppHostUrl(serverClientFromBearer(bearerToken(req)), auth.tenant_id);
  } catch (error) {
    await logFailure(auth.tenant_id, "app_invite_url_failed", error);
    res.status(500).json({ error: { code: "unavailable", message: "Could not resolve the site address." } });
    return;
  }
  if (!deployedUrl) {
    res.status(409).json({ error: { code: "site_not_deployed", message: "Publish the site before creating invite links." } });
    return;
  }
  const signupAvailable = await siteHasSignupPage(deployedUrl);
  if (signupAvailable !== true) {
    if (signupAvailable === null) {
      res.status(503).json({ error: { code: "site_unavailable", message: "We couldn't verify the site's sign-up page. Try again shortly." } });
      return;
    }
    res.status(409).json({
      error: {
        code: "site_has_no_signup",
        message: "Your site has no sign-up page yet, so an invite link would open a 404. Ask Zavi to add sign-in to your site first.",
      },
    });
    return;
  }
  try {
    const email = parsed.data.email;
    const { token, invite } = await createAppInvite(auth.tenant_id, parsed.data.role, !!email);
    if (email) {
      let allowed = false;
      try {
        allowed = await consumeTenantRateLimit(auth.tenant_id, "app-invite-email", EMAILED_INVITES_PER_HOUR, 3_600);
      } catch (error) {
        await logFailure(auth.tenant_id, "app_invite_rate_limit_failed", error);
        res.status(503).json({
          error: {
            code: "invite_email_unavailable",
            message: "We couldn't verify the email limit right now. Try again shortly, or create a link instead.",
          },
        });
        return;
      }
      if (!allowed) {
        emailRateLimited(res);
        return;
      }
    }
    await logEvent({
      level: "info",
      source: "website.app_invites",
      code: "app_invite_created",
      tenant_id: auth.tenant_id,
      meta: { initiated_by_user: auth.user_id, app_role: auditRoleValue(invite.role), invite_id: invite.id },
    });
    const url = new URL("/signup", deployedUrl);
    url.searchParams.set("invite", token);
    if (email) {
      try {
        await sendAppInviteEmail(auth.tenant_id, email, {
          inviteUrl: url.toString(),
          siteHost: url.host,
          role: parsed.data.role,
          expiresAt: invite.expires_at,
        });
      } catch (sendError) {
        await logEvent({
          level: "error",
          source: "website.app_invites",
          code: "app_invite_email_failed",
          tenant_id: auth.tenant_id,
          error: sendError,
          meta: { initiated_by_user: auth.user_id, invite_id: invite.id },
        });
        res.status(502).json({
          error: { code: "invite_email_failed", message: "We couldn't send the invite email. Try again, or copy a link instead." },
        });
        return;
      }
      try {
        await activateEmailedInvite(auth.tenant_id, invite.id);
      } catch (activationError) {
        await logEvent({
          level: "error",
          source: "website.app_invites",
          code: "app_invite_activation_failed",
          tenant_id: auth.tenant_id,
          error: activationError,
          meta: { initiated_by_user: auth.user_id, invite_id: invite.id },
        });
        res.status(500).json({
          error: {
            code: "invite_activation_failed",
            message: "The invite email was sent, but its link could not be activated, so it will not work. Create a link instead and share it directly.",
          },
        });
        return;
      }
      await logEvent({
        level: "info",
        source: "website.app_invites",
        code: "app_invite_emailed",
        tenant_id: auth.tenant_id,
        meta: { initiated_by_user: auth.user_id, invite_id: invite.id },
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      invite_url: url.toString(),
      expires_at: invite.expires_at,
      role: invite.role,
      ...(email ? { emailed_to: email } : {}),
    });
  } catch (error) {
    await logFailure(auth.tenant_id, "app_invite_create_failed", error);
    sendError(res, error);
  }
}

export async function listWebsiteAppInvitesHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  try {
    const invites = await listPendingAppInvites(auth.tenant_id);
    const host = await resolveLegacyAppHostUrl(serverClientFromBearer(bearerToken(req)), auth.tenant_id).catch(() => null);
    const signup_available = host ? await siteHasSignupPage(host) : null;
    res.status(200).json({ connected: true, invites, signup_available });
  } catch (error) {
    if (error instanceof AppDataError && ["app_db_not_ready", "app_db_secret_missing"].includes(error.code)) {
      res.status(200).json({ connected: false, reason: "not_ready" });
      return;
    }
    await logFailure(auth.tenant_id, "app_invite_list_failed", error);
    sendError(res, error);
  }
}

export async function revokeWebsiteAppInviteHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || !(await requireTenantRole(auth, WRITE_ROLES, res))) return;
  const id = String(req.params.id ?? "");
  try {
    const invite = await revokeAppInvite(auth.tenant_id, id);
    await logEvent({
      level: "info",
      source: "website.app_invites",
      code: "app_invite_revoked",
      tenant_id: auth.tenant_id,
      meta: { initiated_by_user: auth.user_id, app_role: auditRoleValue(invite.role), invite_id: invite.id },
    });
    res.status(200).json({ ok: true, invite });
  } catch (error) {
    await logFailure(auth.tenant_id, "app_invite_revoke_failed", error);
    sendError(res, error);
  }
}
