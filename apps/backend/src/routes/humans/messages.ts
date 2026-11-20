
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { refuseViewerWrite } from "@/services/auth/viewer";
import {
  authorizeThreadAccess,
  listThreadMessages,
  postThreadMessage,
  MAX_MESSAGE_LEN,
} from "@/services/humans/thread";

const Params = z.object({ application_id: z.string().uuid() });

const PostBody = z.object({
  body: z.string().trim().min(1).max(MAX_MESSAGE_LEN),
});

async function resolve(req: Request, res: Response) {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return null;
  }
  const parsed = Params.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_application_id", message: "application_id must be a UUID" },
    });
    return null;
  }

  const auth = await authorizeThreadAccess({
    auth_user_id: verified.user_id,
    application_id: parsed.data.application_id,
  });
  if (!auth.ok) {
    res.status(404).json({ error: { code: "not_found", message: "application not found" } });
    return null;
  }
  if (refuseViewerWrite(req, res, auth.access.tenant_role)) return null;
  return { access: auth.access, user_id: verified.user_id };
}

export async function getHumanApplicationMessages(req: Request, res: Response): Promise<void> {
  const ctx = await resolve(req, res);
  if (!ctx) return;
  const messages = await listThreadMessages(ctx.access);
  res.json({ ok: true, sender_kind: ctx.access.sender_kind, messages });
}

export async function postHumanApplicationMessage(req: Request, res: Response): Promise<void> {
  const ctx = await resolve(req, res);
  if (!ctx) return;

  const parsed = PostBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `body must be 1–${MAX_MESSAGE_LEN} characters`,
      },
    });
    return;
  }

  const message = await postThreadMessage({
    access: ctx.access,
    sender_user_id: ctx.user_id,
    body: parsed.data.body,
  });
  res.json({ ok: true, message });
}
