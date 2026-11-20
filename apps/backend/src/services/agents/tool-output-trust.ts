
export const TRUSTED_INTERNAL_SERVER_IDS: ReadonlySet<string> = new Set([
  "memory",
  "praxis_corpus",
  "operator_db",
  "github",
]);

export const ATTACKER_AUTHORABLE_GITHUB_TOOLS: ReadonlySet<string> = new Set([
  "search_issues",
  "get_pr_diff",
  "list_open_prs",
  "list_commits",
]);

export function isAttackerAuthorableGithubOutput(
  server_id: string,
  tool_name: string,
): boolean {
  return (
    server_id === "github" && ATTACKER_AUTHORABLE_GITHUB_TOOLS.has(tool_name)
  );
}

export function shouldWrapToolOutput(
  server_id: string,
  tool_name: string,
): boolean {
  if (isAttackerAuthorableGithubOutput(server_id, tool_name)) return true;
  return !TRUSTED_INTERNAL_SERVER_IDS.has(server_id);
}
