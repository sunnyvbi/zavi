
import type { SourceKind } from "./source-kind";

export type GroundingReceiptKind =
  | "repo_read"
  | "repo_history"
  | "repo_source_read"
  | "repo_doc_read";

const REPO_READ_TOOLS: ReadonlySet<string> = new Set([
  "github__search_code",
  "github__read_file",
  "github__list_files",
  "github__list_repos",
  "github__grep",
  "code_index__code_def",
  "code_index__code_refs",
  "code_index__code_callers",
  "code_index",
  "code_symbol_query",
  "callers",
  "def",
]);

const REPO_HISTORY_TOOLS: ReadonlySet<string> = new Set([
  "github__list_commits",
  "github__list_branches",
  "github__get_pr_diff",
  "github__list_open_prs",
  "github__search_issues",
]);

const MAX_RUNS_RETAINED = 500;

const LEDGER = new Map<string, Set<GroundingReceiptKind>>();

function pruneIfNeeded(): void {
  if (LEDGER.size <= MAX_RUNS_RETAINED) return;
  const overflow = LEDGER.size - MAX_RUNS_RETAINED;
  let i = 0;
  for (const key of LEDGER.keys()) {
    if (i++ >= overflow) break;
    LEDGER.delete(key);
  }
}

const SEARCH_STYLE_GROUNDING_TOOLS: ReadonlySet<string> = new Set([
  "github__search_code",
  "github__search_issues",
  "code_symbol_query",
  "callers",
]);

export function recordGroundingReceipt(
  run_id: string | undefined,
  toolName: string,
  hadInformation: boolean = true,
  sourceKind?: SourceKind | null,
): void {
  if (!run_id) return;
  if (SEARCH_STYLE_GROUNDING_TOOLS.has(toolName) && !hadInformation) return;
  let kind: GroundingReceiptKind | undefined;
  if (REPO_READ_TOOLS.has(toolName)) kind = "repo_read";
  else if (REPO_HISTORY_TOOLS.has(toolName)) kind = "repo_history";
  if (!kind) return;

  let set = LEDGER.get(run_id);
  if (!set) {
    set = new Set<GroundingReceiptKind>();
    LEDGER.set(run_id, set);
    pruneIfNeeded();
  }
  set.add(kind);

  if (kind === "repo_read" && sourceKind) {
    set.add(sourceKind === "source" ? "repo_source_read" : "repo_doc_read");
  }
}

export function hasShippedCodeReceipt(run_id: string): boolean {
  return groundingReceipts(run_id).has("repo_source_read");
}

export function isDocOnlyGrounded(run_id: string): boolean {
  const r = groundingReceipts(run_id);
  return r.has("repo_doc_read") && !r.has("repo_source_read");
}

export function groundingReceipts(run_id: string): ReadonlySet<GroundingReceiptKind> {
  return LEDGER.get(run_id) ?? new Set<GroundingReceiptKind>();
}

export function clearGroundingReceipts(run_id: string): void {
  LEDGER.delete(run_id);
}

export function __resetGroundingReceiptsForTest(): void {
  LEDGER.clear();
}
