
import { ExpectedToolError } from "@/services/tools/types";

export function assertNoBudgetDrift(expected_minor: number, live_minor: number): void {
  if (expected_minor !== live_minor) {
    throw new ExpectedToolError(
      "meta_ads_budget_drift",
      `Ad-set budget drifted since the agent proposed this change: expected ${expected_minor} minor units, live is ${live_minor}. Refusing.`,
    );
  }
}
