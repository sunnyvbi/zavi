
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffTenantRuns(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const slug = typeof req.query.slug === "string" ? req.query.slug : null;
  const limit = Math.min(200, Number(req.query.limit ?? 50));

  let q = serviceClient()
    .from("agent_runs")
    .select(
      "id, agent_slug, status, parse_ok, cost_tokens, cost_usd, started_at, finished_at, output_text, quality_score, quality_scored_at",
    )
    .eq("tenant_id", tenantId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (slug) q = q.eq("agent_slug", slug);

  const { data, error } = await q;
  if (error) {
    res.status(500).json({ error: { code: "runs_query_failed", message: error.message } });
    return;
  }

  type RunRow = {
    id: string;
    agent_slug: string;
    status: string;
    parse_ok: boolean | null;
    cost_tokens: number | null;
    cost_usd: number | null;
    started_at: string | null;
    finished_at: string | null;
    output_text: string | null;
    quality_score: number | null;
    quality_scored_at: string | null;
  };
  const runs = ((data ?? []) as RunRow[]).map((r) => ({
    ...r,
    output_text: r.output_text ? r.output_text.slice(0, 400) : null,
  }));
  res.json({ runs });
}
