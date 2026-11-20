
export const ALERT_TOP3_RECALL_THRESHOLD = 0.85;
export const RECALL_EVAL_K = 8;

export type Golden = {
  id: string;
  tenant_id: string;
  category?: string;
  query: string;
  expected_note_ids: string[];
  agent_slug?: string | null;
  expected_order?: string[];
};

export type RecallEvalOutcome = {
  golden_id: string;
  query: string;
  expected: string[];
  returned_note_ids_top3: string[];
  hit: boolean;
};

export type RecallEvalResult = {
  tenant_id: string;
  mode: "canary" | "eval";
  queries_run: number;
  top3_recall: number;
  mrr: number;
  cross_tenant_hits: number;
  failures: RecallEvalOutcome[];
  alarmed: boolean;
};

export type RecallEvalDeps = {
  search: (
    tenant_id: string,
    query: string,
    k: number,
    agent_slug?: string | null,
  ) => Promise<Array<{ note_id: string }>>;
  verifyTenantNotes: (tenant_id: string, note_ids: string[]) => Promise<Set<string>>;
};

export function orderHolds(returnedIds: string[], order: string[]): boolean {
  let cursor = -1;
  for (const id of order) {
    const idx = returnedIds.indexOf(id);
    if (idx < 0 || idx <= cursor) return false;
    cursor = idx;
  }
  return true;
}

export async function runMemoryRecallEval(
  args: {
    tenant_id: string;
    mode: "canary" | "eval";
    goldens: Golden[];
    threshold?: number;
  },
  deps: RecallEvalDeps,
): Promise<RecallEvalResult> {
  const { tenant_id, mode, goldens } = args;
  const threshold = args.threshold ?? ALERT_TOP3_RECALL_THRESHOLD;
  const outcomes: RecallEvalOutcome[] = [];
  let hits = 0;
  let mrrSum = 0;
  let positiveCount = 0;
  let crossTenantHits = 0;

  for (const g of goldens) {
    let searchHits: Array<{ note_id: string }> = [];
    try {
      searchHits = await deps.search(tenant_id, g.query, RECALL_EVAL_K, g.agent_slug ?? null);
    } catch {
      searchHits = [];
    }

    const returnedIds = searchHits.map((h) => h.note_id);
    const top3 = returnedIds.slice(0, 3);
    const expected = g.expected_note_ids ?? [];

    const isOrder = (g.expected_order?.length ?? 0) > 0;
    const isNegative = !isOrder && expected.length === 0;
    const hit = isOrder
      ? orderHolds(returnedIds, g.expected_order as string[])
      : isNegative
        ? returnedIds.length === 0
        : expected.some((eid) => top3.includes(eid));
    if (hit) hits += 1;

    const isPositive = !isNegative && !isOrder;
    if (isPositive) {
      positiveCount += 1;
      const firstRank = searchHits.findIndex((h) => expected.includes(h.note_id));
      if (firstRank >= 0) mrrSum += 1 / (firstRank + 1);
    }

    if (returnedIds.length > 0) {
      let owned: Set<string>;
      try {
        owned = await deps.verifyTenantNotes(tenant_id, returnedIds);
      } catch {
        owned = new Set(returnedIds);
      }
      for (const id of returnedIds) {
        if (!owned.has(id)) crossTenantHits += 1;
      }
    }

    outcomes.push({
      golden_id: g.id,
      query: g.query,
      expected,
      returned_note_ids_top3: top3,
      hit,
    });
  }

  const n = goldens.length;
  const top3_recall = n > 0 ? hits / n : 0;
  const mrr = positiveCount > 0 ? mrrSum / positiveCount : 0;
  const alarmed = (n > 0 && top3_recall < threshold) || crossTenantHits > 0;

  return {
    tenant_id,
    mode,
    queries_run: n,
    top3_recall: Number(top3_recall.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    cross_tenant_hits: crossTenantHits,
    failures: outcomes.filter((o) => !o.hit),
    alarmed,
  };
}
