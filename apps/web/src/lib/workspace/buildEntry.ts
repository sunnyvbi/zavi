
export function pickBuildEntry(
  boundSessionId: string | null,
  currentSessionId: string | null,
  sessionsLoaded: boolean,
): string | null {
  if (boundSessionId) return boundSessionId;
  if (sessionsLoaded && currentSessionId) return currentSessionId;
  return null;
}

export function buildThreadOnOpen(
  prevSessionId: string | null | undefined,
  nextSessionId: string | null,
  boundThreadId: string | null | undefined,
): string | null {
  if (prevSessionId === nextSessionId) return boundThreadId ?? null;
  return null;
}
