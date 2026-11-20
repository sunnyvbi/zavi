
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

export const SLA_MINUTES = 15;
const FAILED = ["failed", "parse_failed", "dispatch_error"];

type Run = {
  id: string;
  tenant_id: string | null;
  tenant: string;
  agent_slug: string | null;
  status: string;
  started_at: string | null;
  enqueued_at: string | null;
  finished_at: string | null;
  age_min: number | null;
  error: string | null;
};

export async function staffStuckRuns(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/stuck-runs: cross-tenant staff read-only board");
  const now = Date.now();
  const slaCutoff = new Date(now - SLA_MINUTES * 60 * 1000).toISOString();
  const since24 = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const [stuck, failed, tenants] = await Promise.all([
    sb
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, status, started_at, enqueued_at, finished_at, error")
      .eq("status", "running")
      .lt("started_at", slaCutoff)
      .order("started_at", { ascending: true })
      .limit(200),
    sb
      .from("agent_runs")
      .select("id, tenant_id, agent_slug, status, started_at, enqueued_at, finished_at, error")
      .in("status", FAILED)
      .gte("enqueued_at", since24)
      .order("finished_at", { ascending: false })
      .limit(200),
    sb.from("tenants").select("id, slug, display_name"),
  ]);

  const nameById = new Map<string, string>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string; display_name: string | null }>) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
  }

  type Raw = Omit<Run, "tenant" | "age_min">;
  const shape = (r: Raw): Run => {
    const start = r.started_at ? new Date(r.started_at).getTime() : null;
    return {
      ...r,
      tenant: r.tenant_id ? nameById.get(r.tenant_id) ?? r.tenant_id.slice(0, 8) : "—",
      age_min: start ? Math.round((now - start) / 60000) : null,
    };
  };

  res.json({
    sla_minutes: SLA_MINUTES,
    stuck: ((stuck.data ?? []) as Raw[]).map(shape),
    failed_24h: ((failed.data ?? []) as Raw[]).map(shape),
  });
}
