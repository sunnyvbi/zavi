
import { inngest } from "../client";
import { groundRecentScoredRuns, type ScorerLogger } from "@/services/eval/run-scorer";

const BATCH = Number(process.env.NEG_EXISTENCE_GROUND_BATCH ?? 20);

export async function runNegExistenceGroundHandler(
  logger: ScorerLogger,
): Promise<{
  enabled: boolean;
  candidates: number;
  grounded: number;
  clamped: number;
  skipped: number;
}> {
  return groundRecentScoredRuns(logger, BATCH);
}

export const negExistenceGroundFn = inngest.createFunction(
  { id: "neg-existence-ground", concurrency: 1 },
  [{ cron: "*/30 * * * *" }, { event: "eval/ground.requested" }],
  async () => {
    return runNegExistenceGroundHandler({
      info: (s) => console.info(`[neg-existence-ground] ${s}`),
      warn: (s) => console.warn(`[neg-existence-ground] ${s}`),
    });
  },
);
