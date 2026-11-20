
import { serviceClient } from "@/services/supabase";
import { searchMemory } from "@/services/memory";
import { runMemoryRecallEval, type Golden } from "@/services/memory/recall-eval";

export type RecallMetricRow = {
  agent_slug: string;
  run_date: string;
  clean_grounded_rate: number;
  sample_size: number;
};

export type RecallMetricDeps = {
  loadGoldensForAgent: (agent_slug: string) => Promise<Golden[]>;
  search: (
    tenant_id: string,
    query: string,
    k: number,
    agent_slug?: string | null,
  ) => Promise<Array<{ note_id: string }>>;
  verifyTenantNotes: (tenant_id: string, note_ids: string[]) => Promise<Set<string>>;
  upsertMetric: (row: RecallMetricRow) => Promise<void>;
  now?: () => Date;
};

function toRunDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeRecallMetric(
  agent_slug: string,
  deps: RecallMetricDeps,
  run_date?: string,
): Promise<RecallMetricRow> {
  const date = run_date ?? toRunDate((deps.now ?? (() => new Date()))());
  const goldens = await deps.loadGoldensForAgent(agent_slug);

  const byTenant = new Map<string, Golden[]>();
  for (const g of goldens) {
    const arr = byTenant.get(g.tenant_id) ?? [];
    arr.push(g);
    byTenant.set(g.tenant_id, arr);
  }

  let totalHits = 0;
  let totalScored = 0;
  for (const [tenant_id, tenantGoldens] of byTenant) {
    const result = await runMemoryRecallEval(
      { tenant_id, mode: "eval", goldens: tenantGoldens },
      { search: deps.search, verifyTenantNotes: deps.verifyTenantNotes },
    );
    totalScored += result.queries_run;
    totalHits += result.queries_run - result.failures.length;
  }

  const clean_grounded_rate =
    totalScored > 0 ? Number((totalHits / totalScored).toFixed(4)) : 0;

  const row: RecallMetricRow = {
    agent_slug,
    run_date: date,
    clean_grounded_rate,
    sample_size: totalScored,
  };
  await deps.upsertMetric(row);
  return row;
}

async function loadGoldensForAgent(agent_slug: string): Promise<Golden[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_recall_golden")
    .select("id, tenant_id, category, query, expected_note_ids, agent_slug, expected_order")
    .eq("agent_slug", agent_slug)
    .eq("active", true);
  if (error) {
    throw new Error(`[recall-metrics] goldens load failed agent=${agent_slug}: ${error.message}`);
  }
  return (data ?? []) as Golden[];
}

export async function verifyTenantNotes(tenant_id: string, note_ids: string[]): Promise<Set<string>> {
  if (note_ids.length === 0) return new Set();
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("id")
    .eq("tenant_id", tenant_id)
    .in("id", note_ids);
  if (error) {
    console.warn(`[recall-metrics] tenant-note verify failed tenant=${tenant_id}: ${error.message}`);
    return new Set(note_ids);
  }
  return new Set((data ?? []).map((r) => (r as { id: string }).id));
}

async function upsertMetric(row: RecallMetricRow): Promise<void> {
  const { error } = await serviceClient()
    .from("memory_recall_metrics")
    .upsert(
      {
        agent_slug: row.agent_slug,
        run_date: row.run_date,
        clean_grounded_rate: row.clean_grounded_rate,
        sample_size: row.sample_size,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "agent_slug,run_date" },
    );
  if (error) {
    throw new Error(`[recall-metrics] metric upsert failed agent=${row.agent_slug}: ${error.message}`);
  }
}

export async function computeAndWriteRecallMetric(
  agent_slug: string,
  run_date?: string,
): Promise<RecallMetricRow> {
  return computeRecallMetric(
    agent_slug,
    {
      loadGoldensForAgent,
      search: (tid, query, k, slug) =>
        searchMemory(tid, query, k, { agent_slug: slug ?? "memory-recall-metric" }),
      verifyTenantNotes,
      upsertMetric,
    },
    run_date,
  );
}
