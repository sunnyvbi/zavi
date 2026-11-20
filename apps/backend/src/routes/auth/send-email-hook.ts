
import type { Request, Response } from "express";
import { sendEmailChangeLinkEmail, sendRecoveryLinkEmail, sendSignupCodeEmail } from "@/email/sendAuthEmail";
import { handleZaviSendEmailHook, type ZaviHookDeps } from "@/services/auth/send-email-hook";

function h(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createAuthSendEmailHookHandler(deps: () => ZaviHookDeps) {
  return async function authSendEmailHook(req: Request, res: Response): Promise<void> {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const r = await handleZaviSendEmailHook(
        deps(),
        { id: h(req, "webhook-id"), timestamp: h(req, "webhook-timestamp"), signature: h(req, "webhook-signature") },
        raw,
      );
      res.status(r.status).json(r.body);
    } catch (e) {
      console.warn(`[auth send-email hook] failed: ${(e as Error).message}`);
      res.status(503).json({ error: { http_code: 503, message: "unavailable" } });
    }
  };
}

export const authSendEmailHook = createAuthSendEmailHookHandler(() => ({
  secret: process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET,
  supabaseUrl: process.env.SUPABASE_URL,
  now: () => Date.now(),
  sendSignupCode: sendSignupCodeEmail,
  sendRecoveryLink: sendRecoveryLinkEmail,
  sendEmailChangeLink: sendEmailChangeLinkEmail,
  log: (m) => console.warn(m),
}));
