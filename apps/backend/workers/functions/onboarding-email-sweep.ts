
import { inngest } from "../client";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { isCanonicalContainer } from "@/services/agents/boot-role";
import { sweepDueSequences } from "@/services/onboarding-emails/sequence";
import { sweepPlanReadyEmails } from "@/services/growth/plan-ready-email";

export async function runOnboardingEmailSweep(now: Date = new Date()) {
  if (isWorkerCronStopped("onboarding-email-sweep")) return { cron_stopped: true as const };
  return sweepDueSequences(now);
}

export async function runPlanReadySweep(now: Date = new Date()) {
  if (isWorkerCronStopped("onboarding-email-sweep")) return { cron_stopped: true as const };
  return sweepPlanReadyEmails(now);
}

export const onboardingEmailSweepFn = inngest.createFunction(
  { id: "onboarding-email-sweep", retries: 1 },
  { cron: "23 * * * *" },
  async ({ step }) => {
    if (!isCanonicalContainer()) return { skipped: "not_canonical" as const };
    const sequences = await step.run("sweep", () => runOnboardingEmailSweep());
    const planReady = await step.run("plan-ready-sweep", () => runPlanReadySweep());
    return { sequences, planReady };
  },
);
