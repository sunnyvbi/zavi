
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffCsat(req: Request, res: Response): Promise<void> {
  assertStaff(req);

  const windowDays = Math.min(
    Math.max(parseInt(String(req.query.window_days ?? "30"), 10) || 30, 1),
    365,
  );
  const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : null;
  const sinceDay = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  let q = serviceClient()
    .from("agent_csat_daily")
    .select("tenant_id, agent_slug, day, thumbs_up, thumbs_down, total, pct_positive")
    .gte("day", sinceDay)
    .order("day", { ascending: false })
    .limit(2000);
  if (tenantId) q = q.eq("tenant_id", tenantId);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  res.json({ window_days: windowDays, rows: data ?? [] });
}
