
export const RECALL_EVAL_K = 8;

export function orderHolds(returnedIds, order) {
  let cursor = -1;
  for (const id of order) {
    const idx = returnedIds.indexOf(id);
    if (idx < 0 || idx <= cursor) return false;
    cursor = idx;
  }
  return true;
}

export async function scoreRecall({ goldens, search }) {
  const outcomes = [];
  let hits = 0;
  let mrrSum = 0;
  let positiveCount = 0;

  for (const g of goldens) {
    let searchHits = [];
    try {
      searchHits = await search(g.query, RECALL_EVAL_K, g.agent_slug ?? null);
    } catch {
      searchHits = [];
    }

    const returnedIds = searchHits.map((h) => h.note_id);
    const top3 = returnedIds.slice(0, 3);
    const expected = g.expected_note_ids ?? [];

    const isOrder = (g.expected_order?.length ?? 0) > 0;
    const isNegative = !isOrder && expected.length === 0;
    const hit = isOrder
      ? orderHolds(returnedIds, g.expected_order)
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

    outcomes.push({
      golden_id: g.id,
      query: g.query,
      type: g.type ?? "fact",
      expected,
      returned_note_ids_top3: top3,
      hit,
    });
  }

  const n = goldens.length;
  const top3_recall = n > 0 ? hits / n : 0;
  const mrr = positiveCount > 0 ? mrrSum / positiveCount : 0;

  return {
    queries_run: n,
    top3_recall: Number(top3_recall.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    outcomes,
    failures: outcomes.filter((o) => !o.hit),
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "done",
  "has", "have", "had", "can", "could", "will", "would", "should", "may", "might",
  "what", "who", "whom", "whose", "when", "where", "why", "how", "which", "that",
  "this", "these", "those", "it", "its", "they", "them", "their", "you", "your",
  "i", "we", "us", "our", "as", "if", "so", "than", "then", "from", "about",
  "into", "out", "up", "down", "over", "under", "get", "got", "much", "many",
]);

export function makeLexicalCosineSearch(corpus) {
  const tokenize = (s) =>
    ((s || "").toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((t) => !STOPWORDS.has(t))
      .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
  const docs = corpus.map((n) => {
    const counts = new Map();
    for (const t of tokenize(`${n.title ?? ""} ${n.body ?? ""}`)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let norm = 0;
    for (const c of counts.values()) norm += c * c;
    return { note_id: n.note_id, body: n.body ?? "", counts, norm: Math.sqrt(norm) || 1 };
  });

  return async (query, k = RECALL_EVAL_K) => {
    const q = new Map();
    for (const t of tokenize(query)) q.set(t, (q.get(t) ?? 0) + 1);
    let qNorm = 0;
    for (const c of q.values()) qNorm += c * c;
    qNorm = Math.sqrt(qNorm) || 1;

    const scored = docs.map((d) => {
      let dot = 0;
      for (const [t, c] of q) dot += c * (d.counts.get(t) ?? 0);
      return { note_id: d.note_id, body: d.body, score: dot / (qNorm * d.norm) };
    });
    scored.sort((a, b) => b.score - a.score || a.note_id.localeCompare(b.note_id));
    return scored.filter((s) => s.score > 0).slice(0, k);
  };
}
