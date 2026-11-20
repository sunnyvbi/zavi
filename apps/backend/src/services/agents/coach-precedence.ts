
export const COVER_ACTIONS = ["set_goal", "bake_rule", "enrich_memory", "answer", "manual_resolve"] as const;
export type CoverAction = (typeof COVER_ACTIONS)[number];

type ConductorNode = { payload?: { goal_id?: string | null } | null } & Record<string, unknown>;

export function extractPrimaryGoalId(goalGraph: unknown): string | null {
  if (!Array.isArray(goalGraph)) return null;
  for (const node of goalGraph as ConductorNode[]) {
    const gid = node?.payload?.goal_id;
    if (typeof gid === "string" && gid.length > 0) return gid;
  }
  return null;
}

export type ConductorRunRef = { id: string; goalId: string | null };

export function selectAgentProposedRunIds(
  runs: ReadonlyArray<ConductorRunRef>,
  sourceById: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const r of runs) {
    if (!r.goalId) continue;
    const src = sourceById.get(r.goalId);
    if (src === "agent_proposed") out.push(r.id);
  }
  return out;
}
