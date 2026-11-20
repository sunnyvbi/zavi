import { apiJson } from "../../lib/api";
import { openConnectInBrowser, startOAuth } from "./api";

export const SLACK_PURPOSES = ["support", "dev", "exec", "general"] as const;

export async function fetchVisibleAgentSlugs(): Promise<string[]> {
  const b = await apiJson<{ agents?: { slug: string; effective_state: string }[] }>("/api/agents/visibility");
  return (b?.agents ?? [])
    .filter((a) => a.effective_state === "visible")
    .map((a) => a.slug)
    .sort();
}

export function saveSlackWorkspaceMeta(meta: {
  team_id: string;
  purpose: string;
  label: string;
  default_agent_slug: string;
}): Promise<unknown> {
  return apiJson("/api/connectors/slack/workspace-meta", { method: "POST", body: JSON.stringify(meta) });
}

export async function openConnectFlow(slug: "slack" | "github"): Promise<void> {
  const url = await startOAuth(`/api/connectors/${slug}/start`);
  await openConnectInBrowser(url);
}

export function setDefaultRepo(repoFullName: string): Promise<unknown> {
  return apiJson("/api/connectors/github/default-repo", {
    method: "POST",
    body: JSON.stringify({ repo_full_name: repoFullName }),
  });
}

export async function fetchRepoBranches(repoFullName: string): Promise<{ branches: string[]; current: string | null }> {
  const b = await apiJson<{ branches?: string[]; current?: string | null }>(
    `/api/connectors/github/repo-branches?repo_full_name=${encodeURIComponent(repoFullName)}`,
  );
  return { branches: b?.branches ?? [], current: b?.current ?? null };
}

export function setRepoBranch(repoFullName: string, branch: string): Promise<unknown> {
  return apiJson("/api/connectors/github/repo-branch", {
    method: "POST",
    body: JSON.stringify({ repo_full_name: repoFullName, branch }),
  });
}

export function setSelectedRepos(ids: number[] | null): Promise<unknown> {
  return ids === null
    ? apiJson("/api/connectors/github/selected-repos", { method: "DELETE" })
    : apiJson("/api/connectors/github/selected-repos", { method: "POST", body: JSON.stringify({ repo_ids: ids }) });
}
