import type { BuildSessionMeta } from "./buildHistory";
import type { BuildSiteFlags } from "./useBuildSessions";
import type { GithubReposState } from "./useGithubRepos";
import { isZaviHostedRepoUrl, isZaviManagedGithubLogin } from "@/components/workspace/build/existingProduct";

export type RepoChipScope = { kind: "home" } | { kind: "build"; sessionId: string | null };

export type RepoChip = { repo: string | null; site: boolean };

export type RepoChipSessions = {
  sessions?: BuildSessionMeta[];
  loaded?: boolean;
  failed?: boolean;
  flags?: BuildSiteFlags;
};

export const HOME_SCOPE: RepoChipScope = { kind: "home" };

export function ownGithubRepo(state: GithubReposState): string | null {
  if (state.status !== "ok" || !state.connected || !state.default) return null;
  if (isZaviManagedGithubLogin(state.accountLogin)) return null;
  if (isZaviHostedRepoUrl(`https://github.com/${state.default}`)) return null;
  return state.default;
}

export function resolveRepoChip(
  scope: RepoChipScope,
  snapshot: RepoChipSessions,
  workspaceDefault: string | null,
  hasOwnRepo = false,
): RepoChip {
  if (!snapshot.loaded && !snapshot.failed && scope.kind === "build" && scope.sessionId) return { repo: null, site: true };
  if (!snapshot.loaded || !snapshot.flags?.siteRepoChip) return { repo: workspaceDefault, site: false };
  const sessions = snapshot.sessions ?? [];
  if (scope.kind === "build" && scope.sessionId) {
    const open = sessions.find((s) => s.id === scope.sessionId);
    if (open?.site) return { repo: open.site.repo ?? null, site: true };
    if (open) return { repo: workspaceDefault, site: false };
    return { repo: null, site: true };
  }
  if (hasOwnRepo) return { repo: workspaceDefault, site: false };
  const sites = sessions.filter((s) => !!s.site);
  if (scope.kind === "build" && sites.length > 0) return { repo: null, site: true };
  if (sites.length >= 2) return { repo: null, site: true };
  if (sites.length === 1) return { repo: sites[0].site?.repo ?? null, site: true };
  return { repo: workspaceDefault, site: false };
}

export function repoHintFor(chip: RepoChip): string | undefined {
  return chip.site && chip.repo ? chip.repo : undefined;
}
