
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyBearer } from "@/services/auth/jwt";
import { requireAuth } from "@/services/auth/middleware";
import { refuseViewerWrite } from "@/services/auth/viewer";
import {
  authorizeCreatorThreadAccess,
  ensureCreatorThread,
  isBookableCreator,
  listCreatorThreadMessages,
  postCreatorThreadMessage,
  MAX_CREATOR_MESSAGE_LEN,
  type CreatorThreadAccess,
} from "@/services/creators/thread";
import { listThreadOffers, offerForSide } from "@/services/creators/offers";

const ThreadParam = z.object({ thread_id: z.string().uuid() });
const CreatorParam = z.object({ human_member_id: z.string().uuid() });

const MessageBody = z.object({
  body: z.string().trim().min(1).max(MAX_CREATOR_MESSAGE_LEN),
});

const OpenThreadBody = z.object({
  body: z.string().trim().min(1).max(MAX_CREATOR_MESSAGE_LEN).optional(),
});

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Thread not found." } });
}

async function resolveThread(
  req: Request,
  res: Response,
): Promise<{ access: CreatorThreadAccess; user_id: string } | null> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return null;
  }
  const parsed = ThreadParam.safeParse(req.params);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_thread_id", message: "thread_id must be a UUID" } });
    return null;
  }
  const auth = await authorizeCreatorThreadAccess({
    auth_user_id: verified.user_id,
    thread_id: parsed.data.thread_id,
  });
  if (!auth.ok) {
    notFound(res);
    return null;
  }
  if (refuseViewerWrite(req, res, auth.access.tenant_role)) return null;
  return { access: auth.access, user_id: verified.user_id };
}

export async function getCreatorThreadMessages(req: Request, res: Response): Promise<void> {
  const ctx = await resolveThread(req, res);
  if (!ctx) return;
  const messages = await listCreatorThreadMessages(ctx.access);
  res.json({ ok: true, sender_kind: ctx.access.sender_kind, messages });
}

export async function postCreatorThreadMessageRoute(req: Request, res: Response): Promise<void> {
  const ctx = await resolveThread(req, res);
  if (!ctx) return;
  const parsed = MessageBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `body must be 1 to ${MAX_CREATOR_MESSAGE_LEN} characters`,
      },
    });
    return;
  }
  const message = await postCreatorThreadMessage({
    access: ctx.access,
    sender_user_id: ctx.user_id,
    body: parsed.data.body,
  });
  res.json({ ok: true, message });
}

export async function getCreatorThreadOffers(req: Request, res: Response): Promise<void> {
  const ctx = await resolveThread(req, res);
  if (!ctx) return;
  const offers = await listThreadOffers({
    tenant_id: ctx.access.tenant_id,
    thread_id: ctx.access.thread_id,
  });
  res.json({
    ok: true,
    sender_kind: ctx.access.sender_kind,
    offers: offers.map((o) => offerForSide(o, ctx.access.sender_kind)),
  });
}

export async function openCreatorThread(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = CreatorParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_creator_id", message: "human_member_id must be a UUID" },
    });
    return;
  }
  const body = OpenThreadBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `body must be 1 to ${MAX_CREATOR_MESSAGE_LEN} characters`,
      },
    });
    return;
  }

  if (!(await isBookableCreator(parsed.data.human_member_id))) {
    res.status(404).json({ error: { code: "not_found", message: "Creator not found." } });
    return;
  }

  const thread = await ensureCreatorThread({
    tenant_id: auth.tenant_id,
    human_member_id: parsed.data.human_member_id,
    started_by: "tenant",
    started_by_user_id: auth.user_id,
  });

  let message = null;
  if (body.data.body) {
    message = await postCreatorThreadMessage({
      access: {
        tenant_id: auth.tenant_id,
        thread_id: thread.id,
        human_member_id: parsed.data.human_member_id,
        sender_kind: "tenant",
      },
      sender_user_id: auth.user_id,
      body: body.data.body,
    });
  }

  res.json({ ok: true, thread, message });
}
