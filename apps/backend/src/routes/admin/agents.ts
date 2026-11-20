
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffAgentsFirehose(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const limit = Math.min(1000, Number(req.query.limit ?? 500));
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const slug = typeof req.query.slug === "string" ? req.query.slug : null;

  let q = serviceClient()
    .from("tenant_agents")
    .select(
      "tenant_id, slug, version, status, parent_template, created_at",
    )
    .eq("status", "active")
    .order("tenant_id", { ascending: true })
    .order("slug", { ascending: true })
    .limit(limit);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  if (slug) q = q.eq("slug", slug);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "agents_query_failed", message: error.message } });
    return;
  }
  res.json({ agents: data ?? [] });
}
