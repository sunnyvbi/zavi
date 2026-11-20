
import { isPreviewAllowedTool } from "./preview-tools";

export const DONE_FOR_YOU_MAX_CREDITS = 1000;
const CREDIT_USD = 0.0025;
export const DONE_FOR_YOU_MAX_BUDGET_USD = DONE_FOR_YOU_MAX_CREDITS * CREDIT_USD;

export function isDoneForYouAllowedTool(name: string): boolean {
  return isPreviewAllowedTool(name, { keepCards: true });
}

export const DONE_FOR_YOU_TOOL_DENIED_REASON =
  "This tool is not available on this run; the call was not executed. Do the work with the read tools you have and put the finished result in the step.";

export function withDoneForYouBudget(options: Record<string, unknown>, doneForYou: boolean): Record<string, unknown> {
  if (!doneForYou) return options;
  const own = typeof options.maxBudgetUsd === "number" && options.maxBudgetUsd > 0 ? options.maxBudgetUsd : Infinity;
  return { ...options, maxBudgetUsd: Math.min(own, DONE_FOR_YOU_MAX_BUDGET_USD) };
}
