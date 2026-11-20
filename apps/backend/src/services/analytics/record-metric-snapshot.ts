
import { serviceClient } from "@/services/supabase";

export type RecordMetricSnapshotArgs = {
  tenant_id: string;
  metric_key: string;
  value: number | null;
  status?: "measured" | "unavailable";
  source: string;
  window_kind: "rolling_7d" | "day" | "calendar_week" | "point";
  window_start?: string | null;
  window_end: string;
  meta?: object;
};

export type MetricSnapshotRow = {
  id: string;
  tenant_id: string;
  metric_key: string;
  value: number | null;
  status: "measured" | "unavailable";
  source: string;
  window_kind: "rolling_7d" | "day" | "calendar_week" | "point";
  window_start: string | null;
  window_end: string;
  meta: Record<string, unknown>;
  created_at: string;
};

export async function recordMetricSnapshot(
  args: RecordMetricSnapshotArgs,
): Promise<{ ok: boolean }> {
  try {
    const { error } = await serviceClient()
      .from("tenant_metric_snapshots")
      .upsert(
        {
          tenant_id: args.tenant_id,
          metric_key: args.metric_key,
          value: args.value,
          status: args.status ?? "measured",
          source: args.source,
          window_kind: args.window_kind,
          window_start: args.window_start ?? null,
          window_end: args.window_end,
          meta: args.meta ?? {},
          created_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,metric_key,window_kind,window_end" },
      );
    if (error) {
      console.warn(
        `[metric-snapshot] upsert failed for tenant=${args.tenant_id} metric=${args.metric_key}: ${error.message}`,
      );
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn(
      `[metric-snapshot] upsert threw for tenant=${args.tenant_id} metric=${args.metric_key}: ${(e as Error).message}`,
    );
    return { ok: false };
  }
}

export async function readMetricHistory(
  tenant_id: string,
  metric_key: string,
  opts?: {
    window_kind?: "rolling_7d" | "day" | "calendar_week" | "point";
    limit?: number;
  },
): Promise<MetricSnapshotRow[]> {
  let query = serviceClient()
    .from("tenant_metric_snapshots")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("metric_key", metric_key)
    .order("window_end", { ascending: false })
    .limit(opts?.limit ?? 30);
  if (opts?.window_kind) {
    query = query.eq("window_kind", opts.window_kind);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(
      `[metric-snapshot] history read failed for tenant=${tenant_id} metric=${metric_key}: ${error.message}`,
    );
  }
  return (data ?? []) as MetricSnapshotRow[];
}
