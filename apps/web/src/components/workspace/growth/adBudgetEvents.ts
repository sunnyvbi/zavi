
export const AD_BUDGET_CHANGED_EVENT = "zavi:ad-budget-changed";

export function announceAdBudgetChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AD_BUDGET_CHANGED_EVENT));
}
