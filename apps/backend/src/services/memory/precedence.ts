
export type PrecedenceHit = {
  note_type?: string | null;
  trust_tier?: number | null;
};

export type ScoredPrecedenceHit = PrecedenceHit & { score: number };

const AGENT_DISTILLED_DECLARATIVE = new Set(["tenant_reference", "tenant_project"]);

const FLOOR_EXEMPT_OPERATOR_AUTHORED_TYPES = new Set([
  "operator_preference",
  "anchor",
  "correction",
]);

export function precedenceRank(h: PrecedenceHit): 0 | 1 | 2 | 3 | 4 {
  const tier = h.trust_tier ?? 2;
  if (tier >= 3) return 4;
  if (tier <= 0) return 0;
  if (h.note_type && FLOOR_EXEMPT_OPERATOR_AUTHORED_TYPES.has(h.note_type)) return 0;
  if (tier === 1) return 1;
  if (h.note_type && AGENT_DISTILLED_DECLARATIVE.has(h.note_type)) return 2;
  return 3;
}

export function precedenceBucket(h: PrecedenceHit): 0 | 1 {
  return precedenceRank(h) <= 2 ? 0 : 1;
}

export function applyTrustTierPrecedence<T extends PrecedenceHit>(hits: T[]): void {
  hits.sort((a, b) => precedenceRank(a) - precedenceRank(b));
}

function isFloorExempt(h: PrecedenceHit): boolean {
  const tier = h.trust_tier ?? 2;
  if (tier <= 1) return true;
  return !!h.note_type && FLOOR_EXEMPT_OPERATOR_AUTHORED_TYPES.has(h.note_type);
}

export function applyRelevanceFloor<T extends ScoredPrecedenceHit>(
  hits: T[],
  floor: number,
): T[] {
  if (!(floor > 0)) return hits;
  return hits.filter((h) => h.score >= floor || isFloorExempt(h));
}
