
import { verifyStandardWebhook } from "../site-auth/webhook-signature";

export interface ZaviHookDeps {
  secret: string | undefined;
  supabaseUrl: string | undefined;
  now: () => number;
  sendSignupCode: (to: string, code: string) => Promise<void>;
  sendRecoveryLink: (to: string, actionUrl: string) => Promise<void>;
  sendEmailChangeLink: (to: string, actionUrl: string, side: "new" | "current", newEmail: string) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ZaviHookResult {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, message: string): ZaviHookResult => ({
  status,
  body: { error: { http_code: status, message } },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_HASH_RE = /^[A-Za-z0-9_\-.=]{8,512}$/;

function verifyLink(supabaseUrl: string, tokenHash: string, type: string, redirect: unknown): string {
  const url = new URL("/auth/v1/verify", supabaseUrl);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", type);
  if (typeof redirect === "string" && redirect) url.searchParams.set("redirect_to", redirect);
  return url.toString();
}

function recoveryRedirect(redirect: unknown, siteUrl: unknown): unknown {
  if (typeof siteUrl !== "string" || !siteUrl) return redirect;
  const bare = (u: string) => u.replace(/\/+$/, "");
  if (typeof redirect === "string" && redirect && bare(redirect) !== bare(siteUrl)) return redirect;
  try {
    const url = new URL("/auth/callback", siteUrl);
    url.searchParams.set("next", "/reset-password");
    return url.toString();
  } catch {
    return redirect;
  }
}

export async function handleZaviSendEmailHook(
  deps: ZaviHookDeps,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: Buffer,
): Promise<ZaviHookResult> {
  if (!deps.secret) return fail(503, "hook_not_configured");
  if (!verifyStandardWebhook(deps.secret, headers, rawBody, deps.now())) return fail(401, "unauthorized");

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return fail(400, "bad_payload");
  }
  const to = typeof payload?.user?.email === "string" ? payload.user.email.trim() : "";
  const data = payload?.email_data ?? {};
  const action = data.email_action_type;
  if (!EMAIL_RE.test(to) || typeof action !== "string") return fail(400, "bad_payload");

  if (action === "signup") {
    const code = data.token;
    if (typeof code !== "string" || !/^\d{6,10}$/.test(code)) return fail(400, "bad_payload");
    await deps.sendSignupCode(to, code);
    return { status: 200, body: {} };
  }

  const redirect = typeof data.redirect_to === "string" && data.redirect_to ? data.redirect_to : data.site_url;

  if (action === "recovery") {
    const tokenHash = data.token_hash;
    if (typeof tokenHash !== "string" || !TOKEN_HASH_RE.test(tokenHash)) return fail(400, "bad_payload");
    if (!deps.supabaseUrl) return fail(503, "hook_not_configured");
    await deps.sendRecoveryLink(to, verifyLink(deps.supabaseUrl, tokenHash, "recovery", recoveryRedirect(redirect, data.site_url)));
    return { status: 200, body: {} };
  }

  if (action === "email_change") {
    const newEmail = typeof payload?.user?.new_email === "string" ? payload.user.new_email.trim() : "";
    const forNew = data.token_hash;
    const forCurrent = data.token_hash_new;
    if (!EMAIL_RE.test(newEmail) || typeof forNew !== "string" || !TOKEN_HASH_RE.test(forNew)) return fail(400, "bad_payload");
    if (forCurrent != null && forCurrent !== "" && (typeof forCurrent !== "string" || !TOKEN_HASH_RE.test(forCurrent))) {
      return fail(400, "bad_payload");
    }
    if (!deps.supabaseUrl) return fail(503, "hook_not_configured");
    await deps.sendEmailChangeLink(newEmail, verifyLink(deps.supabaseUrl, forNew, "email_change", redirect), "new", newEmail);
    if (forCurrent) {
      await deps.sendEmailChangeLink(to, verifyLink(deps.supabaseUrl, forCurrent, "email_change", redirect), "current", newEmail);
    }
    return { status: 200, body: {} };
  }

  deps.log?.(`[auth send-email hook] refused unexpected action ${action}`);
  return fail(403, "action_not_allowed");
}
