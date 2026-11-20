
import { serviceClient } from "@/services/supabase";
import { getRepoScopingFlagState } from "./repo-scoping-flag";

type Svc = ReturnType<typeof serviceClient>;

export type RepoReadOptions = { throwOnReadError?: boolean };

export type ScopedReposResult = {
  repos: string[];
  scoped: boolean;
  allConnected: string[];
  selectionRequired: boolean;
};

export async function getScopedRepos(
  tenant_id: string,
  svc: Svc = serviceClient(),
  options: RepoReadOptions = {},
): Promise<ScopedReposResult> {
  const { data, error } = await svc
    .from("connector_metadata")
    .select("repo_ids, repo_full_names, selected_repo_ids")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();

  if (error && options.throwOnReadError) throw new Error(`connector_metadata read failed: ${error.message}`);

  const meta = (error ? null : (data as {
    repo_ids?: number[] | null;
    repo_full_names?: string[] | null;
    selected_repo_ids?: number[] | null;
  } | null)) ?? null;

  const repoIds = (meta?.repo_ids ?? []).filter(
    (n): n is number => typeof n === "number",
  );
  const fullNames = (meta?.repo_full_names ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  const allConnected = fullNames;

  const selection =
    Array.isArray(meta?.selected_repo_ids) ? meta!.selected_repo_ids! : null;

  const flagState = await getRepoScopingFlagState();
  const scopingActive =
    flagState === "on" ||
    (flagState === "unknown" && selection !== null);

  if (!scopingActive || selection === null) {
    return {
      repos: allConnected,
      scoped: false,
      allConnected,
      selectionRequired: false,
    };
  }

  const selSet = new Set(
    selection.filter((n): n is number => typeof n === "number"),
  );
  const scopedRepos: string[] = [];
  for (let i = 0; i < repoIds.length && i < fullNames.length; i++) {
    if (selSet.has(repoIds[i])) scopedRepos.push(fullNames[i]);
  }

  return {
    repos: scopedRepos,
    scoped: true,
    allConnected,
    selectionRequired: scopedRepos.length === 0 && allConnected.length > 0,
  };
}

export async function getScopedRepoFullNames(
  tenant_id: string,
  svc: Svc = serviceClient(),
  options: RepoReadOptions = {},
): Promise<string[]> {
  return (await getScopedRepos(tenant_id, svc, options)).repos;
}

export type ScopedReposMode = "all" | "scoped" | "deny";

export type ResolvedScopedRepos = {
  mode: ScopedReposMode;
  repos: string[];
  allConnected: string[];
  selectionRequired: boolean;
};

export async function resolveScopedRepos(
  tenant_id: string,
  svc: Svc = serviceClient(),
): Promise<ResolvedScopedRepos> {
  const { data, error } = await svc
    .from("connector_metadata")
    .select("repo_ids, repo_full_names, selected_repo_ids")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();

  const flagState = await getRepoScopingFlagState();

  if (error) {
    if (flagState === "off") {
      return { mode: "all", repos: [], allConnected: [], selectionRequired: false };
    }
    return { mode: "deny", repos: [], allConnected: [], selectionRequired: false };
  }

  const meta = (data as {
    repo_ids?: number[] | null;
    repo_full_names?: string[] | null;
    selected_repo_ids?: number[] | null;
  } | null) ?? null;

  const repoIds = (meta?.repo_ids ?? []).filter(
    (n): n is number => typeof n === "number",
  );
  const fullNames = (meta?.repo_full_names ?? []).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  const allConnected = fullNames;

  const selection =
    Array.isArray(meta?.selected_repo_ids) ? meta!.selected_repo_ids! : null;

  const scopingActive =
    flagState === "on" || (flagState === "unknown" && selection !== null);

  if (!scopingActive || selection === null) {
    return {
      mode: "all",
      repos: allConnected,
      allConnected,
      selectionRequired: false,
    };
  }

  const selSet = new Set(
    selection.filter((n): n is number => typeof n === "number"),
  );
  const scopedRepos: string[] = [];
  for (let i = 0; i < repoIds.length && i < fullNames.length; i++) {
    if (selSet.has(repoIds[i])) scopedRepos.push(fullNames[i]);
  }

  return {
    mode: "scoped",
    repos: scopedRepos,
    allConnected,
    selectionRequired: scopedRepos.length === 0 && allConnected.length > 0,
  };
}

export async function resolveScopedOrgs(
  tenant_id: string,
  svc: Svc = serviceClient(),
): Promise<{ mode: ScopedReposMode; allowedOrgs: Set<string> | null }> {
  const r = await resolveScopedRepos(tenant_id, svc);
  if (r.mode === "all") return { mode: "all", allowedOrgs: null };
  const owners = new Set(
    r.repos
      .map((full) => full.split("/")[0])
      .filter((o): o is string => !!o),
  );
  return { mode: r.mode, allowedOrgs: owners };
}
