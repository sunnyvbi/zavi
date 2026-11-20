
import { inngest } from "../client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { runEmailPlanPass } from "@/services/email-plan/pass";
import { livePlanPassDeps } from "@/services/email-plan/live";

export async function runEmailPlanTick() {
  if (isWorkerCronStopped("email-plan-tick")) return { cron_stopped: true as const };
  return runEmailPlanPass(await livePlanPassDeps());
}

export const emailPlanTickFn = inngest.createFunction(
  { id: "email-plan-tick", retries: 0, concurrency: { limit: 1 } },
  { cron: "*/5 * * * *" },
  async ({ step }) => step.run("plan-pass", () => runEmailPlanTick()),
);
