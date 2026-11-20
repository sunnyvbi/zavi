
export type CanaryOutcome = "pass" | "fail" | "skipped";

export const ABSTAIN_MAX_SCORE = 0.35;

export const ABSTENTION_PROBES = [
  "ZX-QUARTZ-417 procurement policy for lunar freight contracts",
  "What is our KESTREL-OBLONG-902 warranty on submarine hull plating?",
];

export function scoreKnowledgeUpdate(
  hits: ReadonlyArray<{ note_id: string }>,
  newNoteId: string,
  oldNoteId: string,
): CanaryOutcome {
  const ids = new Set(hits.map((h) => h.note_id));
  if (ids.has(oldNoteId)) return "fail";
  return ids.has(newNoteId) ? "pass" : "fail";
}

export function scoreAbstention(hits: ReadonlyArray<{ score: number }>): CanaryOutcome {
  return hits.every((h) => h.score < ABSTAIN_MAX_SCORE) ? "pass" : "fail";
}

export function paraphraseDuplicateRate(m: { added: number; duplicate: number; updated: number; conflict: number }): number {
  const denom = m.added + m.duplicate + m.updated + m.conflict;
  return denom === 0 ? 0 : m.duplicate / denom;
}
