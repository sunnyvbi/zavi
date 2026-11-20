
export const DECISION_STATUS_ACTED = "acted";

export const DECISION_STATUS_REJECTED = "rejected";

export const DECISION_STATUS_DISPATCH_FAILED = "dispatch_failed";

export const ACCEPT_DECISION_STATUSES: ReadonlySet<string> = new Set([
  DECISION_STATUS_ACTED,
]);

export const REJECT_DECISION_STATUSES: ReadonlySet<string> = new Set([
  DECISION_STATUS_REJECTED,
]);

export function isHousekeepingReject(row: {
  dispatch_error?: string | null;
  body?: Record<string, unknown> | null;
}): boolean {
  if (row.dispatch_error != null && row.dispatch_error !== "") return true;
  const autoResolved = (row.body ?? {})["auto_resolved"];
  return autoResolved === true || autoResolved === "true";
}

export function decisionVerdict(
  row: {
    status: string;
    dispatch_error?: string | null;
    body?: Record<string, unknown> | null;
  },
  opts?: {
    approvedCountsAsAccepted?: boolean;
  },
): "accepted" | "rejected" | null {
  if (ACCEPT_DECISION_STATUSES.has(row.status)) return "accepted";
  if (opts?.approvedCountsAsAccepted && row.status === "approved") return "accepted";
  if (row.status === DECISION_STATUS_DISPATCH_FAILED) return null;
  if (REJECT_DECISION_STATUSES.has(row.status)) {
    return isHousekeepingReject(row) ? null : "rejected";
  }
  return null;
}
