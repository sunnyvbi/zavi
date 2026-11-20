
export const ANSWERED_NO_ACTION_REASONS = [
  "refused_envelope",
  "prose_fallback",
  "over_ship_cap",
  "critic_fail",
  "task_mismatch",
  "typecheck_failed",
  "tests_failed",
  "app_verify_missing",
  "wiring_unverified_block",
  "dispatch_validation_failed",
  "head_branch_placeholder_unresolved",
  "all_bases_conflict",
] as const;

export function suppressAnsweredNoAction(
  reason: string,
  output_text: string | undefined,
): boolean {
  const hasText =
    typeof output_text === "string" && output_text.trim().length > 0;
  if (!hasText) return false;
  return (ANSWERED_NO_ACTION_REASONS as readonly string[]).includes(reason);
}
