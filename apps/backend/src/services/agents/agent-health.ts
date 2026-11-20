
export type HealthBadge = "green" | "yellow" | "red" | "inactive";

export type HealthReason =
  | "missing_required_connectors"
  | "run_failed_no_recent_success"
  | "staff_flagged"
  | "customer_down_cluster"
  | "negative_feedback_needs_review"
  | "no_signal"
  | "stale"
  | "mixed_runs"
  | "healthy"
  | "inactive";

export type HealthInput = {
  inactive: boolean;
  missingRequiredConnectors: string[];
  latestTerminalStatus: "success" | "failed" | null;
  hadSuccessInWindow: boolean;
  staffDown: number;
  operatorDownCount: number;
  operatorUpCount: number;
  operatorDownDistinctUsers: number;
};

export type HealthOptions = {
  downCluster?: number;
};

export type HealthResult = {
  badge: HealthBadge;
  reason: HealthReason;
  detail: string;
};

const DEFAULT_DOWN_CLUSTER = 3;

export function computeAgentHealth(
  input: HealthInput,
  opts: HealthOptions = {},
): HealthResult {
  const downCluster = opts.downCluster ?? DEFAULT_DOWN_CLUSTER;

  if (input.inactive) {
    return { badge: "inactive", reason: "inactive", detail: "disabled or kill-switched for this tenant" };
  }

  if (input.missingRequiredConnectors.length > 0) {
    return {
      badge: "red",
      reason: "missing_required_connectors",
      detail: `missing required connector(s): ${input.missingRequiredConnectors.join(", ")}`,
    };
  }
  if (input.latestTerminalStatus === "failed" && !input.hadSuccessInWindow) {
    return {
      badge: "red",
      reason: "run_failed_no_recent_success",
      detail: "last run failed and no success in the reliability window",
    };
  }
  if (input.staffDown >= 2) {
    return { badge: "red", reason: "staff_flagged", detail: "staff flagged this agent (2+ thumbs-down)" };
  }
  const operatorNetNegative = input.operatorDownCount > input.operatorUpCount;
  if (
    input.operatorDownCount >= downCluster &&
    input.operatorDownDistinctUsers >= 2 &&
    operatorNetNegative
  ) {
    return {
      badge: "red",
      reason: "customer_down_cluster",
      detail: `${input.operatorDownCount} thumbs-down from ${input.operatorDownDistinctUsers} users`,
    };
  }

  const reliable = input.hadSuccessInWindow && input.latestTerminalStatus !== "failed";
  const mildNegative = input.staffDown > 0 || (input.operatorDownCount > 0 && operatorNetNegative);
  if (reliable && !mildNegative) {
    return { badge: "green", reason: "healthy", detail: "connectors connected, runs succeeding" };
  }

  const noRuns = input.latestTerminalStatus === null;
  const noFeedback = input.staffDown === 0 && input.operatorDownCount === 0 && input.operatorUpCount === 0;
  if (noRuns && noFeedback) {
    return { badge: "yellow", reason: "no_signal", detail: "no runs yet — no health signal" };
  }
  if (mildNegative) {
    return { badge: "yellow", reason: "negative_feedback_needs_review", detail: "recent negative feedback — review" };
  }
  if (!input.hadSuccessInWindow) {
    return { badge: "yellow", reason: "stale", detail: "no successful run in the reliability window" };
  }
  return { badge: "yellow", reason: "mixed_runs", detail: "mixed recent run outcomes" };
}
