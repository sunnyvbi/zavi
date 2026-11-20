
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type Row = {
  agent_slug: string;
  thumbs_up: number;
  thumbs_down: number;
  csat_total: number;
  pct_positive: number | null;
  runs: number;
  failed: number;
  fail_rate: number | null;
};

const FAILED = ["failed", "parse_failed", "dispatch_error"];

export async function staffAgentQuality(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/agent-quality: cross-tenant staff read-only board");
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since7dDate = since7d.slice(0, 10);

  const [csat, runs] = await Promise.all([
    sb
      .from("agent_csat_daily")
      .select("agent_slug, thumbs_up, thumbs_down, total")
      .gte("day", since7dDate)
      .limit(5000),
    sb
      .from("agent_runs")
      .select("agent_slug, status")
      .gte("enqueued_at", since7d)
      .limit(20000),
  ]);

  const by = new Map<string, Row>();
  const get = (slug: string): Row => {
    let r = by.get(slug);
    if (!r) {
      r = { agent_slug: slug, thumbs_up: 0, thumbs_down: 0, csat_total: 0, pct_positive: null, runs: 0, failed: 0, fail_rate: null };
      by.set(slug, r);
    }
    return r;
  };

  for (const c of (csat.data ?? []) as Array<{ agent_slug: string; thumbs_up: number; thumbs_down: number; total: number }>) {
    const r = get(c.agent_slug);
    r.thumbs_up += c.thumbs_up ?? 0;
    r.thumbs_down += c.thumbs_down ?? 0;
    r.csat_total += c.total ?? 0;
  }
  for (const run of (runs.data ?? []) as Array<{ agent_slug: string; status: string }>) {
    if (!run.agent_slug) continue;
    const r = get(run.agent_slug);
    r.runs += 1;
    if (FAILED.includes(run.status)) r.failed += 1;
  }

  const rows = [...by.values()].map((r) => {
    r.pct_positive = r.csat_total > 0 ? Math.round((r.thumbs_up / r.csat_total) * 100) : null;
    r.fail_rate = r.runs > 0 ? Math.round((r.failed / r.runs) * 100) : null;
    return r;
  });

  rows.sort((a, b) => (b.fail_rate ?? -1) - (a.fail_rate ?? -1) || (a.pct_positive ?? 101) - (b.pct_positive ?? 101));

  res.json({ agents: rows });
}
