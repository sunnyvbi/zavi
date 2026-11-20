import type { AdRecommendation } from "@zavi/shared";
import { record } from "./version";

export function recommendation(row: { status: string; blocking: boolean; exec_status: string | null; score_inputs: unknown; impact: number | null; score: number }): AdRecommendation | null {
  if (row.status !== "pending" || row.blocking || row.exec_status || !record(row.score_inputs)) return null;
  const { goal_fit, previously_rejected } = row.score_inputs;
  if (goal_fit !== 1 || previously_rejected === true || row.impact === null || row.impact < 4 || row.score < 70) return null;
  return { reason: `Matches your selected goal, with saved predicted impact ${row.impact}/5 and action ranking ${Math.round(row.score)}/100. Ranking can include budget at stake; this is not measured ad performance.` };
}
