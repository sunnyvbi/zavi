
import type { Provisioner, ProvisionResult } from "./types";
import { tenantScopedSlug } from "./tenant-slug";
import { resolveProvisionOrg } from "./provision-org";
import { GitHubApiError, logGitHubFailure, readGitHubFailure, withGitHubRetry, type GitHubAttemptFailure, type GitHubFetch } from "./github-api";

export class CredentialNotConfigured extends Error {
  constructor(public readonly key: string) {
    super(`credential not configured: ${key}`);
    this.name = "CredentialNotConfigured";
  }
}

type FetchLike = GitHubFetch;

type GitHubRepoDeps = {
  token?: () => string | null;
  org?: () => string;
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  logFailure?: (f: GitHubAttemptFailure) => void;
};

const GH = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export function repoSlug(company_name: string, tenant_id: string): string {
  return tenantScopedSlug(company_name, tenant_id, 90);
}

export function createGitHubRepoProvisioner(deps: GitHubRepoDeps = {}): Provisioner {
  const getToken = deps.token ?? (() => process.env.GITHUB_PROVISION_TOKEN ?? null);
  const getOrg = deps.org ?? (() => resolveProvisionOrg());
  const rawFetch = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const retryOpts = {
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onFailure: deps.logFailure ?? ((f: GitHubAttemptFailure) => logGitHubFailure("github-repo", f)),
  };
  const fetchFn = withGitHubRetry(rawFetch, retryOpts);
  const createFetch = (onFailure: (f: GitHubAttemptFailure) => void) =>
    withGitHubRetry(rawFetch, { ...(deps.sleep ? { sleep: deps.sleep } : {}), attempts: 1, onFailure });

  async function ensure(input: { tenant_id: string; company_name: string }): Promise<ProvisionResult> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");
    const org = getOrg();
    const slug = repoSlug(input.company_name, input.tenant_id);
    const full = `${org}/${slug}`;

    const existing = await fetchFn(`${GH}/repos/${full}`, { headers: ghHeaders(token) });
    if (existing.status === 200) {
      const body = (await existing.json()) as { full_name?: string; html_url?: string; default_branch?: string };
      return {
        external_ref: {
          github_full_name: body.full_name ?? full,
          repo_url: body.html_url ?? `https://github.com/${full}`,
          default_branch: body.default_branch ?? "main",
        },
        vault_keys: {},
      };
    }
    if (existing.status !== 404) {
      throw new GitHubApiError("github repo lookup", await readGitHubFailure(existing));
    }

    let res: Awaited<ReturnType<FetchLike>> | null = null;
    let networkError: unknown = null;
    let createFailure: GitHubAttemptFailure | null = null;
    try {
      res = await createFetch((f) => {
        createFailure = f;
      })(`${GH}/orgs/${org}/repos`, {
        method: "POST",
        headers: ghHeaders(token),
        body: JSON.stringify({ name: slug, private: true, auto_init: true }),
      });
    } catch (e) {
      networkError = e;
    }
    if (!res || res.status !== 201) {
      const createError = res ? new GitHubApiError("github repo create", await readGitHubFailure(res)) : networkError;
      const again = await fetchFn(`${GH}/repos/${full}`, { headers: ghHeaders(token) }).catch(() => null);
      const recovered = again?.status === 200;
      const logged = createFailure as GitHubAttemptFailure | null;
      if (logged) retryOpts.onFailure({ ...logged, recovered });
      if (recovered && again) {
        const b = (await again.json()) as { full_name?: string; html_url?: string; default_branch?: string };
        return {
          external_ref: {
            github_full_name: b.full_name ?? full,
            repo_url: b.html_url ?? `https://github.com/${full}`,
            default_branch: b.default_branch ?? "main",
          },
          vault_keys: {},
        };
      }
      throw createError;
    }
    const body = (await res.json()) as { full_name?: string; html_url?: string; default_branch?: string };
    const createdFull = body.full_name ?? full;

    await verifyRepoExists(createdFull, token);

    return {
      external_ref: {
        github_full_name: createdFull,
        repo_url: body.html_url ?? `https://github.com/${full}`,
        default_branch: body.default_branch ?? "main",
      },
      vault_keys: {},
    };
  }

  async function verifyRepoExists(repo_full_name: string, token: string): Promise<void> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const check = await fetchFn(`${GH}/repos/${repo_full_name}`, { headers: ghHeaders(token) });
      if (check.status === 200) return;
      lastStatus = check.status;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    throw new Error(
      `github repo verify failed (${lastStatus}): not reachable after create`,
    );
  }

  async function teardown(external_ref: Record<string, unknown>): Promise<void> {
    const token = getToken();
    if (!token) throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");
    const full = String(external_ref.github_full_name ?? "");
    if (!full) return;
    const res = await fetchFn(`${GH}/repos/${full}`, { method: "DELETE", headers: ghHeaders(token) });
    if (res.status !== 204 && res.status !== 404) {
      throw new GitHubApiError("github repo teardown", await readGitHubFailure(res));
    }
  }

  return { kind: "repo", provider: "github", ensure, teardown };
}

export async function readProvisionedRepoHeadSha(
  github_full_name: string,
  default_branch = "main",
): Promise<string | null> {
  const r = await readProvisionedRepoHead(github_full_name, default_branch);
  return "sha" in r ? r.sha : null;
}

export async function readProvisionedRepoHeadTree(
  github_full_name: string,
  default_branch = "main",
): Promise<{ sha: string; tree: string } | { error: string }> {
  const head = await readProvisionedRepoHead(github_full_name, default_branch);
  if (!("sha" in head)) return head;
  const token = process.env.GITHUB_PROVISION_TOKEN ?? "";
  try {
    const res = await fetch(`${GH}/repos/${github_full_name.trim()}/git/commits/${head.sha}`, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `GitHub answered ${res.status} for commit ${head.sha.slice(0, 7)}` };
    const body = (await res.json()) as { tree?: { sha?: unknown } } | null;
    const tree = body?.tree?.sha;
    return typeof tree === "string" && /^[0-9a-f]{40}$/i.test(tree)
      ? { sha: head.sha, tree: tree.toLowerCase() }
      : { error: `GitHub returned no tree for commit ${head.sha.slice(0, 7)}` };
  } catch (e) {
    return { error: `GitHub could not be reached: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}

export async function readProvisionedRepoHead(
  github_full_name: string,
  default_branch = "main",
): Promise<{ sha: string } | { error: string }> {
  const token = process.env.GITHUB_PROVISION_TOKEN ?? null;
  if (!token) return { error: "this server has no GitHub provisioning credential" };
  const full = (github_full_name ?? "").trim();
  if (!full || !/^[^/]+\/[^/]+$/.test(full)) return { error: "the repo name is not owner/name" };
  const branch = (default_branch ?? "main").trim() || "main";
  try {
    const res = await fetch(
      `${GH}/repos/${full}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) {
      const hint =
        res.status === 404 || res.status === 403 || res.status === 401
          ? " (this server's GitHub credential cannot see that repo or branch)"
          : "";
      return { error: `GitHub answered ${res.status} for ${full}@${branch}${hint}` };
    }
    const body = (await res.json()) as { object?: { sha?: unknown } } | null;
    const sha = body?.object?.sha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha)
      ? { sha }
      : { error: `GitHub returned no commit for ${full}@${branch}` };
  } catch (e) {
    return { error: `GitHub could not be reached: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}
