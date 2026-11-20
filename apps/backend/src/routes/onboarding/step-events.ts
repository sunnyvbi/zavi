
import { serviceClient } from "@/services/supabase";

export type OnboardingStepStatus = "entered" | "completed" | "skipped" | "abandoned";

export const ONBOARDING_STEP_STATUSES: readonly OnboardingStepStatus[] = [
  "entered",
  "completed",
  "skipped",
  "abandoned",
];

export async function logOnboardingStep(args: {
  tenantId: string | null;
  userId: string | null;
  step: string;
  status?: OnboardingStepStatus;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { tenantId, userId, step } = args;
  const status: OnboardingStepStatus = args.status ?? "entered";
  const meta = args.meta ?? {};

  try {
    const { error } = await serviceClient().from("onboarding_step_events").insert({
      tenant_id: tenantId,
      user_id: userId,
      step,
      status,
      meta,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[onboarding/step-events] insert failed for tenant ${tenantId} step ${step}/${status}: ${error.message}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[onboarding/step-events] insert threw for tenant ${tenantId} step ${step}/${status}: ${(e as Error).message}`,
    );
  }
}
