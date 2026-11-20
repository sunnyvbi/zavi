
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { track } from "@/services/analytics/mixpanel";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const ATTACHMENT_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|mp4)$/;

const Body = z
  .object({
    body: z.string().min(1).max(8000),
    attachments: z.array(z.string().regex(ATTACHMENT_PATH)).max(10).optional(),
    source: z.enum(["settings", "menu"]).optional(),
  })
  .strict();

type RpcRow = { feedback_id: string; tenant_id: string };

export async function feedbackProductSubmit(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: "Feedback must be 1-8000 characters." },
    });
    return;
  }

  const attachments = parsed.data.attachments ?? [];
  const foreign = attachments.filter((p) => !p.startsWith(`${auth.tenant_id}/`));
  if (foreign.length > 0) {
    res.status(400).json({
      error: { code: "invalid_attachment", message: "Attachment does not belong to this workspace." },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .rpc("submit_tenant_feedback", {
      p_body: parsed.data.body,
      p_attachments: attachments,
      p_source: parsed.data.source ?? "settings",
      p_tenant_id: auth.tenant_id,
    })
    .single<RpcRow>();

  if (error || !data) {
    const msg = error?.message ?? "rpc returned no row";
    const lower = msg.toLowerCase();
    if (
      lower.includes("unauthorized") ||
      lower.includes("unauthenticated") ||
      lower.includes("no active tenant") ||
      lower.includes("not a member") ||
      lower.includes("empty")
    ) {
      res.status(400).json({ error: { code: "rpc_rejected", message: msg } });
      return;
    }
    res.status(500).json({ error: { code: "rpc_failed", message: msg } });
    return;
  }

  void notifyFounderActivity({
    event: "feedback_submitted",
    tenant_id: data.tenant_id,
    user_id: auth.user_id,
    details: { kind: "product feedback", source: parsed.data.source ?? "settings", feedback: parsed.data.body, attachments: attachments.length },
  });

  track("product_feedback_submitted", {
    user_id: auth.user_id,
    tenant_id: data.tenant_id,
    attachment_count: attachments.length,
    source: parsed.data.source ?? "settings",
  });

  res.status(200).json({ ok: true, feedback_id: data.feedback_id });
}

export type MyFeedbackRow = {
  id: string;
  body: string;
  created_at: string;
  status: "received" | "working" | "done" | "wont_do";
  staff_note: string | null;
  updated: boolean;
};

type DbRow = Omit<MyFeedbackRow, "updated"> & {
  status_updated_at: string | null;
  sender_seen_at: string | null;
};

export function isUnseenUpdate(r: Pick<DbRow, "status_updated_at" | "sender_seen_at">): boolean {
  if (!r.status_updated_at) return false;
  if (!r.sender_seen_at) return true;
  return new Date(r.status_updated_at).getTime() > new Date(r.sender_seen_at).getTime();
}

export async function feedbackProductMine(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { data, error } = await serverClientFromBearer(auth.access_token)
    .from("tenant_feedback")
    .select("id, body, created_at, status, staff_note, status_updated_at, sender_seen_at")
    .eq("tenant_id", auth.tenant_id)
    .eq("created_by", auth.user_id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    res.status(500).json({ error: { code: "feedback_list_failed", message: "Couldn't load your requests." } });
    return;
  }

  const requests: MyFeedbackRow[] = ((data ?? []) as DbRow[]).map((r) => ({
    id: r.id,
    body: r.body,
    created_at: r.created_at,
    status: r.status,
    staff_note: r.staff_note,
    updated: isUnseenUpdate(r),
  }));
  res.json({ requests, updates: requests.filter((r) => r.updated).length });
}

export async function feedbackProductSeen(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { error } = await serverClientFromBearer(auth.access_token).rpc("mark_my_tenant_feedback_seen", {
    p_tenant_id: auth.tenant_id,
  });
  if (error) {
    res.status(500).json({ error: { code: "feedback_seen_failed", message: error.message } });
    return;
  }
  res.json({ ok: true });
}
