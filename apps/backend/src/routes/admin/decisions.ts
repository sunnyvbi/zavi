
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffTenantDecisions(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const limit = Math.min(200, Number(req.query.limit ?? 50));

  let q = serviceClient()
    .from("decisions")
    .select(
      "id, agent_run_id, decision_class, body, status, autonomy_at_emit, handler, emitted_at, approved_at, approved_by",
    )
    .eq("tenant_id", tenantId)
    .order("emitted_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "decisions_query_failed", message: error.message } });
    return;
  }
  res.json({ decisions: data ?? [] });
}
