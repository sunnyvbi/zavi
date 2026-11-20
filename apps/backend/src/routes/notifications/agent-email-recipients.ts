
import type { Request, Response } from "express";
import { z } from "zod";

import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { resolveAgentEmailRecipients } from "@/services/notifications/agent-email-recipients";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const postBody = z
  .object({
    email: z.string().trim().min(3).max(254).regex(EMAIL_RE, "not an email address"),
    label: z.string().trim().max(60).optional(),
  })
  .strict();

function refuseOverriddenWrite(auth: { tenant_overridden?: boolean }, res: Response): boolean {
  if (auth.tenant_overridden !== true) return false;
  res.status(403).json({
    error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." },
  });
  return true;
}

export async function listAgentEmailRecipients(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const recipients = await resolveAgentEmailRecipients(auth.tenant_id);
  res.json({ recipients });
}

export async function addAgentEmailRecipient(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (refuseOverriddenWrite(auth, res)) return;

  const parsed = postBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "invalid_body",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("add_agent_email_recipient", {
    p_email: parsed.data.email,
    p_label: parsed.data.label ?? null,
  });

  if (error) {
    const code = error.message.includes("recipient_cap_reached")
      ? "cap_reached"
      : error.message.includes("no_tenant_membership")
        ? "no_tenant"
        : "add_failed";
    const status = code === "cap_reached" ? 409 : code === "no_tenant" ? 403 : 500;
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }

  res.status(201).json({ id: data });
}

export async function removeAgentEmailRecipient(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (refuseOverriddenWrite(auth, res)) return;

  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_id", message: "id must be a uuid" } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("remove_agent_email_recipient", {
    p_id: id.data,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "remove_failed", message: error.message } });
    return;
  }
  res.json({ removed: Boolean(data) });
}
