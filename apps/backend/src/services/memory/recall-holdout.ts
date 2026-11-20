
import { serviceClient } from "@/services/supabase";
import { searchMemory } from "@/services/memory";
import { verifyTenantNotes } from "@/services/memory/recall-metrics";
import {
  runMemoryRecallEval,
  RECALL_EVAL_K,
  type Golden,
  type RecallEvalDeps,
} from "@/services/memory/recall-eval";

const OVER_K = 32;

const ON_DEMAND_WINDOW_DAYS = 30;
const ON_DEMAND_FETCH_LIMIT = 200;
const ON_DEMAND_MAX_CASES = 10;

export type DreamVerdict = "KEEP_NEW" | "KEEP_OLD" | "MERGE" | "NO_CONFLICT";

export type RecallHoldoutStatus =
  | "improved"
  | "regressed"
  | "neutral"
  | "no_goldens"
  | "unmeasured"
  | "error";

export type RecallHoldoutCandidate = {
  verdict: DreamVerdict;
  new_note_id: string;
  existing_note_id: string;
};

export type RecallHoldoutResult = {
  eval_status: RecallHoldoutStatus;
  recall_before: number | null;
  recall_after: number | null;
  top3_delta: number | null;
  regressed_golden_count: number | null;
  cross_tenant_hits: number | null;
  n_goldens: number | null;
};

export type RecallHoldoutDeps = {
  loadGoldens: (tenantId: string) => Promise<Golden[]>;
  loadOnDemandGoldens: (tenantId: string, supersededNoteId: string) => Promise<Golden[]>;
  search: RecallEvalDeps["search"];
  verifyTenantNotes: RecallEvalDeps["verifyTenantNotes"];
};

const NULL_RESULT: Omit<RecallHoldoutResult, "eval_status"> = {
  recall_before: null,
  recall_after: null,
  top3_delta: null,
  regressed_golden_count: null,
  cross_tenant_hits: null,
  n_goldens: null,
};

async function loadGoldensForTenant(tenantId: string): Promise<Golden[]> {
  const { data, error } = await serviceClient()
    .from("memory_recall_golden")
    .select("id, tenant_id, category, query, expected_note_ids, agent_slug, expected_order")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  if (error) {
    throw new Error(`[recall-holdout] goldens load failed tenant=${tenantId}: ${error.message}`);
  }
  return (data ?? []) as Golden[];
}

const prodSearch: RecallEvalDeps["search"] = async (tenant_id, query, k, agent_slug) => {
  const hits = await searchMemory(tenant_id, query, Math.max(k, OVER_K), {
    agent_slug: agent_slug ?? null,
  });
  const seen = new Set<string>();
  const deduped: Array<{ note_id: string }> = [];
  for (const h of hits as Array<{ note_id: string }>) {
    if (h.note_id && !seen.has(h.note_id)) {
      seen.add(h.note_id);
      deduped.push({ note_id: h.note_id });
    }
  }
  return deduped;
};

async function loadOnDemandGoldensForTenant(
  tenantId: string,
  supersededNoteId: string,
): Promise<Golden[]> {
  const sb = serviceClient();
  const since = new Date(Date.now() - ON_DEMAND_WINDOW_DAYS * 86_400_000).toISOString();

  const { data, error } = await sb
    .from("eval_candidates")
    .select("query, agent_slug, retrieved_note_ids, run_id")
    .eq("tenant_id", tenantId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(ON_DEMAND_FETCH_LIMIT);
  if (error) {
    throw new Error(`[recall-holdout] eval_candidates load failed tenant=${tenantId}: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    query: string;
    agent_slug: string | null;
    retrieved_note_ids: string[] | null;
    run_id: string | null;
  }>;

  const matches = rows.filter(
    (r) => r.run_id && Array.isArray(r.retrieved_note_ids) && r.retrieved_note_ids.includes(supersededNoteId),
  );
  if (matches.length === 0) return [];

  const runIds = Array.from(new Set(matches.map((r) => r.run_id as string)));
  const { data: runs, error: runErr } = await sb
    .from("agent_runs")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .in("id", runIds);
  if (runErr) {
    throw new Error(`[recall-holdout] agent_runs success check failed tenant=${tenantId}: ${runErr.message}`);
  }
  const successIds = new Set(
    ((runs ?? []) as Array<{ id: string; status: string }>)
      .filter((r) => r.status === "success")
      .map((r) => r.id),
  );

  const seenQuery = new Set<string>();
  const goldens: Golden[] = [];
  for (const r of matches) {
    if (!successIds.has(r.run_id as string)) continue;
    if (seenQuery.has(r.query)) continue;
    seenQuery.add(r.query);
    goldens.push({
      id: `ondemand:${goldens.length}`,
      tenant_id: tenantId,
      query: r.query,
      expected_note_ids: [supersededNoteId],
      agent_slug: r.agent_slug ?? null,
    });
    if (goldens.length >= ON_DEMAND_MAX_CASES) break;
  }
  return goldens;
}

const PROD_DEPS: RecallHoldoutDeps = {
  loadGoldens: loadGoldensForTenant,
  loadOnDemandGoldens: loadOnDemandGoldensForTenant,
  search: prodSearch,
  verifyTenantNotes,
};

export async function runRecallHoldout(
  args: { tenantId: string; candidate: RecallHoldoutCandidate },
  deps: RecallHoldoutDeps = PROD_DEPS,
): Promise<RecallHoldoutResult> {
  const { tenantId, candidate } = args;

  if (candidate.verdict === "MERGE" || candidate.verdict === "NO_CONFLICT") {
    return { eval_status: "unmeasured", ...NULL_RESULT };
  }

  const supersededId =
    candidate.verdict === "KEEP_NEW" ? candidate.existing_note_id : candidate.new_note_id;

  let goldens: Golden[];
  try {
    goldens = await deps.loadGoldens(tenantId);
  } catch {
    return { eval_status: "error", ...NULL_RESULT };
  }
  if (goldens.length === 0) {
    try {
      goldens = await deps.loadOnDemandGoldens(tenantId, supersededId);
    } catch {
      return { eval_status: "error", ...NULL_RESULT };
    }
    if (goldens.length === 0) {
      return { eval_status: "no_goldens", ...NULL_RESULT, n_goldens: 0 };
    }
  }

  let depErrored = false;
  const verify: RecallEvalDeps["verifyTenantNotes"] = async (tid, ids) => {
    try {
      return await deps.verifyTenantNotes(tid, ids);
    } catch {
      depErrored = true;
      return new Set(ids);
    }
  };
  const baseSearch: RecallEvalDeps["search"] = async (tid, query, k, agent_slug) => {
    try {
      return await deps.search(tid, query, k, agent_slug);
    } catch {
      depErrored = true;
      return [];
    }
  };
  const overlaySearch: RecallEvalDeps["search"] = async (tid, query, k, agent_slug) => {
    const hits = await baseSearch(tid, query, k, agent_slug);
    return hits.filter((h) => h.note_id !== supersededId);
  };

  const before = await runMemoryRecallEval(
    { tenant_id: tenantId, mode: "eval", goldens },
    { search: baseSearch, verifyTenantNotes: verify },
  );
  const after = await runMemoryRecallEval(
    { tenant_id: tenantId, mode: "eval", goldens },
    { search: overlaySearch, verifyTenantNotes: verify },
  );

  if (depErrored) {
    return { eval_status: "error", ...NULL_RESULT, n_goldens: goldens.length };
  }

  const recall_before = before.top3_recall;
  const recall_after = after.top3_recall;
  const top3_delta = Number((recall_after - recall_before).toFixed(4));
  const cross_tenant_hits = Math.max(before.cross_tenant_hits, after.cross_tenant_hits);

  const missedBefore = new Set(before.failures.map((f) => f.golden_id));
  const regressed_golden_count = after.failures.filter(
    (f) => !missedBefore.has(f.golden_id),
  ).length;

  let eval_status: RecallHoldoutStatus;
  if (cross_tenant_hits > 0) {
    eval_status = "regressed";
  } else if (regressed_golden_count > 0 || top3_delta < 0) {
    eval_status = "regressed";
  } else if (top3_delta > 0) {
    eval_status = "improved";
  } else {
    eval_status = "neutral";
  }

  return {
    eval_status,
    recall_before,
    recall_after,
    top3_delta,
    regressed_golden_count,
    cross_tenant_hits,
    n_goldens: goldens.length,
  };
}

export const __test__ = {
  OVER_K,
  ON_DEMAND_MAX_CASES,
  loadGoldensForTenant,
  loadOnDemandGoldensForTenant,
};
