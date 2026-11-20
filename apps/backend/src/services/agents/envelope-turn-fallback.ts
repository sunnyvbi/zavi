const TURN_FALLBACK_ENVELOPES: ReadonlySet<string> = new Set(["pr_proposal"]);

function isWellFormedPayload(body: string): boolean {
  let payload = body.trim();
  const fence = payload.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) payload = fence[1];
  try {
    const v: unknown = JSON.parse(payload);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function latestTurnEnvelopeMatch(
  turns: readonly string[],
  envelope: string,
  re: RegExp,
): { match: RegExpMatchArray; turnIndex: number } | null {
  if (!TURN_FALLBACK_ENVELOPES.has(envelope)) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = (turns[i] ?? "").match(re);
    if (m && isWellFormedPayload(m[1])) return { match: m, turnIndex: i };
  }
  return null;
}
