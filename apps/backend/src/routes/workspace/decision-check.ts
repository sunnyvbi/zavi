
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { STUCK_AFTER_MS } from "@/services/growth/stuck-ad-changes";
import { cardPlatform } from "@/services/growth/cgo-blockers";

export const FOUNDER_CHECKED_APPLIED = "founder_checked_applied";
export const FOUNDER_CHECKED_NOT_APPLIED = "founder_checked_not_applied";

const bodySchema = z.object({ went_through: z.boolean() });

export async function decisionCheck(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: { code: "invalid_input", message: "Bad decision id." } });
    return;
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: "went_through must be true or false." } });
    return;
  }

  const sb = tenantClient(asTenantId(auth.tenant_id));
  const { data: row, error: readError } = await sb
    .from("decisions")
    .select("id, tenant_id, status, dispatched_at, decision_class, dispatch_error")
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    res.status(500).json({ error: { code: "read_failed", message: readError.message } });
    return;
  }
  if (!row || (row as { tenant_id: string }).tenant_id !== auth.tenant_id) {
    res.status(404).json({ error: { code: "not_found", message: "No such decision." } });
    return;
  }
  const r = row as { status: string; dispatched_at: string | null; decision_class: string | null; dispatch_error?: string | null };
  if (!cardPlatform(r.decision_class)) {
    res.status(404).json({ error: { code: "not_found", message: "No such decision." } });
    return;
  }
  if (String(r.dispatch_error ?? "").startsWith("founder_checked")) {
    res.json({ ok: true, resolved: "already", status: r.status });
    return;
  }
  if (r.status !== "dispatching") {
    res.json({ ok: true, resolved: "already", status: r.status });
    return;
  }
  const stuckMs = r.dispatched_at ? Date.now() - Date.parse(r.dispatched_at) : 0;
  if (!r.dispatched_at || stuckMs < STUCK_AFTER_MS) {
    res.status(409).json({
      error: {
        code: "still_dispatching",
        message: "Zavi is still sending this change. Check back in a few minutes.",
      },
    });
    return;
  }

  const { data: updated, error: updateError } = await sb
    .from("decisions")
    .update({
      dispatch_error: parsed.data.went_through ? FOUNDER_CHECKED_APPLIED : FOUNDER_CHECKED_NOT_APPLIED,
    })
    .eq("id", id)
    .eq("tenant_id", auth.tenant_id)
    .eq("status", "dispatching")
    .or("dispatch_error.is.null,dispatch_error.not.like.founder_checked*")
    .select("id")
    .maybeSingle();
  if (updateError) {
    res.status(500).json({ error: { code: "update_failed", message: updateError.message } });
    return;
  }
  if (!updated) {
    res.json({ ok: true, resolved: "already", status: "unknown" });
    return;
  }
  res.json({ ok: true, resolved: parsed.data.went_through ? "noted_applied" : "noted_not_applied" });
}
