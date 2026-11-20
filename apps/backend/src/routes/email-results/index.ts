
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { listSentEmailsPage, SENT_EMAILS_LIMIT } from "@/services/email-results/view";

const Query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).strict();

export function emailResultsHandlers(deps: { list: typeof listSentEmailsPage } = { list: listSentEmailsPage }) {
  return {
    async list(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      const q = Query.safeParse(req.query ?? {});
      if (!q.success) {
        res.status(400).json({ error: { code: "bad_query", message: "limit must be a number from 1 to 200." } });
        return;
      }
      try {
        const { emails, more } = await deps.list(auth.tenant_id, q.data.limit ?? SENT_EMAILS_LIMIT);
        res.setHeader("Cache-Control", "no-store");
        res.json({ emails, more });
      } catch {
        console.error("[email-results] list failed");
        res.status(500).json({ error: { code: "internal_error", message: "Sent emails could not be loaded. Try again." } });
      }
    },
  };
}

export const getEmailResultsHandler = emailResultsHandlers().list;
