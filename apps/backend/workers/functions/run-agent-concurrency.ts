
export const RUN_AGENT_CONCURRENCY_DEFAULT = 8;

export function resolveRunAgentGlobalConcurrency(
  raw: string | undefined = process.env.RUN_AGENT_CONCURRENCY,
): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : RUN_AGENT_CONCURRENCY_DEFAULT;
}

export const RUN_AGENT_BACKGROUND_RESERVE_DEFAULT = 2;

export function resolveBackgroundReserve(
  raw: string | undefined = process.env.RUN_AGENT_BACKGROUND_RESERVE,
  globalLimit: number = resolveRunAgentGlobalConcurrency(),
): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const reserve =
    Number.isFinite(n) && n >= 0 ? n : RUN_AGENT_BACKGROUND_RESERVE_DEFAULT;
  return Math.min(reserve, Math.max(0, globalLimit - 1));
}
