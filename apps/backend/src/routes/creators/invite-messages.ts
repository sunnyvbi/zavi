
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { MAX_CREATOR_MESSAGE_LEN } from "@/services/creators/thread";
import {
  InviteMessageError,
  buildInviteCard,
  isInviteUuid,
  listInviteConversations,
  listInviteMessages,
  postInviteMessage,
} from "@/services/creators/invite-messages";

const notFound = (res: Response) =>
  res.status(404).json({ error: { code: "creator_not_found", message: "Creator not found." } });

const MessageBody = z.object({ body: z.string().trim().min(1).max(MAX_CREATOR_MESSAGE_LEN) });

function inviteIdOf(req: Request): string | null {
  const id = String(req.params.invite_id ?? "");
  return isInviteUuid(id) ? id : null;
}

export async function getInviteCard(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = inviteIdOf(req);
  if (!id) return void notFound(res);
  try {
    const creator = await buildInviteCard(id);
    if (!creator) return void notFound(res);
    res.json({ creator });
  } catch {
    res.status(503).json({ error: { code: "creator_card_failed", message: "Could not load this creator just now." } });
  }
}

export async function getInviteConversations(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json({ threads: await listInviteConversations(auth.tenant_id) });
  } catch {
    res.status(503).json({ error: { code: "invite_threads_failed", message: "Could not load conversations just now." } });
  }
}

export async function getInviteMessages(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = inviteIdOf(req);
  if (!id) return void notFound(res);
  try {
    res.json({ ok: true, messages: await listInviteMessages(auth.tenant_id, id) });
  } catch {
    res.status(503).json({ error: { code: "invite_messages_failed", message: "Could not load messages just now." } });
  }
}

export async function postInviteMessageRoute(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = inviteIdOf(req);
  if (!id) return void notFound(res);
  const body = MessageBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: { code: "bad_request", message: `body must be 1 to ${MAX_CREATOR_MESSAGE_LEN} characters` },
    });
    return;
  }
  try {
    const out = await postInviteMessage({ tenant_id: auth.tenant_id, user_id: auth.user_id, invite_id: id, body: body.data.body });
    res.json({ ok: true, message: out.message, email_note: out.email_note });
  } catch (e) {
    if (e instanceof InviteMessageError) {
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
      return;
    }
    res.status(503).json({ error: { code: "invite_message_failed", message: "Could not send this message just now." } });
  }
}
