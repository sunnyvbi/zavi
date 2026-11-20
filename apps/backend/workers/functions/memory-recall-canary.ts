
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { searchMemory } from "@/services/memory";
import { alert } from "@/services/logging/alert";
import {
  runMemoryRecallEval,
  ALERT_TOP3_RECALL_THRESHOLD,
  type Golden,
} from "@/services/memory/recall-eval";

const EVAL_PER_TENANT_LIMIT = 50;
const CANARY_PER_CATEGORY = 1;
const CANARY_ALARM_THRESHOLD = 0.5;
const EVAL_ALARM_THRESHOLD = ALERT_TOP3_RECALL_THRESHOLD;

type TenantRow = { tenant_id: string };

async function listActiveTenants(): Promise<string[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_recall_golden")
    .select("tenant_id")
    .eq("active", true);
  if (error) {
    console.warn(`[memory-recall-canary] tenant scan failed: ${error.message}`);
    return [];
  }
  const seen = new Set<string>();
  for (const r of (data ?? []) as TenantRow[]) {
    if (r.tenant_id) seen.add(r.tenant_id);
  }
  return Array.from(seen);
}

async function loadGoldens(tenant_id: string, limit: number): Promise<Golden[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_recall_golden")
    .select("id, tenant_id, category, query, expected_note_ids, agent_slug, expected_order")
    .eq("tenant_id", tenant_id)
    .eq("active", true)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.warn(`[memory-recall-canary] goldens load failed tenant=${tenant_id}: ${error.message}`);
    return [];
  }
  return (data ?? []) as Golden[];
}

async function loadGoldensStratified(tenant_id: string, perCategory: number): Promise<Golden[]> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("memory_recall_golden")
    .select("id, tenant_id, category, query, expected_note_ids, agent_slug, expected_order")
    .eq("tenant_id", tenant_id)
    .eq("active", true);
  if (error) {
    console.warn(`[memory-recall-canary] stratified load failed tenant=${tenant_id}: ${error.message}`);
    return [];
  }
  const byCat = new Map<string, Golden[]>();
  for (const g of (data ?? []) as Golden[]) {
    const cat = g.category?.trim() || "uncategorized";
    const arr = byCat.get(cat) ?? [];
    arr.push(g);
    byCat.set(cat, arr);
  }
  const picked: Golden[] = [];
  for (const arr of byCat.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    picked.push(...arr.slice(0, perCategory));
  }
  return picked;
}

async function verifyTenantNotes(tenant_id: string, note_ids: string[]): Promise<Set<string>> {
  if (note_ids.length === 0) return new Set();
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("id")
    .eq("tenant_id", tenant_id)
    .in("id", note_ids);
  if (error) {
    console.warn(`[memory-recall-canary] tenant-note verify failed tenant=${tenant_id}: ${error.message}`);
    return new Set(note_ids);
  }
  return new Set((data ?? []).map((r) => (r as { id: string }).id));
}

async function runOneTenant(
  tenant_id: string,
  mode: "canary" | "eval",
): Promise<{ ran: number; alarmed: boolean }> {
  const goldens =
    mode === "canary"
      ? await loadGoldensStratified(tenant_id, CANARY_PER_CATEGORY)
      : await loadGoldens(tenant_id, EVAL_PER_TENANT_LIMIT);
  if (goldens.length === 0) {
    return { ran: 0, alarmed: false };
  }

  const threshold = mode === "canary" ? CANARY_ALARM_THRESHOLD : EVAL_ALARM_THRESHOLD;
  const result = await runMemoryRecallEval(
    { tenant_id, mode, goldens, threshold },
    {
      search: (tid, query, k, agent_slug) =>
        searchMemory(tid, query, k, { agent_slug: agent_slug ?? `memory-recall-${mode}` }),
      verifyTenantNotes,
    },
  );

  const { error: insErr } = await serviceClient().from("memory_recall_eval_run").insert({
    tenant_id,
    ran_at: new Date().toISOString(),
    queries_run: result.queries_run,
    top3_recall: result.top3_recall,
    mrr: result.mrr,
    cross_tenant_hits: result.cross_tenant_hits,
    failures: result.failures.length > 0 ? result.failures : null,
    alarmed: result.alarmed,
    run_kind: mode,
    alert_threshold_top3_recall: threshold,
  });
  if (insErr) {
    console.warn(`[memory-recall-canary] eval_run insert failed tenant=${tenant_id}: ${insErr.message}`);
  }

  if (result.alarmed) {
    const reason = result.cross_tenant_hits > 0 ? "CROSS-TENANT LEAK" : "recall below bar";
    await alert({
      source: "memory-recall-canary",
      code: result.cross_tenant_hits > 0 ? "recall_cross_tenant_leak" : "recall_below_bar",
      tenant_id,
      msg:
        `memory-recall ${mode} ${reason}: ` +
        `top3_recall=${result.top3_recall.toFixed(3)} threshold=${threshold} ` +
        `mrr=${result.mrr.toFixed(3)} queries=${result.queries_run} failures=${result.failures.length} ` +
        `cross_tenant_hits=${result.cross_tenant_hits}`,
    });
  }

  return { ran: result.queries_run, alarmed: result.alarmed };
}

async function runAllTenants(mode: "canary" | "eval"): Promise<{
  tenants: number;
  ran: number;
  alarmed: number;
}> {
  const tenants = await listActiveTenants();
  let totalRan = 0;
  let totalAlarmed = 0;
  for (const tid of tenants) {
    const res = await runOneTenant(tid, mode);
    totalRan += res.ran;
    if (res.alarmed) totalAlarmed += 1;
  }
  return { tenants: tenants.length, ran: totalRan, alarmed: totalAlarmed };
}

export const memoryRecallCanaryFn = inngest.createFunction(
  {
    id: "memory-recall-canary",
    retries: 1,
    concurrency: 1,
  },
  { cron: "15 * * * *" },
  async ({ logger }) => {
    const res = await runAllTenants("canary");
    logger.info(`memory-recall-canary: tenants=${res.tenants} ran=${res.ran} alarmed=${res.alarmed}`);
    return res;
  },
);

export const memoryRecallEvalFn = inngest.createFunction(
  {
    id: "memory-recall-eval",
    retries: 1,
    concurrency: 1,
  },
  { cron: "0 4 * * *" },
  async ({ logger }) => {
    const res = await runAllTenants("eval");
    logger.info(`memory-recall-eval: tenants=${res.tenants} ran=${res.ran} alarmed=${res.alarmed}`);
    return res;
  },
);
