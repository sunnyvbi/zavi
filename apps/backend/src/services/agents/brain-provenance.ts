
type CitedNotes = Map<string, { title: string; score: number }>;

type MaybeHit = {
  note_id?: unknown;
  title?: unknown;
  score?: unknown;
  note_type?: unknown;
};

export function captureBrainProvenance(
  citedNotes: CitedNotes,
  server_id: string,
  tool_name: string,
  isError: boolean,
  resultContent: string,
): void {
  if (server_id !== "memory" || tool_name !== "search" || isError) return;
  try {
    const parsed = JSON.parse(resultContent) as { hits?: unknown };
    const hits = Array.isArray(parsed?.hits) ? (parsed.hits as MaybeHit[]) : [];
    for (const h of hits) {
      if (typeof h?.note_type !== "string" || h.note_type === "anchor") continue;
      if (typeof h.note_id !== "string" || typeof h.title !== "string") continue;
      const score = typeof h.score === "number" ? h.score : 0;
      const prev = citedNotes.get(h.note_id);
      if (!prev || score > prev.score) {
        citedNotes.set(h.note_id, { title: h.title, score });
      }
    }
  } catch {
  }
}

export function mergeBrainProvenance(
  body: unknown,
  citedNotes: CitedNotes,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {};
  delete base.brain_citations;
  const brain_citations = Array.from(citedNotes.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5)
    .map(([note_id, v]) => ({ note_id, title: v.title }));
  if (brain_citations.length > 0) base.brain_citations = brain_citations;
  return base;
}
