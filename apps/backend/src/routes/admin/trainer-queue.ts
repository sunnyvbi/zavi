
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { writeStaffAudit } from "@/services/staff/audit";
import { captureAdminCorrection } from "@/services/staff/capture-admin-correction";
import { isComposioDecisionClass } from "@/services/connectors/composio/write-classify";
import { TIKTOK_CHAT_EDIT_CLASSES } from "@/services/connectors/tiktok-ads/held-schema";

const RejectBody = z.object({
  reason: z.string().max(2000).optional(),
});

const QueueQuery = z.object({
  limit: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? parseInt(v, 10) : v))
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});

type QueueRow = {
  type: string;
  id: string;
  tenant_id: string;
  agent_slug: string;
  priority_score: number;
  surfaced_at: string;
  preview: string | null;
  source_feedback_id: string | null;
  source_thread_id: string | null;
};

export async function staffTrainerQueueList(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);

  const parsed = QueueQuery.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit ?? 50 : 50;

  const { data, error } = await serviceClient().rpc("list_trainer_queue", {
    p_limit: limit,
  });
  if (error) {
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }

  res.json({ items: (data as QueueRow[] | null) ?? [] });
}

export async function staffTrainerDecisionApprove(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const decisionId = req.params.id;
  if (!decisionId) {
    res
      .status(400)
      .json({ error: { code: "missing_id", message: "decision id required" } });
    return;
  }

  const svc = serviceClient();
  const { data: row, error: readErr } = await svc
    .from("decisions")
    .select("id, tenant_id, status, decision_class")
    .eq("id", decisionId)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({ error: { code: "read_failed", message: readErr.message } });
    return;
  }
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: `decision ${decisionId}` } });
    return;
  }
  const r = row as { id: string; tenant_id: string; status: string; decision_class: string };
  if (r.status !== "proposed") {
    res.status(409).json({
      error: {
        code: "wrong_status",
        message: `decision ${decisionId} is ${r.status} (need 'proposed')`,
      },
    });
    return;
  }

  if (isComposioDecisionClass(r.decision_class) || TIKTOK_CHAT_EDIT_CLASSES.has(r.decision_class ?? "")) {
    res.status(403).json({ error: { code: "not_authorized", message: "Only the tenant can approve a connected-app write or a TikTok Ads change." } });
    return;
  }

  const { error: updErr } = await svc
    .from("decisions")
    .update({
      status: "approved",
      approved_by: staff.user_id,
      approved_by_source: "staff",
      approved_at: new Date().toISOString(),
    })
    .eq("id", decisionId);
  if (updErr) {
    res.status(500).json({ error: { code: "update_failed", message: updErr.message } });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "trainer-queue.decision.approve",
    target_table: "decisions",
    target_id: decisionId,
    tenant_id: r.tenant_id,
    meta: { decision_class: r.decision_class },
  });

  await inngest.send({
    name: "decision.approved",
    data: {
      decision_id: decisionId,
      tenant_id: r.tenant_id,
      decision_class: r.decision_class,
    },
  });

  res.json({ ok: true, decision_id: decisionId });
}

export async function staffTrainerDecisionReject(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);
  const decisionId = req.params.id;
  if (!decisionId) {
    res
      .status(400)
      .json({ error: { code: "missing_id", message: "decision id required" } });
    return;
  }

  const parsedBody = RejectBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsedBody.error.message } });
    return;
  }
  const reason = parsedBody.data.reason;

  const svc = serviceClient();
  const { data: row, error: readErr } = await svc
    .from("decisions")
    .select("id, tenant_id, status, decision_class")
    .eq("id", decisionId)
    .maybeSingle();
  if (readErr) {
    res.status(500).json({ error: { code: "read_failed", message: readErr.message } });
    return;
  }
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: `decision ${decisionId}` } });
    return;
  }
  const r = row as { id: string; tenant_id: string; status: string; decision_class: string };
  if (r.status !== "proposed") {
    res.status(409).json({
      error: {
        code: "wrong_status",
        message: `decision ${decisionId} is ${r.status} (need 'proposed')`,
      },
    });
    return;
  }

  const { data: updRows, error: updErr } = await svc
    .from("decisions")
    .update({
      status: "rejected",
      approved_by: staff.user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", decisionId)
    .eq("status", "proposed")
    .select("id");
  if (updErr) {
    res.status(500).json({ error: { code: "update_failed", message: updErr.message } });
    return;
  }
  const changed = (updRows ?? []).length === 1;
  if (!changed) {
    res.status(409).json({
      error: { code: "wrong_status", message: `decision ${decisionId} no longer proposed` },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "trainer-queue.decision.reject",
    target_table: "decisions",
    target_id: decisionId,
    tenant_id: r.tenant_id,
    meta: {},
  });

  try {
    await captureAdminCorrection({
      tenant_id: r.tenant_id,
      decision_id: decisionId,
      decision_class: r.decision_class,
      actor: { user_id: staff.user_id, email: staff.email },
      action: "reject",
      reason: reason ?? "(no reason given)",
    });
  } catch (e) {
    console.warn(
      `[trainer-queue] captureAdminCorrection failed for ${decisionId}: ${(e as Error)?.message ?? e}`,
    );
  }

  res.json({ ok: true, decision_id: decisionId });
}
