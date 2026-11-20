
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import { inngest } from "@/../workers/client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rescheduleBodySchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }),
});

const MIN_LEAD_MS = 60_000;

function postIdOf(req: Request, res: Response): string | null {
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "invalid_id", message: "post id must be a uuid" } });
    return null;
  }
  return id;
}

export async function socialPostCancel(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const postId = postIdOf(req, res);
  if (!postId) return;

  const { data, error } = await tenantRpc(auth.tenant_id, "social_post_cancel", { p_post_id: postId });
  if (error) {
    res.status(500).json({ error: { code: "rpc_error", message: "Couldn't cancel the post." } });
    return;
  }
  if (data !== true) {
    res.status(409).json({
      error: {
        code: "not_cancellable",
        message: "This post can't be cancelled any more. It is already publishing, published, or was cancelled.",
      },
    });
    return;
  }
  res.json({ ok: true });
}

export async function socialPostReschedule(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const postId = postIdOf(req, res);
  if (!postId) return;

  const parsed = rescheduleBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "scheduled_at must be an ISO-8601 time" } });
    return;
  }
  const when = new Date(parsed.data.scheduled_at);
  if (when.getTime() <= Date.now() + MIN_LEAD_MS) {
    res.status(400).json({ error: { code: "not_in_future", message: "Pick a time at least a minute from now." } });
    return;
  }

  const { data, error } = await tenantRpc(auth.tenant_id, "social_post_reschedule", {
    p_post_id: postId,
    p_scheduled_at: when.toISOString(),
  });
  if (error) {
    res.status(500).json({ error: { code: "rpc_error", message: "Couldn't reschedule the post." } });
    return;
  }
  const newId = typeof data === "string" ? data : null;
  if (!newId) {
    res.status(409).json({
      error: {
        code: "not_reschedulable",
        message: "This post can't be moved any more. It is already publishing, published, or was cancelled.",
      },
    });
    return;
  }

  try {
    await inngest.send({
      name: "social/publish.requested",
      data: { post_id: newId, tenant_id: auth.tenant_id, agent_run_id: null },
    });
  } catch {
    res.status(502).json({
      error: {
        code: "enqueue_failed",
        message: "The post was moved but the publisher couldn't be woken. Reschedule it once more.",
      },
      post_id: newId,
    });
    return;
  }
  res.json({ ok: true, post_id: newId });
}
