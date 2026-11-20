
export type DeclaredRefineOutcome = "no_change" | "needs_input" | "refused";

const CODES: Record<string, DeclaredRefineOutcome> = {
  no_change: "no_change",
  needs_input: "needs_input",
  blocked: "refused",
  wrong_repo: "refused",
};

export function declaredRefineOutcome(row: { parsed?: unknown; outcome?: unknown }): DeclaredRefineOutcome | null {
  const parsed = row.parsed && typeof row.parsed === "object" && !Array.isArray(row.parsed)
    ? (row.parsed as { refused?: unknown; reason_code?: unknown; commit_sha?: unknown; pr_url?: unknown })
    : null;
  if (parsed && ((typeof parsed.commit_sha === "string" && parsed.commit_sha) || (typeof parsed.pr_url === "string" && parsed.pr_url))) {
    return null;
  }
  if (parsed?.refused === true) {
    return (typeof parsed.reason_code === "string" && CODES[parsed.reason_code]) || "refused";
  }
  const outcome = row.outcome && typeof row.outcome === "object" ? (row.outcome as { side_effect?: unknown }) : null;
  const se = outcome?.side_effect && typeof outcome.side_effect === "object"
    ? (outcome.side_effect as { kind?: unknown; reason_code?: unknown })
    : null;
  if (se?.kind === "refused" && typeof se.reason_code === "string") return CODES[se.reason_code] ?? "refused";
  return null;
}

export function isDeclaredNoChange(row: { parsed?: unknown; outcome?: unknown }): boolean {
  return declaredRefineOutcome(row) === "no_change";
}
