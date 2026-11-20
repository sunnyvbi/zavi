
export const DEFERRED_DECISIONS_VIEW = "customer_visible_deferred_decisions";
export const DEFERRED_CHANNEL_ACTIONS_VIEW = "customer_visible_deferred_channel_actions";
export const DECLINED_DECISIONS_VIEW = "customer_visible_declined_decisions";

export type ReadableClient = { from: (table: string) => unknown };

type SelectBuilder = {
  select: (columns: string) => {
    eq: (column: string, value: string) => SelectFilter;
  };
};
type SelectFilter = {
  eq: (column: string, value: string) => SelectFilter;
  limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

type NotDoneDecision = {
  agent_run_id: string | null;
  origin_run_id: string | null;
};

type NotDoneChannelAction = { run_id: string | null };

export function countByRun(runIds: ReadonlyArray<string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of runIds) {
    if (!id) continue;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

export function decisionRunsByCount(
  rows: ReadonlyArray<NotDoneDecision>,
  runIdOf: (row: NotDoneDecision) => string | null,
): Record<string, number> {
  return countByRun(rows.map(runIdOf));
}

export async function readNotDoneDecisionCounts(
  sb: ReadableClient,
  view: string,
  tenantId: string,
  runIdOf: (row: NotDoneDecision) => string | null,
  cap: number,
): Promise<Record<string, number>> {
  try {
    const { data, error } = await (sb.from(view) as SelectBuilder)
      .select("agent_run_id, origin_run_id:body->>origin_run_id")
      .eq("tenant_id", tenantId)
      .limit(cap);
    if (error || !Array.isArray(data)) {
      if (error) {
        console.warn(
          `[approvals/not-done] ${view} read failed for ${tenantId}: ${
            (error as { message?: string }).message ?? String(error)
          }`,
        );
      }
      return {};
    }
    return decisionRunsByCount(data as NotDoneDecision[], runIdOf);
  } catch (e) {
    console.warn(`[approvals/not-done] ${view} read threw for ${tenantId}: ${(e as Error).message}`);
    return {};
  }
}

export async function readDeferredChannelActionCounts(
  sb: ReadableClient,
  tenantId: string,
  cap: number,
): Promise<Record<string, number>> {
  try {
    const { data, error } = await (sb.from(DEFERRED_CHANNEL_ACTIONS_VIEW) as SelectBuilder)
      .select("run_id")
      .eq("tenant_id", tenantId)
      .limit(cap);
    if (error || !Array.isArray(data)) {
      if (error) {
        console.warn(
          `[approvals/not-done] channel actions read failed for ${tenantId}: ${
            (error as { message?: string }).message ?? String(error)
          }`,
        );
      }
      return {};
    }
    return countByRun((data as NotDoneChannelAction[]).map((r) => r.run_id));
  } catch (e) {
    console.warn(
      `[approvals/not-done] channel actions read threw for ${tenantId}: ${(e as Error).message}`,
    );
    return {};
  }
}

export function mergeNotDoneCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [runId, n] of Object.entries(b)) out[runId] = (out[runId] ?? 0) + n;
  return out;
}
