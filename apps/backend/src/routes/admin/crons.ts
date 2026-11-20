
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffCrons(_req: Request, res: Response): Promise<void> {
  assertStaff(_req);
  const sb = serviceClient();
  const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [schedulesQ, runsQ] = await Promise.all([
    sb
      .from("tenant_agent_schedules")
      .select("tenant_id, agent_slug, cron_expression, enabled, last_fired_at")
      .order("tenant_id", { ascending: true })
      .order("agent_slug", { ascending: true }),
    sb
      .from("agent_runs")
      .select("tenant_id, agent_slug, status")
      .not("cron_dedupe_key", "is", null)
      .gte("enqueued_at", since24)
      .limit(10000),
  ]);

  if (schedulesQ.error) {
    res.status(500).json({
      error: { code: "schedules_query_failed", message: schedulesQ.error.message },
    });
    return;
  }
  if (runsQ.error) {
    res.status(500).json({
      error: { code: "cron_runs_query_failed", message: runsQ.error.message },
    });
    return;
  }

  type RunRow = { tenant_id: string; agent_slug: string; status: string };
  const counts = new Map<string, { ok: number; fail: number }>();
  for (const r of (runsQ.data ?? []) as RunRow[]) {
    const k = `${r.tenant_id}::${r.agent_slug}`;
    const cur = counts.get(k) ?? { ok: 0, fail: 0 };
    if (r.status === "success" || r.status === "completed" || r.status === "succeeded") cur.ok += 1;
    else if (
      r.status === "failed" ||
      r.status === "parse_failed" ||
      r.status === "dispatch_error"
    )
      cur.fail += 1;
    counts.set(k, cur);
  }

  type Sched = {
    tenant_id: string;
    agent_slug: string;
    cron_expression: string;
    enabled: boolean;
    last_fired_at: string | null;
  };
  const schedules = ((schedulesQ.data ?? []) as Sched[]).map((s) => {
    const c = counts.get(`${s.tenant_id}::${s.agent_slug}`) ?? { ok: 0, fail: 0 };
    return { ...s, runs_24h_ok: c.ok, runs_24h_fail: c.fail };
  });

  res.json({ schedules, inngest_dashboard_url: "https://app.inngest.com" });
}
