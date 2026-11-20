import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { setDefaultRepo } from "./manage";
import { connectionsKey } from "./useConnections";

export type GithubRow = {
  repo_full_names: string[] | null;
  default_repo_full_name: string | null;
  repo_ids: number[] | null;
  selected_repo_ids: number[] | null;
};

export type GithubRepos = { connected: boolean; repos: string[]; default: string | null; hiddenByScope: number };

export function githubReposFrom(row: GithubRow | null): GithubRepos {
  const names = row?.repo_full_names ?? [];
  const ids = row?.repo_ids ?? null;
  const selected = row?.selected_repo_ids ?? null;
  const canScope = selected !== null && !!ids && ids.length === names.length;
  const settable = canScope ? names.filter((_, i) => selected.includes(ids[i])) : names;
  return {
    connected: !!row,
    repos: [...settable].sort((a, b) => a.localeCompare(b)),
    default: row?.default_repo_full_name ?? null,
    hiddenByScope: names.length - settable.length,
  };
}

export function repoErrorText(message: string): string {
  if (/selected repositories/i.test(message)) {
    return "That repo is outside your repo scope. Add it under 'Choose which repos Zavi can use' first.";
  }
  return message.replace(/^[a-z_]+:\s*/i, "");
}

export function branchSaveErrorText(code: string | undefined, status: number): string {
  switch (code) {
    case "unsafe_branch":
      return "That branch name isn't valid.";
    case "repo_not_connected":
      return "That repo isn't connected anymore.";
    case "not_admin":
      return "Only admins can change the base branch.";
    default:
      return status >= 500 ? "Couldn't save, please try again." : "Couldn't save.";
  }
}

const reposKey = (tenant: string) => ["github-repos", tenant] as const;

export function useGithubRepos() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: reposKey(tenant),
    enabled: tenant !== "none",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("connector_metadata")
        .select("repo_full_names, default_repo_full_name, repo_ids, selected_repo_ids")
        .eq("tenant_id", tenant)
        .eq("slug", "github")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return githubReposFrom((data as GithubRow | null) ?? null);
    },
  });
}

export function repoChipLabel(repo: string | null | undefined): string | null {
  return repo ? repo.split("/").slice(-1)[0] || null : null;
}

const ZAVI_BUILD_OWNERS = new Set(["praxis-build", "praxis-built"]);

export function savedRepoChip(repos: Pick<GithubRepos, "connected" | "default"> | null | undefined): string | null {
  if (!repos?.connected || !repos.default) return null;
  const owner = repos.default.split("/")[0]?.toLowerCase() ?? "";
  return ZAVI_BUILD_OWNERS.has(owner) ? null : repos.default;
}

export function useSetDefaultRepo() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: (repo: string) => setDefaultRepo(repo),
    onMutate: async (repo) => {
      await qc.cancelQueries({ queryKey: reposKey(tenant) });
      const prev = qc.getQueryData<GithubRepos>(reposKey(tenant));
      if (prev) qc.setQueryData<GithubRepos>(reposKey(tenant), { ...prev, default: repo });
      return { prev };
    },
    onError: (_e, _repo, ctx) => {
      if (ctx?.prev) qc.setQueryData(reposKey(tenant), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: reposKey(tenant) });
      void qc.invalidateQueries({ queryKey: connectionsKey(tenant) });
    },
  });
}
