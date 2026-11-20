
import type { GoalMoves } from "./goal-owner";

export const RESEARCH_SCOPE_REASON = "research reads the public web, not your own records";

const DATA_NOUN = "(data|dataset|table|collection|records|rows|database|db|export|entries|documents)";

export function tenantRecordsNamed(intent: string, tableNames: readonly string[]): string | null {
  const text = intent.toLowerCase().replace(/[`'"]/g, "").replace(/\s+/g, " ");
  for (const raw of tableNames) {
    const name = raw.trim().toLowerCase();
    if (name.length < 3) continue;
    for (const n of new Set([name, name.replace(/[_-]+/g, " ")])) {
      const t = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const asData = new RegExp(`\\b${t} ${DATA_NOUN}\\b|\\b(records|rows|entries|documents) (from|in|of) (the |our |your )?${t}\\b`);
      if (asData.test(text)) return raw;
    }
  }
  return null;
}

export function researchScopeRefusal(objective: string, table: string): string {
  return `Work for research on "${objective}": ${RESEARCH_SCOPE_REASON} (it asked for your "${table}" data).`;
}

export function withoutTenantRecordResearch(
  moves: GoalMoves,
  objectiveOf: (goalId: string) => string,
  tableNames: readonly string[],
): { moves: GoalMoves; refused: string[]; refusedMoves: Array<{ goal_id: string; hypothesis: string | undefined }> } {
  if (tableNames.length === 0) return { moves, refused: [], refusedMoves: [] };
  const refused: string[] = [];
  const refusedMoves: Array<{ goal_id: string; hypothesis: string | undefined }> = [];
  const goals = (moves.goals ?? []).map((g) => ({
    ...g,
    moves: (g.moves ?? []).filter((m) => {
      if (String(m.target_agent_slug ?? "").trim() !== "research") return true;
      const named = tenantRecordsNamed(String(m.intent ?? ""), tableNames);
      if (!named) return true;
      refused.push(researchScopeRefusal(objectiveOf(g.goal_id), named));
      refusedMoves.push({ goal_id: g.goal_id, hypothesis: typeof m.hypothesis === "string" && m.hypothesis.trim() ? m.hypothesis.trim() : undefined });
      return false;
    }),
  }));
  return { moves: { ...moves, goals }, refused, refusedMoves };
}
