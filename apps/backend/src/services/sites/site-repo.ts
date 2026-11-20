
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import { resolveProvisionOrg } from "@/services/provisioning/provision-org";
import { seedTemplate } from "@/services/provisioning/seed-template";
import { readProvisionedRepoHeadSha } from "@/services/provisioning/github-repo";
import {
  errorClass,
  GitHubApiError,
  GITHUB_RETRY_ATTEMPTS,
  gitHubPathTemplate,
  gitHubRetryDelayMs,
  isGitHubRateLimit,
  logGitHubFailure,
  readGitHubFailure,
  withGitHubRetry,
  type GitHubAttemptFailure,
  type GitHubFailure,
  type GitHubFetch,
  type GitHubResponse,
} from "@/services/provisioning/github-api";
import type { AlertInput } from "@/services/logging/alert";

const GH = "https://api.github.com";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOG_SOURCE = "site-repo";
const NOT_REACHABLE = "site repo not reachable after create";

export const SITE_REPO_ENSURE_BUDGET_MS = 25_000;
export const SITE_REPO_SEED_BUDGET_MS = 40_000;
export const SITE_REPO_CREATE_ALERT_AFTER = 3;
export const SITE_REPO_CREATE_ALERT_EVERY = 10;
export const SITE_REPO_CREATE_ALERT_CODE = "github_repo_create_failing";

type FetchLike = GitHubFetch;

export type SiteRepoRef = { full_name: string; default_branch: string; repo_url: string };

export interface SiteRepoOps {
  org(): string;
  ensureRepo(name: string): Promise<SiteRepoRef>;
  seed(tenant_id: string, full_name: string, files: Record<string, string>, opts?: { default_branch?: string }): Promise<string>;
  deleteRepo(full_name: string): Promise<void>;
}

export type SiteRepoDeps = {
  token?: () => string | null;
  org?: () => string;
  fetchFn?: FetchLike;
  seedFn?: typeof seedTemplate;
  headSha?: (full_name: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logFailure?: (f: GitHubAttemptFailure) => void;
  alert?: (input: AlertInput) => Promise<void>;
};

let createFailureStreak = 0;

export function __resetSiteRepoCreateStreakForTests(): void {
  createFailureStreak = 0;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function safeFailureSummary(e: unknown): string {
  if (e instanceof GitHubApiError) {
    const f = e.failure;
    return [
      `GitHub answered ${f.status}`,
      isGitHubRateLimit(f) ? "rate limited" : null,
      f.sso_required ? "SSO authorization required" : null,
      f.request_id ? `request ${f.request_id}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (e instanceof CredentialNotConfigured) return `credential not configured: ${e.key}`;
  if (e instanceof Error && e.message === NOT_REACHABLE) return NOT_REACHABLE;
  return `${errorClass(e)} (no answer from GitHub)`;
}

async function defaultAlert(input: AlertInput): Promise<void> {
  const { alert } = await import("@/services/logging/alert");
  await alert(input);
}

export function createSiteRepoOps(deps: SiteRepoDeps = {}): SiteRepoOps {
  const getToken = deps.token ?? (() => process.env.GITHUB_PROVISION_TOKEN ?? null);
  const getOrg = deps.org ?? (() => resolveProvisionOrg());
  const rawFetch = deps.fetchFn ?? ((globalThis as { fetch: FetchLike }).fetch);
  const seedFn = deps.seedFn ?? seedTemplate;
  const headSha = deps.headSha ?? ((full: string) => readProvisionedRepoHeadSha(full, "main"));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const logFailure = deps.logFailure ?? ((f: GitHubAttemptFailure) => logGitHubFailure(LOG_SOURCE, f));
  const pageOps = deps.alert ?? defaultAlert;

  function gh(deadlineAt: number, attempts = GITHUB_RETRY_ATTEMPTS): GitHubFetch {
    return withGitHubRetry(rawFetch, { sleep, nowMs: now, deadline: () => deadlineAt, attempts, onFailure: logFailure });
  }

  function token(): string {
    const t = getToken();
    if (!t) throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");
    return t;
  }

  async function read(fetchFn: GitHubFetch, full: string, tok: string): Promise<SiteRepoRef | null> {
    const res = await fetchFn(`${GH}/repos/${full}`, { headers: headers(tok) });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new GitHubApiError("site repo lookup", await readGitHubFailure(res));
    const body = (await res.json()) as { full_name?: string; html_url?: string; default_branch?: string };
    const name = body.full_name ?? full;
    return { full_name: name, default_branch: body.default_branch ?? "main", repo_url: body.html_url ?? `https://github.com/${name}` };
  }

  async function createOrRebind(name: string): Promise<SiteRepoRef> {
    const tok = token();
    const org = getOrg();
    const full = `${org}/${name}`;
    const deadlineAt = now() + SITE_REPO_ENSURE_BUDGET_MS;
    const fetchFn = gh(deadlineAt);
    const postOnce = withGitHubRetry(rawFetch, { sleep, nowMs: now, deadline: () => deadlineAt, attempts: 1 });
    const createUrl = `${GH}/orgs/${org}/repos`;

    const existing = await read(fetchFn, full, tok);
    if (existing) return existing;

    for (let attempt = 0; ; attempt++) {
      let res: GitHubResponse | null = null;
      let networkError: unknown = null;
      try {
        res = await postOnce(createUrl, {
          method: "POST",
          headers: headers(tok),
          body: JSON.stringify({ name, private: true, auto_init: true }),
        });
      } catch (e) {
        networkError = e;
      }
      if (res?.status === 201) {
        for (let i = 0; i < 3; i++) {
          const ok = await read(fetchFn, full, tok);
          if (ok) return ok;
          if (i < 2) await sleep(200 * (i + 1));
        }
        throw new Error(NOT_REACHABLE);
      }

      const failure: GitHubFailure | null = res ? await readGitHubFailure(res) : null;
      const attemptFailure = {
        method: "POST",
        path: gitHubPathTemplate(createUrl),
        attempt,
        attempts: GITHUB_RETRY_ATTEMPTS,
        failure,
        network_error: res ? null : errorClass(networkError),
      };
      const createError = (): unknown => (failure ? new GitHubApiError("site repo create", failure) : networkError);
      let reread: SiteRepoRef | null;
      try {
        reread = await read(fetchFn, full, tok);
      } catch {
        logFailure({ ...attemptFailure, will_retry: false });
        throw createError();
      }
      if (reread) {
        logFailure({ ...attemptFailure, will_retry: false, recovered: true });
        return reread;
      }

      const isLast = attempt >= GITHUB_RETRY_ATTEMPTS - 1;
      const delay = isLast ? null : gitHubRetryDelayMs(failure, attempt + 1, { nowMs: now });
      const wait = delay !== null && now() + delay <= deadlineAt ? delay : null;
      logFailure({ ...attemptFailure, will_retry: wait !== null });
      if (wait === null) throw createError();
      await sleep(wait);
    }
  }

  function pageIfStuck(e: unknown): void {
    createFailureStreak++;
    const n = createFailureStreak;
    const config = e instanceof CredentialNotConfigured || (e instanceof GitHubApiError && !e.retryable);
    const due =
      (config && n === 1) ||
      n === SITE_REPO_CREATE_ALERT_AFTER ||
      (n > SITE_REPO_CREATE_ALERT_AFTER && (n - SITE_REPO_CREATE_ALERT_AFTER) % SITE_REPO_CREATE_ALERT_EVERY === 0);
    if (!due) return;
    const hour = new Date(now()).toISOString().slice(0, 13);
    const what = config && n === 1 ? "Site repo creation on GitHub failed on configuration" : `Site repo creation on GitHub failed ${n} times in a row`;
    void Promise.resolve()
      .then(() =>
        pageOps({
          source: LOG_SOURCE,
          code: SITE_REPO_CREATE_ALERT_CODE,
          msg: `${what}, so new website builds cannot start. Last: ${safeFailureSummary(e)}. GitHub's full answer: praxis_logs source=${LOG_SOURCE} code=github_repo_create_failed.`,
          email: {
            dedupeKey: `${LOG_SOURCE}:${SITE_REPO_CREATE_ALERT_CODE}:${hour}`,
            subjectDetail:
              e instanceof GitHubApiError && e.failure.status === 401
                ? "website builds down: GitHub token rejected (401)"
                : "website builds down: GitHub repo creation failing",
          },
        }),
      )
      .catch(() => undefined);
  }

  return {
    org: () => getOrg(),

    async ensureRepo(name) {
      if (!NAME_RE.test(name)) throw new Error("site repo: invalid repo name");
      try {
        const ref = await createOrRebind(name);
        createFailureStreak = 0;
        return ref;
      } catch (e) {
        pageIfStuck(e);
        throw e;
      }
    },

    async seed(tenant_id, full_name, files, opts) {
      const r = await seedFn(tenant_id, full_name, {
        token: getToken,
        fetchFn: gh(now() + SITE_REPO_SEED_BUDGET_MS),
        files,
        commitMessage: "chore: seed site starter (vite-react-supabase)",
        ...(opts?.default_branch ? { defaultBranch: opts.default_branch } : {}),
      });
      if (r.seeded) return r.commit_sha;
      const sha = await headSha(full_name);
      if (!sha) throw new Error("site repo seed: could not read main after an earlier seed");
      return sha;
    },

    async deleteRepo(full_name) {
      const full = String(full_name ?? "").trim();
      const [owner, repo, extra] = full.split("/");
      if (!owner || !repo || extra !== undefined) throw new Error("site repo delete: invalid repo name");
      if (owner.toLowerCase() !== getOrg().toLowerCase()) {
        throw new Error("site repo delete: refusing a repo outside the provisioning org");
      }
      const res = await gh(now() + SITE_REPO_ENSURE_BUDGET_MS)(`${GH}/repos/${owner}/${repo}`, { method: "DELETE", headers: headers(token()) });
      if (res.status !== 204 && res.status !== 404) throw new GitHubApiError("site repo delete", await readGitHubFailure(res));
    },
  };
}
