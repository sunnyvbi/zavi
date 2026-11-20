export function firstGoalReviewKey(tenant_id: string): string {
  return `${tenant_id}:cgo-first-review`;
}

export function firstGoalReviewRetryKey(tenant_id: string): string {
  return `${firstGoalReviewKey(tenant_id)}:retry`;
}
