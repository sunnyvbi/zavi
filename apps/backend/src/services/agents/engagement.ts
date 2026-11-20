
import { serviceClient } from "@/services/supabase";

export type EngagementSignalType =
  | "viewed"
  | "dismissed"
  | "acted_on"
  | "rating_up"
  | "rating_down"
  | "no_action_after_24h";

export type EngagementSignalMeta = {
  source?: string;
  hint?: string;
  weight?: number;
};

export async function recordEngagementSignal(params: {
  tenant_id: string;
  agent_run_id: string;
  agent_slug: string;
  signal_type: EngagementSignalType;
  category?: string;
  meta?: EngagementSignalMeta;
}): Promise<void> {
  try {
    const safeMeta: Record<string, unknown> = {};
    if (params.meta?.source) safeMeta.source = String(params.meta.source);
    if (params.meta?.hint) safeMeta.hint = String(params.meta.hint).slice(0, 200);
    if (typeof params.meta?.weight === "number") safeMeta.weight = params.meta.weight;

    const { error } = await serviceClient()
      .from("agent_engagement_signals")
      .insert({
        tenant_id: params.tenant_id,
        agent_run_id: params.agent_run_id,
        agent_slug: params.agent_slug,
        signal_type: params.signal_type,
        category: params.category ?? null,
        meta: safeMeta,
      });
    if (error) {
      console.warn(
        `[engagement] recordEngagementSignal failed for run=${params.agent_run_id} signal=${params.signal_type}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[engagement] recordEngagementSignal threw for run=${params.agent_run_id}: ${(e as Error).message}`,
    );
  }
}

const REACTIVE_AGENT_SLUGS = [
  "support-lead",
  "dispute-response",
  "qa",
];

export async function backfillNoActionSignals(opts: { hours?: number } = {}): Promise<{ count: number }> {
  const hours = opts.hours ?? 24;
  try {
    const sb = serviceClient();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data: runs, error } = await sb
      .from("agent_runs")
      .select("id,tenant_id,agent_slug")
      .in("agent_slug", REACTIVE_AGENT_SLUGS)
      .eq("status", "success")
      .lt("finished_at", cutoff)
      .gt("finished_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(500);
    if (error) {
      console.warn(`[engagement] backfillNoActionSignals query failed: ${error.message}`);
      return { count: 0 };
    }
    if (!runs || runs.length === 0) return { count: 0 };

    let written = 0;
    for (const r of runs as Array<{ id: string; tenant_id: string; agent_slug: string }>) {
      const { data: existing } = await sb
        .from("agent_engagement_signals")
        .select("id")
        .eq("agent_run_id", r.id)
        .limit(1);
      if (existing && existing.length > 0) continue;
      await recordEngagementSignal({
        tenant_id: r.tenant_id,
        agent_run_id: r.id,
        agent_slug: r.agent_slug,
        signal_type: "no_action_after_24h",
        meta: { source: "weekly_cron" },
      });
      written++;
    }
    return { count: written };
  } catch (e) {
    console.warn(`[engagement] backfillNoActionSignals threw: ${(e as Error).message}`);
    return { count: 0 };
  }
}
