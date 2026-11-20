import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { emailSendHeld, emailSendPaused, setEmailSendPaused } from "@/services/email-cards/pause";

const Body = z.object({ paused: z.boolean() }).strict();

export type EmailPauseDeps = {
  read: typeof emailSendPaused;
  held: typeof emailSendHeld;
  set: typeof setEmailSendPaused;
  resume: (sendIds: string[]) => Promise<void>;
};

const LIVE: EmailPauseDeps = {
  read: emailSendPaused,
  held: emailSendHeld,
  set: setEmailSendPaused,
  resume: async (sendIds) => {
    const { inngest } = await import("@/../workers/client");
    const failed: string[] = [];
    for (const id of sendIds) {
      const event = { id: `bulk-email-fanout:${id}:resume:${Date.now()}`, name: "bulk-email/fanout.requested" as const, data: { send_id: id } };
      let sent = false;
      for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
        try {
          await inngest.send(event);
          sent = true;
        } catch {
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      if (!sent) failed.push(id);
    }
    if (failed.length > 0) throw new Error(`Could not restart ${failed.length} email sends`);
  },
};

export function emailPauseHandlers(depsIn: Partial<EmailPauseDeps> = {}) {
  const deps = { ...LIVE, ...depsIn };
  return {
    async get(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.setHeader("Cache-Control", "no-store");
        const [paused, held] = await Promise.all([
          deps.read(auth.tenant_id),
          deps.held(auth.tenant_id).catch((): "unknown" => {
            console.error("[email-pause] held read failed");
            return "unknown";
          }),
        ]);
        res.json({ paused, held });
      } catch {
        console.error("[email-pause] read failed");
        res.status(500).json({ error: { code: "internal_error", message: "Could not read whether email is paused. Try again." } });
      }
    },
    async set(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (auth.tenant_overridden === true) {
        res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
        return;
      }
      const body = Body.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: { code: "bad_request", message: "Send {paused: true} or {paused: false}." } });
        return;
      }
      try {
        const out = await deps.set(auth.tenant_id, auth.user_id, body.data.paused);
        if (!out.ok) {
          const status = out.code === "not_authorized" ? 403 : 409;
          res.status(status).json({ error: { code: out.code, message: out.code === "not_authorized" ? "Only an owner or admin can pause or resume email." : "That did not save. Try again." } });
          return;
        }
        if (out.resumed.length > 0) {
          try {
            await deps.resume(out.resumed);
          } catch {
            console.error("[email-pause] resume events failed");
            res.status(503).json({
              error: {
                code: "email_resume_incomplete",
                message: "Email is resumed, but some held campaigns have not restarted yet. Zavi will retry automatically; contact support if they remain held.",
              },
            });
            return;
          }
        }
        res.json({ paused: out.paused });
      } catch {
        console.error("[email-pause] set failed");
        res.status(500).json({ error: { code: "internal_error", message: "That did not save. Try again." } });
      }
    },
  };
}

const live = emailPauseHandlers();
export const getEmailPauseHandler = live.get;
export const postEmailPauseHandler = live.set;
