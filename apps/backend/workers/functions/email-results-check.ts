
import { inngest } from "../client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { liveCheckDeps, runEmailResultsPass } from "@/services/email-results/check";
import { runEmailLearnPass } from "@/services/email-learnings/worker";

export async function runEmailResultsCheckTick() {
  if (isWorkerCronStopped("email-results-check")) return { cron_stopped: true as const };
  return runEmailResultsPass(await liveCheckDeps());
}

export async function runEmailLearnTick() {
  if (isWorkerCronStopped("email-results-check")) return { cron_stopped: true as const };
  try {
    return await runEmailLearnPass();
  } catch (e) {
    console.warn(`[email-learnings] pass failed: ${(e as Error)?.message ?? "unknown"}`);
    return { failed: true as const };
  }
}

export const emailResultsCheckFn = inngest.createFunction(
  { id: "email-results-check", retries: 0, concurrency: { limit: 1 } },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    const checks = await step.run("check-backs", () => runEmailResultsCheckTick());
    const learn = await step.run("learnings", () => runEmailLearnTick());
    return { checks, learn };
  },
);
