
import { isInternalTenant } from "./mixpanel";

const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const TIMEOUT_MS = 5_000;

type PlanStageProps = {
  outcome?: string;
  step_index?: number;
  first_plan?: boolean;
};

export function capturePlanStage(tenant_id: string, run_id: string | null, stage: string, ms: number, props: PlanStageProps = {}): void {
  const api_key = process.env.POSTHOG_PROJECT_KEY;
  if (!api_key) return;
  void (async () => {
    try {
      const res = await fetch(CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          api_key,
          event: "plan_build_stage",
          distinct_id: tenant_id,
          properties: {
            stage,
            ms,
            tenant_id,
            run_id,
            is_internal: isInternalTenant(tenant_id),
            outcome: props.outcome,
            step_index: props.step_index,
            first_plan: props.first_plan,
            $process_person_profile: false,
          },
        }),
      });
      if (!res.ok) console.warn(`[posthog] plan_build_stage failed: ${res.status}`);
    } catch (e) {
      console.warn(`[posthog] plan_build_stage failed: ${(e as Error).name}`);
    }
  })();
}
