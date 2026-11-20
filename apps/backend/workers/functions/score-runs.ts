
import { inngest } from "../client";
import { scoreRecentUnscoredRuns, type ScorerLogger } from "@/services/eval/run-scorer";

const BATCH = Number(process.env.RUN_SCORER_BATCH ?? 20);

export async function runScoreRunsHandler(
  logger: ScorerLogger,
): Promise<{ enabled: boolean; scored: number; skipped: number; candidates: number }> {
  return scoreRecentUnscoredRuns(logger, BATCH);
}

export const scoreRunsFn = inngest.createFunction(
  { id: "score-runs", concurrency: 1 },
  [{ cron: "*/30 * * * *" }, { event: "eval/score-runs.requested" }],
  async () => {
    return runScoreRunsHandler({
      info: (s) => console.info(`[score-runs] ${s}`),
      warn: (s) => console.warn(`[score-runs] ${s}`),
    });
  },
);
