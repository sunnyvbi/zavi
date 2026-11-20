
import { MAX_REVIEW_ATTEMPTS, REVIEW_STALE_MS } from "./constants";

export type StuckReviewRow = {
  pending_decision_id: string;
  tenant_id: string;
  status: "pending" | "resolving";
  attempts: number;
  review_run_id: string | null;
};

export type ReviewRunState = "in_flight" | "terminal" | "absent";

export type StuckReviewAction = "retry" | "fail" | "wait";

export function classifyStuckReview(args: {
  row: StuckReviewRow;
  runState: ReviewRunState;
  ageMs: number;
}): StuckReviewAction {
  const { row, runState, ageMs } = args;
  if (runState === "in_flight" && ageMs < REVIEW_STALE_MS) return "wait";
  if (row.attempts >= MAX_REVIEW_ATTEMPTS) return "fail";
  return "retry";
}
