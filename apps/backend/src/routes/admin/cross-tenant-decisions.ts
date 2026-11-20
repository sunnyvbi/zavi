
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffDecisionsFirehose(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const limit = Math.min(500, Number(req.query.limit ?? 100));
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const decisionClass = typeof req.query.decision_class === "string" ? req.query.decision_class : null;
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;

  let q = serviceClient()
    .from("decisions")
    .select(
      "id, tenant_id, agent_run_id, decision_class, status, autonomy_at_emit, handler, emitted_at, approved_at, dispatched_at, dispatch_error",
    )
    .order("emitted_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  if (decisionClass) q = q.eq("decision_class", decisionClass);
  if (tenantId) q = q.eq("tenant_id", tenantId);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "decisions_query_failed", message: error.message } });
    return;
  }
  res.json({ decisions: data ?? [] });
}

export async function staffDecisionDetail(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = req.params.id;
  const sb = serviceClient();

  const { data: decision, error } = await sb
    .from("decisions")
    .select(
      "id, tenant_id, agent_run_id, decision_class, body, status, autonomy_at_emit, handler, emitted_at, approved_at, approved_by, dispatched_at, dispatch_error",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "decision_query_failed", message: error.message } });
    return;
  }
  if (!decision) {
    res.status(404).json({ error: { code: "not_found", message: "decision not found" } });
    return;
  }

  let run: unknown = null;
  if (decision.agent_run_id) {
    const { data: r } = await sb
      .from("agent_runs")
      .select("id, agent_slug, status, started_at, finished_at, output_text")
      .eq("id", decision.agent_run_id)
      .maybeSingle();
    run = r ?? null;
  }

  res.json({ decision, run });
}
