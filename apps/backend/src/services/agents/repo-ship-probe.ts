
import {
  resolveInstallationId,
  assertReadRepoMembership,
  searchCommitsImpl,
  readFileImpl,
} from "@/services/mcp/internal/github";
import {
  resolveScopedRepos,
  getScopedRepoFullNames,
} from "@/services/connectors/github/scoped-repos";

export type ShipEvidence = {
  shipping_commits: Array<{
    sha: string;
    repo: string;
    key: string | null;
    date: string;
    msg: string;
  }>;
  contract_snippet: string | null;
  contract_path: string | null;
  repo_scope_ok: boolean;
  incomplete: boolean;
  error?: string;
};

export type RepoShipProbeInput = {
  ticketKey?: string;
  featureKeywords?: string[];
  endpointSymbols?: string[];
  contractHint?: { owner: string; repo: string; path: string };
};

const MAX_REPOS = 10;
const MAX_KEYWORDS = 3;
const MAX_GITHUB_CALLS = 12;
const PER_PAGE = 5;
const CONTRACT_SNIPPET_CHARS = 400;

const TICKET_KEY_RE = /[A-Z]{2,}-\d+/;

function splitFullName(full: string): { owner: string; repo: string } | null {
  const i = full.indexOf("/");
  if (i <= 0 || i === full.length - 1) return null;
  return { owner: full.slice(0, i), repo: full.slice(i + 1) };
}

export async function repoShipProbe(
  tenant_id: string,
  input: RepoShipProbeInput,
): Promise<ShipEvidence> {
  const empty: ShipEvidence = {
    shipping_commits: [],
    contract_snippet: null,
    contract_path: null,
    repo_scope_ok: false,
    incomplete: false,
  };

  try {
    const scope = await resolveScopedRepos(tenant_id);
    if (scope.mode === "deny") {
      return { ...empty, repo_scope_ok: false, incomplete: false };
    }

    const allow = new Set(await getScopedRepoFullNames(tenant_id));
    if (scope.repos.length === 0 || allow.size === 0) {
      return { ...empty, repo_scope_ok: false, incomplete: false };
    }

    const installation_id = await resolveInstallationId(tenant_id);

    const repos = scope.repos.slice(0, MAX_REPOS);
    let incomplete = scope.repos.length > MAX_REPOS;

    const keywords = (input.featureKeywords ?? [])
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .slice(0, MAX_KEYWORDS);
    const queries: string[] = [];
    if (input.ticketKey && input.ticketKey.trim().length > 0) {
      queries.push(input.ticketKey.trim());
    }
    for (const k of keywords) queries.push(k);

    const commits: ShipEvidence["shipping_commits"] = [];
    const seenSha = new Set<string>();
    let calls = 0;

    outer: for (const full of repos) {
      const parts = splitFullName(full);
      if (!parts) continue;
      const { owner, repo } = parts;

      try {
        await assertReadRepoMembership(tenant_id, owner, repo);
      } catch {
        continue;
      }

      for (const q of queries) {
        if (calls >= MAX_GITHUB_CALLS) {
          incomplete = true;
          break outer;
        }
        calls++;
        let result: Awaited<ReturnType<typeof searchCommitsImpl>>;
        try {
          result = await searchCommitsImpl(tenant_id, installation_id, {
            owner,
            repo,
            query: q,
            per_page: PER_PAGE,
          });
        } catch (e) {
          incomplete = true;
          break outer;
        }

        for (const item of result.items) {
          const commitRepo = item.repository_full_name || full;
          if (!allow.has(commitRepo)) continue;
          if (seenSha.has(item.sha)) continue;
          seenSha.add(item.sha);
          commits.push({
            sha: item.sha,
            repo: commitRepo,
            key: item.message.match(TICKET_KEY_RE)?.[0] ?? null,
            date: item.author_date,
            msg: item.message.split("\n")[0].slice(0, 200),
          });
        }
      }
    }

    let contract_snippet: string | null = null;
    let contract_path: string | null = null;
    if (input.contractHint && allow.has(`${input.contractHint.owner}/${input.contractHint.repo}`)) {
      if (calls >= MAX_GITHUB_CALLS) {
        incomplete = true;
      } else {
        calls++;
        try {
          const read = await readFileImpl(tenant_id, installation_id, {
            owner: input.contractHint.owner,
            repo: input.contractHint.repo,
            path: input.contractHint.path,
            ref: "HEAD",
          });
          const body = read.content ?? "";
          contract_snippet = body.slice(0, CONTRACT_SNIPPET_CHARS) || null;
          contract_path = contract_snippet ? input.contractHint.path : null;
        } catch {
          incomplete = true;
        }
      }
    }

    return {
      shipping_commits: commits,
      contract_snippet,
      contract_path,
      repo_scope_ok: true,
      incomplete,
    };
  } catch (e) {
    return {
      shipping_commits: [],
      contract_snippet: null,
      contract_path: null,
      repo_scope_ok: false,
      incomplete: true,
      error: (e as Error).message,
    };
  }
}

export async function resolveContractRepo(
  tenant_id: string,
): Promise<{ owner: string; repo: string } | null> {
  try {
    const scope = await resolveScopedRepos(tenant_id);
    if (scope.mode === "deny") return null;
    const allow = await getScopedRepoFullNames(tenant_id);
    const first = allow[0];
    if (!first) return null;
    return splitFullName(first);
  } catch {
    return null;
  }
}
