
import type { AnchorClient, AnchorSession } from "./anchor-backend";
import type { BrowserToolCtx, DaemonResult } from "./types";
import { isAutoExecuteBrowserAgent } from "./browser-auto-execute-policy";
import { isSocialPublishEnabled } from "@/agents/social/social-publish-flag";
import {
  getConnectedSocialAccount,
  getSocialCredentials,
  setSocialConnection,
  markSocialAccountChallenged,
  type ConnectedSocialAccount,
  type SocialPlatform,
} from "./social-connections";
import { logEvent } from "@/services/logging/logEvent";

interface PlatformLoginForm {
  url: string;
  userSelector: string;
  passSelector: string;
  submitSelector: string;
  successUrlHints: readonly string[];
  challengeUrlHints: readonly string[];
}

const LOGIN_FORMS: Readonly<Record<SocialPlatform, PlatformLoginForm>> = {
  linkedin: {
    url: "https://www.linkedin.com/login",
    userSelector: "#username",
    passSelector: "#password",
    submitSelector: 'button[type="submit"]',
    successUrlHints: ["/feed", "/in/", "linkedin.com/home"],
    challengeUrlHints: ["/checkpoint", "/challenge", "two-step", "/uas/"],
  },
  instagram: {
    url: "https://www.instagram.com/accounts/login/",
    userSelector: 'input[name="username"]',
    passSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    successUrlHints: ["instagram.com/", "/?__coig"],
    challengeUrlHints: ["/challenge", "/two_factor", "/auth_platform"],
  },
  tiktok: {
    url: "https://www.tiktok.com/login/phone-or-email/email",
    userSelector: 'input[name="username"]',
    passSelector: 'input[type="password"]',
    submitSelector: 'button[type="submit"]',
    successUrlHints: ["/foryou", "tiktok.com/@"],
    challengeUrlHints: ["/login/", "verify", "captcha"],
  },
};

export interface SocialLoginResult {
  injected: boolean;
  result?: DaemonResult;
}

const NOOP: SocialLoginResult = { injected: false };

export async function maybeInjectSocialLogin(args: {
  ctx: BrowserToolCtx;
  origin?: string;
  session: AnchorSession;
  client: AnchorClient;
  apiKey: string;
  account?: ConnectedSocialAccount | null;
}): Promise<SocialLoginResult> {
  const { ctx, origin, session, client, apiKey } = args;

  if (!isAutoExecuteBrowserAgent(ctx.agent_slug)) return NOOP;

  if (!(await isSocialPublishEnabled())) return NOOP;

  const account =
    args.account !== undefined
      ? args.account
      : await getConnectedSocialAccount(ctx.tenant_id, origin, ctx.user_id);
  if (!account) return NOOP;

  if (!ctx.user_id) return NOOP;

  if (account.anchor_profile_id) return NOOP;

  const form = LOGIN_FORMS[account.platform];
  if (!form) return NOOP;

  const creds = await getSocialCredentials(
    ctx.tenant_id,
    account.platform,
    account.handle,
    ctx.user_id,
  );
  if (!creds) {
    return {
      injected: false,
      result: loginBlocked("login_credentials_missing", account.platform),
    };
  }

  try {
    const nav = await client.runAction({
      apiKey,
      session,
      op: { op: "nav", url: form.url },
    });
    if (!nav.ok) return { injected: true, result: nav };

    const fillUser = await client.runAction({
      apiKey,
      session,
      op: { op: "fill", selector: form.userSelector, value: creds.username },
    });
    if (!fillUser.ok) return { injected: true, result: fillUser };

    const fillPass = await client.runAction({
      apiKey,
      session,
      op: { op: "fill", selector: form.passSelector, value: creds.password },
    });
    if (!fillPass.ok) return { injected: true, result: fillPass };

    const submit = await client.runAction({
      apiKey,
      session,
      op: { op: "click", selector: form.submitSelector },
    });
    if (!submit.ok) return { injected: true, result: submit };

    const cur = await client.runAction({
      apiKey,
      session,
      op: { op: "current_url" },
    });
    const landedUrl =
      cur.ok && typeof cur.result === "string" ? cur.result.toLowerCase() : "";

    const hitChallenge = form.challengeUrlHints.some((h) =>
      landedUrlIncludes(landedUrl, h),
    );
    if (hitChallenge) {
      await markSocialAccountChallenged(
        ctx.tenant_id,
        account.platform,
        account.handle,
        ctx.user_id,
      );
      return {
        injected: true,
        result: loginBlocked("login_challenge", account.platform),
      };
    }

    const profileId = session.id;
    if (profileId) {
      await setSocialConnection({
        tenant_id: ctx.tenant_id,
        platform: account.platform,
        handle: account.handle,
        username: creds.username,
        password: creds.password,
        owner_user_id: ctx.user_id,
        anchor_profile_id: profileId,
      });
    }

    await logEvent({
      level: "info",
      source: "browser.social_login",
      tenant_id: ctx.tenant_id,
      run_id: ctx.run_id,
      meta: {
        agent_slug: ctx.agent_slug,
        run_id_ref: ctx.run_id,
        platform: account.platform,
        profile_persisted: profileId ? 1 : 0,
        initiated_by_user: ctx.user_id,
      },
    });

    return { injected: true };
  } catch (e) {
    return {
      injected: true,
      result: loginBlocked("login_error", account.platform, (e as Error).message),
    };
  }
}

function landedUrlIncludes(landedUrl: string, hint: string): boolean {
  return landedUrl.includes(hint.toLowerCase());
}

function loginBlocked(
  code: string,
  platform: SocialPlatform,
  detail?: string,
): DaemonResult {
  return {
    ok: false,
    error_code: code,
    error_message:
      `Social login to ${platform} did not complete (${code}). The run is ` +
      `stopped before any further action; report this as blocked and do not ` +
      `retry the login.` + (detail ? ` (${detail})` : ""),
  };
}
