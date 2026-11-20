
import { serviceClient } from "@/services/supabase";

const PREDICTION_REGEXES: RegExp[] = [
  /\b(will|expect to|expected to|should|likely to)\s+\S+[^.]{0,180}?\b(by|within)\s+(\d+\s+(?:days?|weeks?|months?)|next\s+(?:week|month|quarter)|end of (?:week|month|quarter))/gi,
  /\b(forecasts?|projects?)\s+\S+[^.]{0,180}?\b(by|in)\s+(\d+\s+(?:days?|weeks?))/gi,
];

const CLAIM_TEXT_CAP = 280;
const AUDIT_LEAD_DAYS = 7;

export type RecordPredictionsParams = {
  tenant_id: string;
  agent_run_id: string;
  agent_slug: string;
  output_text: string;
};

export async function recordPredictions(params: RecordPredictionsParams): Promise<{ count: number }> {
  try {
    const text = params.output_text ?? "";
    if (!text || text.length < 12) return { count: 0 };

    const matches = new Set<string>();
    for (const re of PREDICTION_REGEXES) {
      for (const m of text.matchAll(re)) {
        const snippet = (m[0] ?? "").trim().slice(0, CLAIM_TEXT_CAP);
        if (snippet.length >= 12) matches.add(snippet);
      }
    }
    if (matches.size === 0) return { count: 0 };

    const auditDueAt = new Date(Date.now() + AUDIT_LEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const rows = Array.from(matches).map((claim_text) => ({
      tenant_id: params.tenant_id,
      agent_run_id: params.agent_run_id,
      agent_slug: params.agent_slug,
      claim_text,
      audit_due_at: auditDueAt,
    }));

    const { error } = await serviceClient()
      .from("agent_prediction_signals")
      .insert(rows);
    if (error) {
      console.warn(
        `[predictions] recordPredictions failed for run=${params.agent_run_id}: ${error.message}`,
      );
      return { count: 0 };
    }
    return { count: rows.length };
  } catch (e) {
    console.warn(
      `[predictions] recordPredictions threw for run=${params.agent_run_id}: ${(e as Error).message}`,
    );
    return { count: 0 };
  }
}
