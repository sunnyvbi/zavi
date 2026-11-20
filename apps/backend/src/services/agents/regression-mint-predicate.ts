
import { isInfraRetryable, isUsageLimitError, isMoneyPathSlug } from "./infra-retry";

export const MINT_LIVE_SLUGS: ReadonlySet<string> = new Set(["engineer", "pm"]);

const FAIL_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "parse_failed",
  "dispatch_error",
]);

export interface MintCandidateRow {
  agent_slug: string;
  status: string;
  error: string | null;
  last_progress_at: string | null;
}

export interface MintDecision {
  mintable: boolean;
  reason:
    | "mint"
    | "not_a_failure"
    | "money_slug_excluded"
    | "usage_limit_excluded"
    | "infra_orphan_excluded"
    | "out_of_v1_scope";
}

export function decideMintable(row: MintCandidateRow): MintDecision {
  if (!FAIL_STATUSES.has(row.status)) {
    return { mintable: false, reason: "not_a_failure" };
  }
  if (isMoneyPathSlug(row.agent_slug)) {
    return { mintable: false, reason: "money_slug_excluded" };
  }
  if (isUsageLimitError(row.error)) {
    return { mintable: false, reason: "usage_limit_excluded" };
  }
  if (isInfraRetryable(row.status, row.error) && row.last_progress_at === null) {
    return { mintable: false, reason: "infra_orphan_excluded" };
  }
  return { mintable: true, reason: "mint" };
}
