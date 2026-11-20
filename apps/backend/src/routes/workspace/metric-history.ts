
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { METRIC_REGISTRY } from "@/services/analytics/metric-registry";
import { SNAPSHOT_SOURCE_TO_CONNECTOR, readGoalHistory } from "@/services/analytics/goal-history";

export { SNAPSHOT_SOURCE_TO_CONNECTOR };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getGoalHistory(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "goal id must be a uuid" } });
    return;
  }
  const sb = serverClientFromBearer(auth.access_token);
  const { data: goal, error: goalErr } = await sb
    .from("autopilot_goals")
    .select("id, target_metric, measurement_mode")
    .eq("tenant_id", auth.tenant_id)
    .eq("id", id)
    .maybeSingle();
  if (goalErr) {
    res.status(500).json({ error: { code: "read_failed", message: "Could not read the goal." } });
    return;
  }
  if (!goal) {
    res.status(404).json({ error: { code: "not_found", message: "No such goal." } });
    return;
  }
  let h;
  try {
    h = await readGoalHistory(sb, auth.tenant_id, { id, target_metric: goal.target_metric, measurement_mode: goal.measurement_mode });
  } catch {
    res.status(500).json({ error: { code: "read_failed", message: "Could not read the goal's history." } });
    return;
  }
  res.json({ goal_id: id, ...h });
}

export async function getConnectorSyncStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const sb = serverClientFromBearer(auth.access_token);
  const reads = await Promise.all(
    Object.values(METRIC_REGISTRY).map(async (def) => {
      const { data, error } = await sb
        .from("tenant_metric_snapshots")
        .select("source, created_at")
        .eq("tenant_id", auth.tenant_id)
        .eq("metric_key", def.key)
        .eq("status", "measured")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) return { failed: true as const };
      return { failed: false as const, row: (data ?? [])[0] as { source?: string; created_at?: string } | undefined };
    }),
  );
  if (reads.every((r) => r.failed)) {
    res.status(500).json({ error: { code: "read_failed", message: "Could not read sync times." } });
    return;
  }
  const sources: Record<string, { last_synced_at: string }> = {};
  for (const r of reads) {
    if (r.failed || !r.row?.source || !r.row.created_at) continue;
    const slug = SNAPSHOT_SOURCE_TO_CONNECTOR[r.row.source];
    if (!slug) continue;
    const prev = sources[slug]?.last_synced_at;
    if (!prev || Date.parse(r.row.created_at) > Date.parse(prev)) sources[slug] = { last_synced_at: r.row.created_at };
  }
  res.json({ sources });
}
