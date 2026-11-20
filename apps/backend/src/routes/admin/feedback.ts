
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffTenantFeedback(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const limit = Math.min(200, Number(req.query.limit ?? 50));

  const { data, error } = await serviceClient()
    .from("agent_feedback")
    .select("id, agent_slug, target_type, target_id, rating, comment, created_at, created_by")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    res.status(500).json({ error: { code: "feedback_query_failed", message: error.message } });
    return;
  }
  res.json({ feedback: data ?? [] });
}

export async function staffFeedbackFirehose(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const limit = Math.min(500, Number(req.query.limit ?? 100));

  const { data, error } = await serviceClient()
    .from("agent_feedback")
    .select("id, tenant_id, agent_slug, target_type, target_id, rating, comment, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    res.status(500).json({ error: { code: "feedback_query_failed", message: error.message } });
    return;
  }
  res.json({ feedback: data ?? [] });
}
