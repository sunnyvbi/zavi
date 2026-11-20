
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { captureAdminCorrection } from "@/services/staff/capture-admin-correction";
import {
  rejectBatch,
  approveBatch,
  neverAutoSlugSet,
  type DecisionMeta,
  type DecisionMetaLoader,
  type RejectCapture,
} from "@/services/approvals/batch-decide-service";

const BatchBody = z.object({
  decision_ids: z.array(z.string().uuid()).min(1).max(200),
});

function metaLoader(tenant_id: string): DecisionMetaLoader {
  return async (ids) => {
    const map = new Map<string, DecisionMeta>();
    if (ids.length === 0) return { ok: true, meta: map };
    const svc = serviceClient();
    const { data, error } = await svc
      .from("decisions")
      .select("id, decision_class, handler, autonomy_at_emit")
      .eq("tenant_id", tenant_id)
      .in("id", ids);
    if (error) {
      return { ok: false, error: error.message };
    }
    const { data: naData, error: naErr } = await svc
      .from("decision_classes")
      .select("slug")
      .eq("never_auto", true);
    if (naErr) return { ok: false, error: naErr.message };
    const neverAuto = neverAutoSlugSet((naData ?? []) as Array<{ slug?: unknown }>);
    for (const row of (data ?? []) as Array<{
      id: string;
      decision_class: string | null;
      handler: string | null;
      autonomy_at_emit: string | null;
    }>) {
      map.set(row.id, {
        decision_class: row.decision_class,
        handler: row.handler,
        autonomy_at_emit: row.autonomy_at_emit,
        never_auto: row.decision_class ? neverAuto.has(row.decision_class) : false,
      });
    }
    return { ok: true, meta: map };
  };
}

function rejectCapture(tenant_id: string, actor_user_id: string): RejectCapture {
  return async (decision_id) => {
    const { data: dec } = await serviceClient()
      .from("decisions")
      .select("decision_class")
      .eq("id", decision_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const decision_class = (dec as { decision_class?: string } | null)?.decision_class;
    if (!decision_class) return;
    await captureAdminCorrection({
      tenant_id,
      decision_id,
      decision_class,
      actor: { user_id: actor_user_id },
      actor_kind: "customer",
      action: "reject",
      reason: null,
    });
  };
}

export async function approvalsRejectBatch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = BatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_batch", message: "decision_ids must be a non-empty array of UUIDs (≤200)" },
    });
    return;
  }
  const decision_ids = [...new Set(parsed.data.decision_ids)];

  const result = await rejectBatch({
    decision_ids,
    tenant_id: auth.tenant_id,
    actor_user_id: auth.user_id,
    captureReject: rejectCapture(auth.tenant_id, auth.user_id),
  });

  await logEvent({
    level: "info",
    source: "approvals/reject-batch",
    code: "approvals_reject_batch",
    message: `reject-batch: ${result.rejected ?? 0}/${result.total} rejected, ${result.errored} errored`,
    tenant_id: auth.tenant_id,
    meta: { total: result.total, count: result.rejected ?? 0 },
  });

  res.json({ ok: true, ...result });
}

export async function approvalsApproveBatch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = BatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_batch", message: "decision_ids must be a non-empty array of UUIDs (≤200)" },
    });
    return;
  }
  const decision_ids = [...new Set(parsed.data.decision_ids)];

  const result = await approveBatch({
    decision_ids,
    tenant_id: auth.tenant_id,
    actor_user_id: auth.user_id,
    loadMeta: metaLoader(auth.tenant_id),
  });

  if (result.aborted) {
    await logEvent({
      level: "warn",
      source: "approvals/approve-batch",
      code: "approvals_approve_batch_aborted",
      message: `approve-batch aborted (fail-closed): ${result.aborted.reason}`,
      tenant_id: auth.tenant_id,
      meta: { total: result.total },
    });
    res.status(503).json({
      error: {
        code: "approve_batch_unavailable",
        message: "Could not verify which decisions are safe to bulk-approve. Nothing was approved. Please retry.",
      },
    });
    return;
  }

  await logEvent({
    level: "info",
    source: "approvals/approve-batch",
    code: "approvals_approve_batch",
    message: `approve-batch: ${result.approved ?? 0}/${result.total} approved, ${result.skipped} skipped, ${result.errored} errored`,
    tenant_id: auth.tenant_id,
    meta: { total: result.total, count: result.approved ?? 0 },
  });

  res.json({ ok: true, ...result });
}
