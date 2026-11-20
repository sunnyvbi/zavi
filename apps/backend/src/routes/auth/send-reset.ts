
import type { Request, Response } from "express";
import { sendResetPasswordEmail } from "@/email/sendAuthEmail";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isSafeNextPath(raw: string | null): boolean {
  if (raw === null) return true;
  if (!raw.startsWith("/")) return false;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return false;
  return true;
}

export function isAllowedResetRedirect(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.pathname !== "/auth/callback") return false;
  if (u.hash) return false;
  for (const key of u.searchParams.keys()) {
    if (key !== "next") return false;
  }
  if (!isSafeNextPath(u.searchParams.get("next"))) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") {
    if (process.env.NODE_ENV === "production") return false;
    return u.protocol === "http:" || u.protocol === "https:";
  }
  if (u.protocol !== "https:") return false;
  return host === "zaviagent.com" || host.endsWith(".zaviagent.com");
}

export async function authEmailSendReset(req: Request, res: Response): Promise<void> {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const redirectTo = typeof req.body?.redirectTo === "string" ? req.body.redirectTo : "";
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({
      error: { code: "invalid_email", message: "A valid email address is required." },
    });
    return;
  }
  if (!redirectTo || !/^https?:\/\//i.test(redirectTo)) {
    res.status(400).json({
      error: { code: "invalid_redirect", message: "redirectTo must be an absolute http(s) URL." },
    });
    return;
  }
  if (!isAllowedResetRedirect(redirectTo)) {
    res.status(400).json({
      error: { code: "invalid_redirect", message: "redirectTo host is not allowed." },
    });
    return;
  }

  try {
    await sendResetPasswordEmail(email, redirectTo);
    res.status(200).json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    // eslint-disable-next-line no-console
    console.error("[auth/email/send-reset] failed", { msg });
    res.status(500).json({
      error: { code: "send_failed", message: "Could not send reset email. Try again." },
    });
  }
}
