
export const QA_INFLIGHT_STALE_MS = 2 * 60 * 60 * 1000;

export function qaInflightCutoffISO(now: number = Date.now()): string {
  return new Date(now - QA_INFLIGHT_STALE_MS).toISOString();
}
