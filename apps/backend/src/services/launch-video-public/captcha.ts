
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;

export type CaptchaResult =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "rejected" | "misconfigured" | "unavailable" };

function secret(): string | null {
  const s = process.env.TURNSTILE_SECRET_KEY;
  return s && s.trim() ? s.trim() : null;
}

export function turnstileSiteKey(): string | null {
  const k = process.env.TURNSTILE_SITE_KEY;
  return k && k.trim() ? k.trim() : null;
}

export async function verifyTurnstile(input: {
  token: string | null;
  ip: string | null;
}): Promise<CaptchaResult> {
  const sk = secret();
  if (!sk) {
    // eslint-disable-next-line no-console
    console.error("[launch-video/captcha] captcha is REQUIRED but TURNSTILE_SECRET_KEY is unset — refusing");
    return { ok: false, reason: "misconfigured" };
  }
  const token = input.token?.trim();
  if (!token) return { ok: false, reason: "missing_token" };

  const body = new URLSearchParams({ secret: sk, response: token });
  if (input.ip) body.set("remoteip", input.ip);

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), VERIFY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(VERIFY_URL, { method: "POST", body, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[launch-video/captcha] siteverify HTTP ${res.status} — refusing`);
      return { ok: false, reason: "unavailable" };
    }
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (json?.success === true) return { ok: true };
    // eslint-disable-next-line no-console
    console.warn(`[launch-video/captcha] rejected: ${(json?.["error-codes"] ?? []).join(",") || "no reason given"}`);
    return { ok: false, reason: "rejected" };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[launch-video/captcha] siteverify unreachable, refusing: ${(e as Error).message}`);
    return { ok: false, reason: "unavailable" };
  }
}
