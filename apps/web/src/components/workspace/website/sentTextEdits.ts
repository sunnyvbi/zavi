const sentByApp = new Map<string, Set<string>>();

export function markTextEditsSent(appId: string, selectors: readonly string[]): void {
  if (selectors.length === 0) return;
  const sent = sentByApp.get(appId) ?? new Set<string>();
  for (const selector of selectors) sent.add(selector);
  sentByApp.set(appId, sent);
}

export function forgetSentTextEdit(appId: string, selector: string): void {
  sentByApp.get(appId)?.delete(selector);
}

export function clearSentTextEdits(appId: string): void {
  sentByApp.delete(appId);
}

export function unsentTextEdits(appId: string, selectors: readonly string[]): string[] {
  const sent = sentByApp.get(appId);
  const unique = [...new Set(selectors)];
  return sent ? unique.filter((selector) => !sent.has(selector)) : unique;
}
