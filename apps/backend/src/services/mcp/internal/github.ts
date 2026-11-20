
import type { ToolEffect } from "@/services/tools/types";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ENGINEER_PR_DISPATCH_CEILING,
  ENGINEER_PR_CAPS_PRODUCT_BUILD,
} from "@/services/agents/engineer-caps";
import type { McpCallResult, McpTool } from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { assertDependencyAdmission, type RepoFileRead } from "./dependency-admission";
import { isPlatformSourceRepo } from "@/services/platform-source-repo";
import { resolveProvisionOrg } from "@/services/provisioning/provision-org";
import { isSelfHealPlatformRun } from "@/services/self-heal-credential";
import { zodToJsonSchema } from "@/services/tools/registry";
import {
  ghInstallationHeaders,
  mintInstallationToken,
} from "@/services/connectors/github/oauth";
import { serviceClient } from "@/services/supabase";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import {
  getScopedRepos,
  resolveScopedRepos,
  resolveScopedOrgs,
} from "@/services/connectors/github/scoped-repos";
import type { CallMcpContext } from "../execute";

const GITHUB_API = "https://api.github.com";

const GITHUB_FETCH_TIMEOUT_MS = Number(process.env.GITHUB_FETCH_TIMEOUT_MS ?? 10_000);

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  if (!Number.isFinite(GITHUB_FETCH_TIMEOUT_MS) || GITHUB_FETCH_TIMEOUT_MS <= 0) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  return fetch(url, { ...init, signal: controller.signal });
}

const READ_TOOLS_NEEDING_MEMBERSHIP = new Set<string>([
  "list_files",
  "read_file",
  "search_code",
  "grep",
  "list_open_prs",
  "get_pr_diff",
  "get_pr",
  "list_pr_status",
  "list_branches",
  "list_commits",
]);

export interface GithubReadDeps {
  assertProvisionedRepoTarget?: typeof assertProvisionedRepoTarget;
}

export async function assertReadRepoMembership(
  tenant_id: string,
  owner: string,
  repo: string,
  deps: GithubReadDeps = {},
): Promise<void> {
  const assertProvisioned =
    deps.assertProvisionedRepoTarget ?? assertProvisionedRepoTarget;
  const full = `${owner}/${repo}`;

  let scoped: Awaited<ReturnType<typeof getScopedRepos>>;
  try {
    scoped = await getScopedRepos(tenant_id);
  } catch (e) {
    throw new ExpectedToolError(
      "github_read_membership_check_failed",
      `could not verify repo access: ${(e as Error).message}`,
    );
  }

  if (scoped.repos.includes(full)) return;

  const gate = await assertProvisioned(tenant_id, full);
  if (gate.ok) return;

  const scopedOut = scoped.scoped && scoped.allConnected.includes(full);
  throw new ExpectedToolError(
    "repo_not_authorized",
    scopedOut
      ? `${full} is connected but is NOT in this tenant's selected repositories [${
          scoped.repos.join(", ") || "none"
        }]. The operator restricted which repos Zavi may reach — pick one of the selected repos, or ask the operator to add ${full} in Settings → Connectors → GitHub.`
      : `${full} is not in this tenant's connected repositories [${
          scoped.repos.join(", ") || "none"
        }]. You can only read repos the tenant connected via /connectors.`,
  );
}

const repoCoord = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

const listReposInput = z.object({}).strict();

const listFilesInput = repoCoord.extend({
  ref: z.string().min(1).default("HEAD"),
  path: z.string().default(""),
});

const readFileInput = repoCoord.extend({
  ref: z.string().min(1).default("HEAD"),
  path: z.string().min(1),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

const searchCodeInput = repoCoord.extend({
  query: z.string().min(1),
  per_page: z.number().int().min(1).max(50).default(20),
});

const grepInput = repoCoord.extend({
  ref: z.string().min(1).default("HEAD"),
  pattern: z.string().min(1).max(500),
  regex: z.boolean().default(true),
  case_sensitive: z.boolean().default(false),
  path_glob: z.string().min(1).max(200).optional(),
  max_matches: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(80).optional(),
});

const listOpenPrsInput = repoCoord.extend({
  per_page: z.number().int().min(1).max(50).default(20),
});

const getPrDiffInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
});

const getPrInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
});

const listPrStatusInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
});

const searchIssuesInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "GitHub Issues search DSL — e.g. 'is:issue assignee:USERNAME state:open' or 'is:issue repo:OWNER/NAME label:bug'.",
    ),
  max_results: z.number().int().min(1).max(30).default(10),
});

const listBranchesInput = repoCoord.extend({
  max_results: z.number().int().min(1).max(100).default(30),
});

const getMeInput = z.object({});

const listCommitsInput = repoCoord.extend({
  branch: z.string().optional().describe("Branch name (defaults to repo default branch)."),
  since: z
    .string()
    .optional()
    .describe("ISO 8601 datetime; return commits authored on/after this time."),
  max_results: z.number().int().min(1).max(100).default(20),
});

const listTeamsInput = z.object({
  org: z.string().min(1).describe("GitHub org login (e.g. 'rravi149' is a user, not an org — use the actual org slug)."),
  max_results: z.number().int().min(1).max(100).default(30),
});

const fileChangeSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["create", "modify", "delete"]),
  content: z.string().optional(),
  encoding: z.literal("base64").optional(),
});

export const openPrInput = repoCoord.extend({
  base_branch: z.string().min(1),
  head_branch: z.string().min(1),
  title: z.string().min(1).max(120),
  body: z.string().max(8000).default(""),
  files: z
    .array(fileChangeSchema)
    .min(1)
    .max(ENGINEER_PR_DISPATCH_CEILING.maxFiles),
  expected_base_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});

export const pushToMainInput = repoCoord.extend({
  base_branch: z.string().min(1).max(120).default("main"),
  title: z.string().min(1).max(120),
  files: z
    .array(fileChangeSchema)
    .min(1)
    .max(ENGINEER_PR_CAPS_PRODUCT_BUILD.maxFiles),
});

const pushBranchInput = repoCoord.extend({
  base_branch: z.string().min(1).max(120).default("main"),
  head_branch: z.string().min(1).max(255),
  title: z.string().min(1).max(120),
  files: z
    .array(fileChangeSchema)
    .min(1)
    .max(ENGINEER_PR_CAPS_PRODUCT_BUILD.maxFiles),
});

const openPrFromBranchInput = repoCoord.extend({
  base_branch: z.string().min(1).max(120).default("main"),
  head_branch: z.string().min(1).max(255),
  title: z.string().min(1).max(200),
  body: z.string().max(60000).default(""),
});

const updatePrBranchInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
  head_branch: z.string().min(1).max(255),
  title: z.string().min(1).max(120),
  files: z
    .array(fileChangeSchema)
    .min(1)
    .max(ENGINEER_PR_DISPATCH_CEILING.maxFiles),
});

const postReviewInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
  body: z.string().min(1).max(8000),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).default("COMMENT"),
});

const addLabelInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
  labels: z.array(z.string()).min(1).max(8),
});

export const squashMergeInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
  commit_title: z.string().min(1).max(120),
  commit_message: z.string().max(8000).default(""),
});

const closePrInput = repoCoord.extend({
  pull_number: z.number().int().min(1),
});

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const READ_SPECS: Record<string, SpecEntry> = {
  list_repos: {
    description:
      "List repositories the operator's GitHub App installation has access to. Returns id+full_name+private only.",
    schema: listReposInput,
    effect: "read",
  },
  list_files: {
    description:
      "List files in a repo at a given ref. Returns the directory tree shape (path, type, size). Use to discover code structure before reading specific files.",
    schema: listFilesInput,
    effect: "read",
  },
  read_file: {
    description:
      "Read a file from a repo at a given ref. Content comes back LINE-NUMBERED (`   87\u2502text`) and the result carries `total_lines`, so you can cite an exact line and tell whether your range covered the whole file. Binary files reject. Capped at 64KB; longer files truncate with a marker. For a large file pass start_line/end_line (1-indexed, inclusive) to read just the region you need. To FIND which lines to read, prefer `grep` (real regex, returns line numbers) over `search_code`.",
    schema: readFileInput,
    effect: "read",
  },
  search_code: {
    description:
      "Keyword/token search over a single repo (GitHub's code index). Returns file paths plus the matched text FRAGMENT (no line numbers). It is a TOKEN index, NOT grep: it cannot match regex, substrings, or punctuation — a cron expression (`30 16 * * *`), an operator, or a comma-separated list will NEVER match here. Use it for identifier/word lookups; for anything punctuation-shaped or regex-shaped use `grep` instead. EVERY word in your query must appear in the SAME file (terms are ANDed), so keep queries to 1-2 words — a 4-word keyword-soup query returns 0 even when the thing plainly exists, and `total:0` on a multi-word query is NOT evidence of absence.",
    schema: searchCodeInput,
    effect: "read",
  },
  grep: {
    description:
      "Regex (or literal) search over the CONTENT of a repo's files. Returns `{path, line_number, line}` per match \u2014 real line numbers you can feed straight into read_file's start_line/end_line. This is the tool for anything search_code cannot express: cron expressions, punctuation, operators, substrings, multi-token patterns. Narrow with `path_glob` (e.g. `apps/backend/**/*.ts`) when the repo is large. If the result says `complete:false`, the scan was bounded \u2014 zero matches then is NOT proof of absence, so continue with the returned `next_cursor` (pass it as `cursor` with the same arguments) or narrow, rather than reporting the thing missing.",
    schema: grepInput,
    effect: "read",
  },
  list_open_prs: {
    description:
      "List open pull requests on a repo. Returns number+title+author+head_branch+base_branch.",
    schema: listOpenPrsInput,
    effect: "read",
  },
  get_pr_diff: {
    description:
      "Fetch the unified diff for a pull request. Capped at 64KB; longer diffs truncate with a marker.",
    schema: getPrDiffInput,
    effect: "read",
  },
  get_pr: {
    description:
      "Fetch a single pull request's live state. Returns number+state(open|closed)+merged(bool)+head_branch+base_branch. Use to tell whether a PR is still OPEN with a live head branch (precise O(1) check — not list_open_prs, which is paginated).",
    schema: getPrInput,
    effect: "read",
  },
  list_pr_status: {
    description:
      "Get CI check states + approving review count for a PR. Used by the merge_pr pre-flight gate.",
    schema: listPrStatusInput,
    effect: "read",
  },
  search_issues: {
    description:
      "Search GitHub Issues across all accessible repos using the GitHub Issues search DSL. Returns total_count + items (number, title, state, html_url, user_login, repository_url, labels, created_at). DSL primitives: `is:issue` (vs PRs), `is:open`/`is:closed`, `assignee:<login>`, `author:<login>`, `repo:<o>/<r>`, `label:<name>`, `created:>2026-05-01`. GitHub LOGIN is the filter primitive — not display name. Example: user asks 'find issues assigned to catherine' → search_issues(query='is:issue assignee:catherine-github-login'). Same shape as Jira accountId, Slack user_id, Linear user.id.",
    schema: searchIssuesInput,
    effect: "read",
  },
  list_branches: {
    description:
      "List branches on a repo (name + sha + protected). Use this BEFORE any task that depends on the branch name — GitHub repos can default to `main`, `master`, `develop`, etc. Defaulting to `main` silently fails on ~20% of older OSS repos.",
    schema: listBranchesInput,
    effect: "read",
  },
  get_me: {
    description:
      "Return the connected GitHub App's identity — app_name, installation_id, repo_count, first 5 accessible repo full_names. Sanity check + answers 'who am I as Praxis sees GitHub'.",
    schema: getMeInput,
    effect: "read",
  },
  list_commits: {
    description:
      "List recent commits on a repo (sha, author_login, author_date, message, html_url), optionally filtered by branch and `since` ISO datetime. Use to answer 'what changed in the last week' without reading individual files.",
    schema: listCommitsInput,
    effect: "read",
  },
  list_teams: {
    description:
      "List teams in a GitHub org (id, slug, name, description, parent_team_slug). Use to discover org structure or to pair with PR/review routing questions.",
    schema: listTeamsInput,
    effect: "read",
  },
};

const WRITE_SPECS: Record<string, SpecEntry> = {
  open_pr: {
    description:
      "Create a branch from base, commit the listed files server-side via blob/tree/commit/ref, and open a PR. NEVER called from the agent loop — only invoked by dispatch-decision after autonomy approval.",
    schema: openPrInput,
    effect: "write",
  },
  push_to_main: {
    description:
      "Autopilot ONLY — commit the listed files server-side via blob/tree/commit and fast-forward `main` (no branch, no PR). NEVER advertised to the agent loop; reachable only from dispatch-decision AFTER the provisioned-repo safety gate verifies the target is an autopilot-owned provisioned repo.",
    schema: pushToMainInput,
    effect: "write",
  },
  push_branch: {
    description:
      "Autopilot refine-gate ONLY (Option A) — commit the listed files to a NEW head branch (blob/tree/commit/ref) WITHOUT opening a PR. NEVER advertised to the agent loop; reachable only from engineer post-run under defer_pr AFTER the umbrella-cred provisioned-repo gate.",
    schema: pushBranchInput,
    effect: "write",
  },
  open_pr_from_branch: {
    description:
      "Autopilot refine-gate ONLY (Option A) — open a PR from an ALREADY-PUSHED head branch (no commit). NEVER advertised to the agent loop; reachable only from the refine-gate resolver AFTER the umbrella-cred provisioned-repo gate.",
    schema: openPrFromBranchInput,
    effect: "write",
  },
  update_pr_branch: {
    description:
      "Follow-up ONLY — commit the listed files onto an EXISTING open PR's head branch (fast-forward the head ref, force:false) and post an [agent-auto] comment. No new branch, no new PR. No-op (returns no_change:true) when the resulting tree equals the current head. NEVER advertised to the agent loop; reachable only from dispatch-decision AFTER its fail-closed engineer_pr_followup authorization gate.",
    schema: updatePrBranchInput,
    effect: "write",
  },
  post_review: {
    description: "Post a PR review comment.",
    schema: postReviewInput,
    effect: "write",
  },
  request_changes: {
    description: "Post a PR review with REQUEST_CHANGES.",
    schema: postReviewInput,
    effect: "write",
  },
  add_label: {
    description: "Add labels to a PR.",
    schema: addLabelInput,
    effect: "write",
  },
  squash_merge: {
    description:
      "Squash-merge a PR. Caller must verify CI green + ≥1 approval BEFORE calling — this tool does not re-check.",
    schema: squashMergeInput,
    effect: "write",
  },
  close_pr: {
    description:
      "Close a PR without merging. Used by the cto:e2e test cleanup. Not declared as a engineer or pr-reviewer tool.",
    schema: closePrInput,
    effect: "write",
  },
};

const ALL_SPECS: Record<string, SpecEntry> = { ...READ_SPECS, ...WRITE_SPECS };

export function listGithubHiddenWriteToolEffects(): Array<{ tool_name: string; effect: ToolEffect }> {
  return Object.entries(WRITE_SPECS)
    .filter(([tool_name]) => !(tool_name in READ_SPECS))
    .map(([tool_name, spec]) => ({ tool_name, effect: spec.effect }));
}

export function listGithubTools(): McpTool[] {
  return Object.entries(READ_SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`github/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "github",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export const AUTOPILOT_PAT_SENTINEL = -1;

export function isProvisionedUmbrellaOwner(owner: string | undefined): boolean {
  if (!owner) return false;
  const org = resolveProvisionOrg().toLowerCase();
  return owner.trim().toLowerCase() === org;
}

async function resolveInstallationId(tenant_id: string): Promise<number> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id, account_login")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    throw new Error(`connector_metadata read failed: ${error.message}`);
  }
  const row = data as { installation_id?: number; account_login?: string } | null;
  const id = row?.installation_id;
  if (typeof id === "number" && id > 0) return id;
  if (row && row.account_login === "Praxis-build") {
    return AUTOPILOT_PAT_SENTINEL;
  }
  throw new ExpectedToolError(
    "github_not_connected",
    "Tenant has not installed the Praxis GitHub App. Connect via /connectors first.",
    { connector_slug: "github", connector_mode: row ? "reconnect" : "connect" },
  );
}

async function resolvePlatformWriteInstallation(
  ctx: CallMcpContext,
): Promise<number | null> {
  const runId = ctx.run_id;
  if (!runId) return null;
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id, agent_slug, payload")
    .eq("id", runId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    tenant_id?: string;
    agent_slug?: string;
    payload?: { source_agent?: string } | null;
  };
  if (row.tenant_id !== ctx.tenant_id) return null;
  if (
    isSelfHealPlatformRun({
      tenant_id: row.tenant_id,
      source_agent: row.payload?.source_agent,
      agent_slug: row.agent_slug,
    })
  ) {
    return AUTOPILOT_PAT_SENTINEL;
  }
  return null;
}

export type GhFetchOpts = {
  retryTransient?: boolean;
};

const GH_TRANSIENT_MAX_ATTEMPTS = 3;
const GH_TRANSIENT_BASE_DELAY_MS = 400;
const GH_TRANSIENT_MAX_DELAY_MS = 5_000;

export function isRetriableResponse(res: Response): boolean {
  if (res.status >= 500) return true;
  if (res.status === 429) return true;
  if (res.status === 403) {
    if (res.headers.get("retry-after")) return true;
    if (res.headers.get("x-ratelimit-remaining") === "0") return true;
  }
  return false;
}

function transientDelayMs(attempt: number, res: Response | null): number {
  const ra = res?.headers.get("retry-after");
  const raMs = ra && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) * 1000 : 0;
  const backoff = GH_TRANSIENT_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * GH_TRANSIENT_BASE_DELAY_MS);
  return Math.min(GH_TRANSIENT_MAX_DELAY_MS, Math.max(raMs, backoff + jitter));
}

export async function fetchWithTransientRetry(thunk: () => Promise<Response>): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < GH_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await thunk();
      if (attempt < GH_TRANSIENT_MAX_ATTEMPTS - 1 && isRetriableResponse(res)) {
        await new Promise((r) => setTimeout(r, transientDelayMs(attempt, res)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < GH_TRANSIENT_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, transientDelayMs(attempt, null)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function githubReadError(label: string, res: Response): Promise<Error> {
  const reason = await res
    .json()
    .then((body) => String((body as { message?: unknown }).message ?? "").slice(0, 200))
    .catch(() => "");
  const said = reason ? `: ${reason}` : "";
  const retryAfter = res.headers?.get("retry-after");
  const remaining = res.headers?.get("x-ratelimit-remaining");
  const limited =
    res.status === 429 ||
    (res.status === 403 && (!!retryAfter || remaining === "0" || /rate limit/i.test(reason)));
  if (!limited) return new Error(`${label} HTTP ${res.status}${said}`);
  const reset = Number(res.headers?.get("x-ratelimit-reset") ?? "");
  const retry_after_seconds = retryAfter && /^\d+$/.test(retryAfter.trim())
    ? Number(retryAfter.trim())
    : reset > 0
      ? Math.max(0, Math.ceil(reset - Date.now() / 1000))
      : null;
  const wait = retry_after_seconds === null ? "" : ` Retry in about ${retry_after_seconds}s.`;
  return new ExpectedToolError(
    "github_rate_limited",
    `${label} HTTP ${res.status}, GitHub rate limit reached${said}.${wait} The code was NOT read, so this says nothing about what it does or whether it exists.`,
    { retry_after_seconds },
  );
}

async function ghFetchWithRetry(
  tenant_id: string,
  installation_id: number,
  url: string,
  init: RequestInit,
  opts?: GhFetchOpts,
): Promise<Response> {
  const retryTransient = opts?.retryTransient === true;
  if (installation_id === AUTOPILOT_PAT_SENTINEL) {
    const pat = process.env.GITHUB_PROVISION_TOKEN ?? "";
    if (!pat) {
      throw new ExpectedToolError(
        "github_not_connected",
        "GITHUB_PROVISION_TOKEN not configured — autopilot push path unavailable.",
      );
    }
    const doFetch = () =>
      fetchWithTimeout(url, {
        ...init,
        headers: { ...ghInstallationHeaders(pat), ...(init.headers ?? {}) },
      });
    return retryTransient ? fetchWithTransientRetry(doFetch) : doFetch();
  }
  let token = await mintInstallationToken({ tenant_id, installation_id });
  const doInstFetch = () =>
    fetchWithTimeout(url, {
      ...init,
      headers: { ...ghInstallationHeaders(token), ...(init.headers ?? {}) },
    });
  let res = await (retryTransient ? fetchWithTransientRetry(doInstFetch) : doInstFetch());
  if (res.status === 401) {
    token = await mintInstallationToken({ tenant_id, installation_id, forceRefresh: true });
    res = await (retryTransient ? fetchWithTransientRetry(doInstFetch) : doInstFetch());
    if (res.status === 401) {
      throw new ExpectedToolError(
        "github_app_revoked",
        "GitHub App installation token rejected (401). The operator may have uninstalled the App or revoked permissions. Re-install via /connectors.",
      );
    }
  }
  return res;
}

const READ_BYTE_CAP = 64 * 1024;

function capBody(
  s: string,
  cap: number = READ_BYTE_CAP,
): { content: string; truncated: boolean; truncated_bytes?: number } {
  if (s.length <= cap) return { content: s, truncated: false };
  return {
    content: `${s.slice(0, cap)}\n[truncated ${s.length - cap} bytes]`,
    truncated: true,
    truncated_bytes: s.length - cap,
  };
}

function splitOwnerFromRepo(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const { owner, repo } = args as { owner?: unknown; repo?: unknown };
  if (typeof repo !== "string") return args;
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return args;
  if (owner !== undefined && (typeof owner !== "string" || owner.toLowerCase() !== parts[0].toLowerCase())) {
    return args;
  }
  return { ...(args as object), owner: parts[0], repo: parts[1] };
}

export async function callGithubTool(
  ctx: CallMcpContext,
  tool_name: string,
  args: unknown,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = ALL_SPECS[tool_name];
  if (!spec) {
    return errorResult(start, "tool_unknown", `github/${tool_name} not registered`);
  }
  try {
    const parsed = spec.schema.parse(
      READ_TOOLS_NEEDING_MEMBERSHIP.has(tool_name) ? splitOwnerFromRepo(args) : args,
    );
    const coord = parsed as { owner?: string; repo?: string };
    let installation_id: number | null = null;
    if (coord.owner && coord.repo && isPlatformSourceRepo(coord.owner, coord.repo)) {
      installation_id = await resolvePlatformWriteInstallation(ctx);
    }
    if (
      installation_id === null &&
      tool_name === "push_to_main" &&
      isProvisionedUmbrellaOwner(coord.owner)
    ) {
      installation_id = AUTOPILOT_PAT_SENTINEL;
    }
    if (
      installation_id === null &&
      tool_name === "open_pr" &&
      coord.owner &&
      coord.repo &&
      isProvisionedUmbrellaOwner(coord.owner)
    ) {
      const gate = await assertProvisionedRepoTarget(
        ctx.tenant_id,
        `${coord.owner}/${coord.repo}`,
      );
      if (gate.ok) {
        installation_id = AUTOPILOT_PAT_SENTINEL;
      } else {
        console.warn(
          `[github open_pr] umbrella-cred gate refused (${gate.reason}) for tenant=${ctx.tenant_id} repo=${coord.owner}/${coord.repo} — falling back to tenant installation`,
        );
      }
    }
    const REFINE_GATE_UMBRELLA_TOOLS: ReadonlySet<string> = new Set([
      "push_branch",
      "open_pr_from_branch",
      "add_label",
    ]);
    if (
      installation_id === null &&
      REFINE_GATE_UMBRELLA_TOOLS.has(tool_name) &&
      coord.owner &&
      coord.repo &&
      isProvisionedUmbrellaOwner(coord.owner)
    ) {
      const gate = await assertProvisionedRepoTarget(
        ctx.tenant_id,
        `${coord.owner}/${coord.repo}`,
      );
      if (gate.ok) {
        installation_id = AUTOPILOT_PAT_SENTINEL;
      } else {
        console.warn(
          `[github ${tool_name}] umbrella-cred gate refused (${gate.reason}) for tenant=${ctx.tenant_id} repo=${coord.owner}/${coord.repo} — falling back to tenant installation`,
        );
      }
    }
    if (installation_id === null) {
      installation_id = await resolveInstallationId(ctx.tenant_id);
    }
    const output = await runTool(ctx.tenant_id, installation_id, tool_name, parsed);
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return errorResult(start, e.code, e.message, e.meta);
    }
    if ((e as { name?: string })?.name === "ZodError") {
      return errorResult(start, "tool_input_invalid", (e as Error).message);
    }
    throw e;
  }
}

function errorResult(
  start: number,
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: code, message, ...(meta ? { meta } : {}) }),
    ms: Date.now() - start,
  };
}

async function runTool(
  tenant_id: string,
  installation_id: number,
  tool_name: string,
  args: unknown,
): Promise<unknown> {
  if (READ_TOOLS_NEEDING_MEMBERSHIP.has(tool_name)) {
    const coord = repoCoord.parse(args);
    await assertReadRepoMembership(tenant_id, coord.owner, coord.repo);
  }

  switch (tool_name) {
    case "list_repos":
      return listReposImpl(tenant_id, installation_id);
    case "list_files":
      return listFilesImpl(tenant_id, installation_id, args as z.infer<typeof listFilesInput>);
    case "read_file": {
      const r = await readFileImpl(
        tenant_id,
        installation_id,
        args as z.infer<typeof readFileInput>,
      );
      const firstLine = r.first_line ?? 1;
      const shown = r.content === "" ? 0 : r.content.split("\n").length;
      return {
        ...r,
        content: numberLines(r.content, firstLine),
        line_numbers: true,
        last_line: firstLine + Math.max(shown - 1, 0),
        covers_whole_file:
          firstLine === 1 && !r.truncated && (shown >= r.total_lines || r.content === ""),
      };
    }
    case "search_code":
      return searchCodeImpl(tenant_id, installation_id, args as z.infer<typeof searchCodeInput>);
    case "grep":
      return grepImpl(tenant_id, installation_id, args as z.infer<typeof grepInput>);
    case "list_open_prs":
      return listOpenPrsImpl(tenant_id, installation_id, args as z.infer<typeof listOpenPrsInput>);
    case "get_pr_diff":
      return getPrDiffImpl(tenant_id, installation_id, args as z.infer<typeof getPrDiffInput>);
    case "get_pr":
      return getPrImpl(tenant_id, installation_id, args as z.infer<typeof getPrInput>);
    case "list_pr_status":
      return listPrStatusImpl(tenant_id, installation_id, args as z.infer<typeof listPrStatusInput>);
    case "search_issues":
      return searchIssuesImpl(tenant_id, installation_id, args as z.infer<typeof searchIssuesInput>);
    case "list_branches":
      return listBranchesImpl(tenant_id, installation_id, args as z.infer<typeof listBranchesInput>);
    case "get_me":
      return getMeImpl(tenant_id, installation_id);
    case "list_commits":
      return listCommitsImpl(tenant_id, installation_id, args as z.infer<typeof listCommitsInput>);
    case "list_teams":
      return listTeamsImpl(tenant_id, installation_id, args as z.infer<typeof listTeamsInput>);
    case "open_pr":
      return openPrImpl(tenant_id, installation_id, args as z.infer<typeof openPrInput>);
    case "push_to_main":
      return pushToMainImpl(tenant_id, installation_id, args as z.infer<typeof pushToMainInput>);
    case "push_branch":
      return pushBranchImpl(tenant_id, installation_id, args as z.infer<typeof pushBranchInput>);
    case "open_pr_from_branch":
      return openPrFromBranchImpl(tenant_id, installation_id, args as z.infer<typeof openPrFromBranchInput>);
    case "update_pr_branch":
      return updatePrBranchImpl(tenant_id, installation_id, args as z.infer<typeof updatePrBranchInput>);
    case "post_review":
      return postReviewImpl(tenant_id, installation_id, args as z.infer<typeof postReviewInput>, "COMMENT_OR_INPUT");
    case "request_changes":
      return postReviewImpl(tenant_id, installation_id, args as z.infer<typeof postReviewInput>, "REQUEST_CHANGES");
    case "add_label":
      return addLabelImpl(tenant_id, installation_id, args as z.infer<typeof addLabelInput>);
    case "squash_merge":
      return squashMergeImpl(tenant_id, installation_id, args as z.infer<typeof squashMergeInput>);
    case "close_pr":
      return closePrImpl(tenant_id, installation_id, args as z.infer<typeof closePrInput>);
    default:
      throw new Error(`unhandled github tool: ${tool_name}`);
  }
}

async function listReposImpl(tenant_id: string, installation_id: number) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/installation/repositories?per_page=100`,
    { method: "GET" },
  );
  if (!res.ok) throw new Error(`list_repos HTTP ${res.status}`);
  const json = (await res.json()) as {
    repositories: Array<{ id: number; full_name: string; private: boolean }>;
  };
  let allowed: Set<string> | null = null;
  try {
    const scoped = await resolveScopedRepos(tenant_id);
    allowed = scoped.mode === "all" ? null : new Set(scoped.repos);
  } catch {
    allowed = new Set();
  }
  const repos = json.repositories
    .filter((r) => allowed === null || allowed.has(r.full_name))
    .map((r) => ({ id: r.id, full_name: r.full_name, private: r.private }));
  return { repos };
}

async function listFilesImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, ref, path }: z.infer<typeof listFilesInput>,
) {
  const url = path
    ? `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
    : `${GITHUB_API}/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(ref)}`;
  const res = await ghFetchWithRetry(tenant_id, installation_id, url, { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError("not_found", `${owner}/${repo} ${path} ${ref}: not found`);
    }
    throw new Error(`list_files HTTP ${res.status}`);
  }
  const json = (await res.json()) as
    | Array<{ name: string; path: string; type: string; size: number }>
    | { name: string; path: string; type: string; size: number };
  const arr = Array.isArray(json) ? json : [json];
  return {
    entries: arr.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
  };
}

export async function readFileImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, ref, path, start_line, end_line }: z.infer<typeof readFileInput>,
  byteCap: number = READ_BYTE_CAP,
) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { method: "GET" },
    { retryTransient: true },
  );
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError("not_found", `${owner}/${repo}/${path}@${ref}: not found`);
    }
    throw await githubReadError("read_file", res);
  }
  const json = (await res.json()) as {
    encoding: string;
    content: string;
    type?: string;
    size?: number;
  };
  if (json.type !== "file") {
    throw new ExpectedToolError(
      "not_a_file",
      `${path} is not a file (type=${json.type ?? "unknown"})`,
    );
  }
  if (json.encoding !== "base64") {
    throw new ExpectedToolError(
      "unsupported_encoding",
      `unsupported encoding ${json.encoding} for ${path}`,
    );
  }
  const decoded = Buffer.from(json.content, "base64").toString("utf-8");
  const allLines = decoded.split("\n");
  if (start_line !== undefined || end_line !== undefined) {
    const from = Math.max(0, (start_line ?? 1) - 1);
    const to = end_line ?? allLines.length;
    const region = allLines.slice(from, Math.max(from, to)).join("\n");
    return { ...capBody(region, byteCap), total_lines: allLines.length, first_line: from + 1 };
  }
  return { ...capBody(decoded, byteCap), total_lines: allLines.length, first_line: 1 };
}

const TRUNCATION_MARKER_RE = /^\[truncated \d+ bytes\]$/;

export function numberLines(content: string, firstLine: number): string {
  if (content === "") return "";
  const lines = content.split("\n");
  const last = firstLine + lines.length - 1;
  const width = String(Math.max(last, 1)).length;
  return lines
    .map((line, i) =>
      TRUNCATION_MARKER_RE.test(line)
        ? line
        : `${String(firstLine + i).padStart(width, " ")}\u2502${line}`,
    )
    .join("\n");
}

const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "is", "are", "how",
  "what", "where", "code", "file", "files", "feature", "flow", "user", "users",
]);

export function pickRetryTerms(query: string): string[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w.:/-]+|[^\w.:/-]+$/g, ""))
    .filter((t) => t.length >= 3 && !SEARCH_STOPWORDS.has(t.toLowerCase()));
  if (terms.length < 2) return [];
  const longest = [...terms].sort((a, b) => b.length - a.length)[0];
  return Array.from(new Set([terms[0], longest]));
}

export async function searchCodeImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, query, per_page }: z.infer<typeof searchCodeInput>,
) {
  const runOne = async (term: string) => {
    const res = await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/search/code?q=${encodeURIComponent(`${term} repo:${owner}/${repo}`)}&per_page=${per_page}`,
      { method: "GET", headers: { Accept: "application/vnd.github.text-match+json" } },
      { retryTransient: true },
    );
    if (!res.ok) throw await githubReadError("search_code", res);
    const json = (await res.json()) as {
      total_count: number;
      items: Array<{
        name: string;
        path: string;
        html_url: string;
        text_matches?: Array<{ fragment?: string }>;
      }>;
    };
    const mapped = json.items.map((i) => ({
      name: i.name,
      path: i.path,
      url: i.html_url,
      fragments: (i.text_matches ?? [])
        .map((m) => (m.fragment ?? "").slice(0, 400))
        .filter((f) => f.length > 0)
        .slice(0, 3),
    }));
    const isDoc = (path: string) =>
      /(^|\/)docs?(\/|$)/i.test(path) || /\.(md|mdx|markdown|rst|txt)$/i.test(path);
    const source = mapped.filter((i) => !isDoc(i.path));
    const docs = mapped.filter((i) => isDoc(i.path));
    return {
      total: json.total_count,
      items: [...source, ...docs],
      source_hits: source.length,
      doc_hits: docs.length,
      ...(docs.length > 0 && source.length > 0
        ? {
            ordering_note:
              "Source files are listed first; the last " +
              docs.length +
              " hit(s) are docs/specs. A doc states INTENT and may not match shipped behaviour — use it to find the symbol, then read the source.",
          }
        : {}),
      ...(docs.length > 0 && source.length === 0
        ? {
            ordering_note:
              "Every hit is a doc/spec — no source file matched this query. Docs state INTENT, not shipped behaviour. Try the symbol names these docs mention (code_def), or a code-shaped query, before answering.",
          }
        : {}),
    };
  };

  const first = await runOne(query);
  if (first.total > 0) return first;

  const retryTerms = pickRetryTerms(query);
  for (const term of retryTerms) {
    const retried = await runOne(term).catch(() => null);
    if (retried && retried.total > 0) {
      return {
        ...retried,
        original_query: query,
        retried_query: term,
        hint:
          `Your ${query.trim().split(/\s+/).length}-word query returned 0 because this index requires EVERY word ` +
          `to appear in the SAME file. These results are from an automatic retry on "${term}". ` +
          `The original 0 was NOT evidence of absence — treat these hits as the real answer and read them.`,
      };
    }
  }

  const termCount = query.trim().split(/\s+/).filter(Boolean).length;
  return {
    ...first,
    ...(termCount >= 2
      ? {
          hint:
            `0 results for a ${termCount}-word query, and an automatic retry on ` +
            `${retryTerms.map((t) => `"${t}"`).join(" and ") || "narrower terms"} also found nothing. ` +
            `This index requires EVERY word to appear in the SAME file, so this is still NOT proof the thing is absent — ` +
            `use \`grep\` for a regex/substring match before concluding anything is missing.`,
        }
      : {}),
  };
}

const GREP_SKIP_EXT_RE =
  /\.(png|jpe?g|gif|webp|ico|svg|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|mp[34]|m4a|mov|avi|mkv|webm|wav|flac|ttf|otf|woff2?|eot|so|dylib|dll|exe|bin|dat|class|pyc|wasm|lock|pack|idx)$/i;

const GREP_CANDIDATE_CAP = 300;
const GREP_PER_FILE_BYTES = 512 * 1024;
const GREP_TOTAL_BYTES = 8 * 1024 * 1024;
const GREP_WALL_MS = 25_000;
const GREP_CONCURRENCY = 8;
const GREP_BLOB_CACHE_MAX_CHARS = 64 * 1024 * 1024;
type GrepBlob = { content: string; truncated: boolean };
const grepBlobCache = new Map<string, GrepBlob>();
let grepBlobCacheChars = 0;

function grepBlobGet(key: string): GrepBlob | undefined {
  return grepBlobCache.get(key);
}

function grepBlobPut(key: string, blob: GrepBlob): void {
  const existing = grepBlobCache.get(key);
  if (existing) {
    grepBlobCache.delete(key);
    grepBlobCacheChars -= existing.content.length;
  }
  grepBlobCache.set(key, blob);
  grepBlobCacheChars += blob.content.length;
  for (const [oldKey, old] of grepBlobCache) {
    if (grepBlobCacheChars <= GREP_BLOB_CACHE_MAX_CHARS) break;
    grepBlobCache.delete(oldKey);
    grepBlobCacheChars -= old.content.length;
  }
}
const GREP_LINE_SCAN_CAP = 2_000;
const GREP_LINE_ECHO_CAP = 300;

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const GREP_LOW_PRIORITY_RE =
  /(^|\/)(__tests__|__mocks__|__snapshots__|tests?|spec|fixtures?|e2e|dist|build|vendor|coverage|generated)(\/|$)|\.(test|spec|stories)\.|\.min\.|\.generated\.|\.d\.ts$/i;
const GREP_DOC_RE = /\.(md|mdx|txt|rst)$/i;

function grepPatternWords(pattern: string, regex: boolean): string[] {
  const text = regex ? pattern.replace(/\\[a-zA-Z]/g, " ") : pattern;
  return [...new Set((text.match(/[A-Za-z0-9_]{3,}/g) ?? []).map((w) => w.toLowerCase()))].slice(0, 8);
}

export function rankGrepCandidates<T extends { path: string }>(
  candidates: T[],
  pattern: string,
  regex: boolean,
): T[] {
  const words = grepPatternWords(pattern, regex);
  const tier = (path: string): number => {
    const p = path.toLowerCase();
    if (GREP_LOW_PRIORITY_RE.test(path)) return 3;
    if (words.some((w) => p.includes(w))) return 0;
    return GREP_DOC_RE.test(path) ? 2 : 1;
  };
  return candidates
    .map((c, i) => ({ c, i, t: tier(c.path) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.c);
}

function grepFingerprint(
  treeKey: string,
  pattern: string,
  regex: boolean,
  case_sensitive: boolean,
  path_glob: string | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify([treeKey, pattern, regex, case_sensitive, path_glob ?? ""]))
    .digest("hex")
    .slice(0, 12);
}

function parseGrepCursor(
  cursor: string | undefined,
  fp: string,
  total: number,
): { offset: number; partial: boolean } | null {
  if (!cursor) return null;
  const m = /^v1\.([0-9a-f]{12})\.(\d+)(\.p)?$/.exec(cursor);
  if (!m || m[1] !== fp) return null;
  const at = Number(m[2]);
  return at > 0 && at < total ? { offset: at, partial: m[3] === ".p" } : null;
}

export async function grepImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, ref, pattern, regex, case_sensitive, path_glob, max_matches, cursor }: z.infer<
    typeof grepInput
  >,
) {
  if (regex && /\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern)) {
    throw new ExpectedToolError(
      "unsafe_pattern",
      "pattern has a nested quantifier (e.g. `(a+)+`) which can hang the scan. Rewrite it without the nested repeat, or pass regex:false to search literally.",
    );
  }

  let re: RegExp;
  try {
    const source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(source, case_sensitive ? "" : "i");
  } catch (e) {
    throw new ExpectedToolError(
      "bad_pattern",
      `pattern is not valid regex: ${(e as Error).message}. Pass regex:false to search it literally.`,
    );
  }

  const treeRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { method: "GET" },
    { retryTransient: true },
  );
  if (!treeRes.ok) {
    if (treeRes.status === 404) {
      throw new ExpectedToolError("not_found", `${owner}/${repo}@${ref}: tree not found`);
    }
    throw await githubReadError("grep tree", treeRes);
  }
  const tree = (await treeRes.json()) as {
    sha?: string;
    tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
    truncated?: boolean;
  };

  const globRe = path_glob ? globToRegExp(path_glob) : null;
  const candidates = (tree.tree ?? [])
    .filter(
      (e) =>
        e.type === "blob" &&
        typeof e.path === "string" &&
        !GREP_SKIP_EXT_RE.test(e.path) &&
        (e.size ?? 0) <= GREP_PER_FILE_BYTES &&
        (globRe ? globRe.test(e.path) : true),
    )
    .map((e) => ({ path: e.path as string, size: e.size ?? 0, sha: e.sha }));

  const ranked = rankGrepCandidates(candidates, pattern, regex);
  const fp = grepFingerprint(tree.sha ?? ref, pattern, regex, case_sensitive, path_glob);
  const resume = parseGrepCursor(cursor, fp, ranked.length);
  const offset = resume?.offset ?? 0;
  const cursorReset = cursor !== undefined && resume === null;

  const deadline = Date.now() + GREP_WALL_MS;
  const scanList = ranked.slice(offset, offset + GREP_CANDIDATE_CAP);
  const matches: Array<{ path: string; line_number: number; line: string }> = [];
  let scanned = 0;
  let bytes = 0;
  let stopped: string | null = null;
  const truncatedFiles: string[] = [];
  const failedFiles: string[] = [];
  let rateLimit: ExpectedToolError | null = null;
  let firstLimited = Infinity;
  let limitedFiles = 0;

  if (tree.truncated) stopped ??= "tree_truncated";
  if (ranked.length - offset > GREP_CANDIDATE_CAP) stopped ??= "candidate_cap";

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (rateLimit) return;
      if (matches.length >= max_matches) {
        stopped ??= "max_matches";
        return;
      }
      if (Date.now() > deadline) {
        stopped ??= "timeout";
        return;
      }
      if (next >= scanList.length) return;
      if (bytes + scanList[next].size > GREP_TOTAL_BYTES) {
        stopped ??= "byte_budget";
        return;
      }
      const idx = next++;
      const { path: filePath, size, sha } = scanList[idx];
      bytes += size;
      let content: string;
      try {
        const blobKey = sha ? `${installation_id}:${owner}/${repo}:${sha}` : null;
        const r =
          (blobKey ? grepBlobGet(blobKey) : undefined) ??
          (await readFileImpl(
            tenant_id,
            installation_id,
            { owner, repo, ref, path: filePath },
            GREP_PER_FILE_BYTES,
          ));
        if (blobKey) grepBlobPut(blobKey, { content: r.content, truncated: r.truncated });
        content = r.content;
        if (r.truncated) {
          truncatedFiles.push(filePath);
          stopped ??= "file_truncated";
        }
      } catch (e) {
        failedFiles.push(filePath);
        stopped ??= "file_error";
        if (e instanceof ExpectedToolError && e.code === "github_rate_limited") {
          rateLimit = e;
          firstLimited = Math.min(firstLimited, idx);
          limitedFiles++;
        }
        continue;
      }
      scanned++;
      const lines = content.split("\n");
      for (let n = 0; n < lines.length; n++) {
        if (matches.length >= max_matches) break;
        const line = lines[n];
        if (!re.test(line.slice(0, GREP_LINE_SCAN_CAP))) continue;
        matches.push({
          path: filePath,
          line_number: n + 1,
          line: line.slice(0, GREP_LINE_ECHO_CAP),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GREP_CONCURRENCY, Math.max(scanList.length, 1)) }, worker),
  );

  const resumeAt = offset + Math.min(next, firstLimited);
  const hitMaxMatches = matches.length >= max_matches;
  const partialSoFar =
    (resume?.partial ?? false) || failedFiles.length > limitedFiles || truncatedFiles.length > 0;
  if (resume?.partial) stopped ??= "earlier_page_partial";
  const nextCursor =
    !hitMaxMatches && resumeAt < ranked.length
      ? `v1.${fp}.${resumeAt}${partialSoFar ? ".p" : ""}`
      : null;
  const complete = stopped === null;
  const limitHit = rateLimit as ExpectedToolError | null;
  return {
    matches,
    scanned_files: scanned,
    candidate_files: candidates.length,
    complete,
    ...(stopped ? { stopped_because: stopped } : {}),
    ...(offset > 0 || nextCursor ? { scanned_range: [offset, resumeAt] } : {}),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    ...(cursorReset ? { cursor_reset: true } : {}),
    ...(truncatedFiles.length
      ? { partially_scanned_files: truncatedFiles.slice(0, 20) }
      : {}),
    ...(failedFiles.length ? { unread_files: failedFiles.slice(0, 20) } : {}),
    ...(complete
      ? {}
      : {
          hint: limitHit
            ? `Scan stopped early. ${limitHit.message}${nextCursor ? ` To continue after the wait, call grep again with the same arguments and cursor: "${nextCursor}".` : ""}`
            : stopped === "max_matches"
              ? "Hit max_matches — more matches may exist. Narrow the pattern or raise max_matches."
              : stopped === "earlier_page_partial"
                ? "This page finished the scan, but an earlier page could not fully read some files (its unread_files / partially_scanned_files). Zero matches is NOT proof of absence — read those paths directly with read_file."
              : stopped === "file_truncated"
                ? `Some files exceeded the per-file scan cap and were only scanned up to that point (see partially_scanned_files). Zero matches is NOT proof of absence — read those paths directly with read_file start_line/end_line.`
                : nextCursor
                  ? `Scan was bounded (${stopped}). Zero matches here is NOT proof the pattern is absent. To scan the next files, call grep again with the same arguments and cursor: "${nextCursor}" (re-running without it scans the same files again), or narrow with path_glob.`
                  : `Scan was bounded (${stopped}). Zero matches here is NOT proof the pattern is absent — narrow with path_glob and retry before concluding anything is missing.`,
        }),
  };
}

export async function searchCommitsImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, query, per_page }: {
    owner: string;
    repo: string;
    query: string;
    per_page: number;
  },
): Promise<{
  total: number;
  items: Array<{
    sha: string;
    message: string;
    url: string;
    author_date: string;
    repository_full_name: string;
  }>;
}> {
  const q = `${query} repo:${owner}/${repo}`;
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/search/commits?q=${encodeURIComponent(q)}&per_page=${per_page}`,
    { method: "GET", headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`search_commits HTTP ${res.status}`);
  const json = (await res.json()) as {
    total_count: number;
    items: Array<{
      sha: string;
      html_url: string;
      commit: { message: string; author?: { date?: string } | null };
      repository?: { full_name?: string } | null;
    }>;
  };
  return {
    total: json.total_count,
    items: json.items.map((i) => ({
      sha: i.sha,
      message: i.commit.message,
      url: i.html_url,
      author_date: i.commit.author?.date ?? "",
      repository_full_name:
        i.repository?.full_name ?? repoFullNameFromCommitUrl(i.html_url),
    })),
  };
}

function repoFullNameFromCommitUrl(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/commit\//.exec(url ?? "");
  return m ? `${m[1]}/${m[2]}` : "";
}

async function listOpenPrsImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, per_page }: z.infer<typeof listOpenPrsInput>,
) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=${per_page}`,
    { method: "GET" },
  );
  if (!res.ok) throw new Error(`list_open_prs HTTP ${res.status}`);
  const json = (await res.json()) as Array<{
    number: number;
    title: string;
    html_url?: string;
    user?: { login: string };
    head: { ref: string };
    base: { ref: string };
  }>;
  return {
    prs: json.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url ?? "",
      author: p.user?.login ?? "",
      head_branch: p.head.ref,
      base_branch: p.base.ref,
    })),
  };
}

export async function getPrImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, pull_number }: z.infer<typeof getPrInput>,
) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pull_number}`,
    { method: "GET" },
  );
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError("not_found", `${owner}/${repo}#${pull_number}: not found`);
    }
    throw new Error(`get_pr HTTP ${res.status}`);
  }
  const p = (await res.json()) as {
    number: number;
    state: string;
    merged?: boolean;
    merged_at?: string | null;
    head: { ref: string };
    base: { ref: string };
  };
  return {
    number: p.number,
    state: p.state,
    merged: p.merged ?? p.merged_at != null,
    head_branch: p.head.ref,
    base_branch: p.base.ref,
  };
}

async function getPrDiffImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, pull_number }: z.infer<typeof getPrDiffInput>,
) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pull_number}`,
    {
      method: "GET",
      headers: { accept: "application/vnd.github.v3.diff" },
    },
  );
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError("not_found", `${owner}/${repo}#${pull_number}: not found`);
    }
    throw new Error(`get_pr_diff HTTP ${res.status}`);
  }
  const text = await res.text();
  return capBody(text);
}

async function listPrStatusImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, pull_number }: z.infer<typeof listPrStatusInput>,
) {
  const prRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pull_number}`,
    { method: "GET" },
  );
  if (!prRes.ok) throw new Error(`list_pr_status pr HTTP ${prRes.status}`);
  const pr = (await prRes.json()) as { head: { sha: string } };

  const checksRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    { method: "GET" },
  );
  if (!checksRes.ok) throw new Error(`list_pr_status checks HTTP ${checksRes.status}`);
  const checks = (await checksRes.json()) as {
    total_count: number;
    check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
  };

  const reviewsRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pull_number}/reviews?per_page=100`,
    { method: "GET" },
  );
  if (!reviewsRes.ok) throw new Error(`list_pr_status reviews HTTP ${reviewsRes.status}`);
  const reviews = (await reviewsRes.json()) as Array<{ state: string; user?: { login: string } }>;

  const latestByReviewer = new Map<string, string>();
  for (const r of reviews) {
    const login = r.user?.login ?? "";
    if (!login) continue;
    latestByReviewer.set(login, r.state);
  }
  const approvals = Array.from(latestByReviewer.values()).filter((s) => s === "APPROVED").length;
  const requests = Array.from(latestByReviewer.values()).filter((s) => s === "CHANGES_REQUESTED").length;

  const allChecksGreen =
    checks.check_runs.length === 0 ||
    checks.check_runs.every((c) => c.status === "completed" && c.conclusion === "success");
  return {
    head_sha: pr.head.sha,
    checks_total: checks.check_runs.length,
    checks_green: allChecksGreen,
    check_runs: checks.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    })),
    approving_reviews: approvals,
    changes_requested_reviews: requests,
  };
}

async function findOpenPrForHead(
  tenant_id: string,
  installation_id: number,
  owner: string,
  repo: string,
  head_branch: string,
): Promise<{ number: number; url: string; head_sha: string } | null> {
  try {
    const res = await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(
        `${owner}:${head_branch}`,
      )}&per_page=1`,
      { method: "GET" },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{
      number: number;
      html_url?: string;
      head?: { sha?: string };
    }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const p = arr[0];
    return {
      number: p.number,
      url: p.html_url ?? "",
      head_sha: p.head?.sha ?? "",
    };
  } catch {
    return null;
  }
}

function repoFileReader(
  tenant_id: string,
  installation_id: number,
  owner: string,
  repo: string,
  ref: string,
): (path: string) => Promise<RepoFileRead> {
  return async (path: string): Promise<RepoFileRead> => {
    try {
      const res = await ghFetchWithRetry(
        tenant_id,
        installation_id,
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
        { method: "GET" },
      );
      if (res.status === 404) return { kind: "absent" };
      if (!res.ok) return { kind: "error", detail: `HTTP ${res.status}` };
      const json = (await res.json()) as { encoding?: string; content?: string; type?: string };
      if (json.type !== "file") return { kind: "absent" };
      if (json.encoding !== "base64" || typeof json.content !== "string") {
        return { kind: "error", detail: `unexpected encoding ${json.encoding ?? "none"}` };
      }
      return { kind: "found", content: Buffer.from(json.content, "base64").toString("utf-8") };
    } catch (e) {
      return { kind: "error", detail: String(e) };
    }
  };
}

async function openPrImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof openPrInput>,
) {
  const { owner, repo, base_branch, head_branch, title, body, files } = args;

  await assertDependencyAdmission(files, {
    readRepoFile: repoFileReader(tenant_id, installation_id, owner, repo, base_branch),
  });

  const baseRefRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch)}`,
    { method: "GET" },
  );
  if (!baseRefRes.ok) throw new Error(`open_pr base ref HTTP ${baseRefRes.status}`);
  const baseRef = (await baseRefRes.json()) as { object: { sha: string } };
  const baseSha = baseRef.object.sha;
  if (args.expected_base_sha && baseSha !== args.expected_base_sha) {
    throw new ExpectedToolError("base_moved", `open_pr: ${base_branch} moved since the change was checked, so no pull request was opened.`);
  }

  const treeEntries: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = [];
  for (const f of files) {
    if (f.action === "delete") {
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (typeof f.content !== "string") {
      throw new ExpectedToolError(
        "missing_content",
        `open_pr: file ${f.path} action=${f.action} requires content`,
      );
    }
    const blobRes = await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: f.encoding === "base64" ? f.content : Buffer.from(f.content, "utf-8").toString("base64"),
          encoding: "base64",
        }),
      },
    );
    if (!blobRes.ok) throw new Error(`open_pr blob ${f.path} HTTP ${blobRes.status}`);
    const blob = (await blobRes.json()) as { sha: string };
    treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: baseSha, tree: treeEntries }),
    },
  );
  if (!treeRes.ok) throw new Error(`open_pr tree HTTP ${treeRes.status}`);
  const tree = (await treeRes.json()) as { sha: string };

  const commitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: title,
        tree: tree.sha,
        parents: [baseSha],
      }),
    },
  );
  if (!commitRes.ok) throw new Error(`open_pr commit HTTP ${commitRes.status}`);
  const commit = (await commitRes.json()) as { sha: string };

  const refRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${head_branch}`,
        sha: commit.sha,
      }),
    },
  );
  if (!refRes.ok) {
    if (refRes.status === 422) {
      const existing = await findOpenPrForHead(
        tenant_id,
        installation_id,
        owner,
        repo,
        head_branch,
      );
      if (existing) {
        return {
          number: existing.number,
          url: existing.url,
          head_sha: existing.head_sha,
          commit_sha: existing.head_sha,
          reused: true,
        };
      }
    } else {
      throw new Error(`open_pr ref HTTP ${refRes.status}`);
    }
  }

  const prRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        head: head_branch,
        base: base_branch,
      }),
    },
  );
  if (!prRes.ok) {
    if (prRes.status === 422) {
      const existing = await findOpenPrForHead(
        tenant_id,
        installation_id,
        owner,
        repo,
        head_branch,
      );
      if (existing) {
        return {
          number: existing.number,
          url: existing.url,
          head_sha: existing.head_sha,
          commit_sha: existing.head_sha,
          reused: true,
        };
      }
    }
    throw new Error(`open_pr pull HTTP ${prRes.status}`);
  }
  const pr = (await prRes.json()) as {
    number: number;
    html_url: string;
    head: { sha: string };
  };
  return {
    number: pr.number,
    url: pr.html_url,
    head_sha: pr.head.sha,
    commit_sha: commit.sha,
  };
}

async function pushBranchImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof pushBranchInput>,
) {
  const { owner, repo, base_branch, head_branch, title, files } = args;

  await assertDependencyAdmission(files, {
    readRepoFile: repoFileReader(tenant_id, installation_id, owner, repo, base_branch),
  });

  const RETRY: GhFetchOpts = { retryTransient: true };

  const baseRefRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch)}`,
    { method: "GET" },
    RETRY,
  );
  if (!baseRefRes.ok) throw new Error(`push_branch base ref HTTP ${baseRefRes.status}`);
  const baseRef = (await baseRefRes.json()) as { object: { sha: string } };
  const baseSha = baseRef.object.sha;

  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
  for (const f of files) {
    if (f.action === "delete") {
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (typeof f.content !== "string") {
      throw new ExpectedToolError(
        "missing_content",
        `push_branch: file ${f.path} action=${f.action} requires content`,
      );
    }
    const blobRes = await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: f.encoding === "base64" ? f.content : Buffer.from(f.content, "utf-8").toString("base64"),
          encoding: "base64",
        }),
      },
      RETRY,
    );
    if (!blobRes.ok) throw new Error(`push_branch blob ${f.path} HTTP ${blobRes.status}`);
    const blob = (await blobRes.json()) as { sha: string };
    treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: baseSha, tree: treeEntries }),
    },
    RETRY,
  );
  if (!treeRes.ok) throw new Error(`push_branch tree HTTP ${treeRes.status}`);
  const tree = (await treeRes.json()) as { sha: string };

  const commitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: title, tree: tree.sha, parents: [baseSha] }),
    },
    RETRY,
  );
  if (!commitRes.ok) throw new Error(`push_branch commit HTTP ${commitRes.status}`);
  const commit = (await commitRes.json()) as { sha: string };

  const refRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${head_branch}`, sha: commit.sha }),
    },
    RETRY,
  );
  if (!refRes.ok) {
    if (refRes.status === 422) {
      const existingRes = await ghFetchWithRetry(
        tenant_id,
        installation_id,
        `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(head_branch)}`,
        { method: "GET" },
        RETRY,
      );
      if (existingRes.ok) {
        const existing = (await existingRes.json()) as { object: { sha: string } };
        return { head_branch, commit_sha: existing.object.sha, reused: true };
      }
    }
    throw new Error(`push_branch ref HTTP ${refRes.status}`);
  }
  return { head_branch, commit_sha: commit.sha, reused: false };
}

async function openPrFromBranchImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof openPrFromBranchInput>,
) {
  const { owner, repo, base_branch, head_branch, title, body } = args;
  const prRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body, head: head_branch, base: base_branch }),
    },
  );
  if (!prRes.ok) {
    if (prRes.status === 422) {
      const existing = await findOpenPrForHead(
        tenant_id,
        installation_id,
        owner,
        repo,
        head_branch,
      );
      if (existing) {
        return {
          number: existing.number,
          url: existing.url,
          head_sha: existing.head_sha,
          reused: true,
        };
      }
    }
    throw new Error(`open_pr_from_branch pull HTTP ${prRes.status}`);
  }
  const pr = (await prRes.json()) as { number: number; html_url: string; head: { sha: string } };
  return { number: pr.number, url: pr.html_url, head_sha: pr.head.sha, reused: false };
}

async function updatePrBranchImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof updatePrBranchInput>,
) {
  const { owner, repo, pull_number, head_branch, title, files } = args;

  await assertDependencyAdmission(files, {
    readRepoFile: repoFileReader(tenant_id, installation_id, owner, repo, head_branch),
  });

  if (isPlatformSourceRepo(owner, repo)) {
    throw new ExpectedToolError(
      "platform_source_repo_protected",
      "Direct branch update on the Zavi platform source repo is never permitted from an agent run.",
    );
  }

  await assertReadRepoMembership(tenant_id, owner, repo);

  const headRefRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${head_branch}`,
    { method: "GET" },
  );
  if (headRefRes.status === 404) {
    throw new ExpectedToolError(
      "branch_not_found",
      `update_pr_branch: head branch ${head_branch} does not exist on ${owner}/${repo}`,
    );
  }
  if (!headRefRes.ok) throw new Error(`update_pr_branch head ref HTTP ${headRefRes.status}`);
  const headRef = (await headRefRes.json()) as { object: { sha: string } };
  const headSha = headRef.object.sha;

  const headCommitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${headSha}`,
    { method: "GET" },
  );
  if (!headCommitRes.ok) throw new Error(`update_pr_branch head commit HTTP ${headCommitRes.status}`);
  const headCommit = (await headCommitRes.json()) as { tree: { sha: string } };
  const headTreeSha = headCommit.tree.sha;

  const treeEntries: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = [];
  for (const f of files) {
    if (f.action === "delete") {
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (typeof f.content !== "string") {
      throw new ExpectedToolError(
        "missing_content",
        `update_pr_branch: file ${f.path} action=${f.action} requires content`,
      );
    }
    const blobRes = await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: f.encoding === "base64" ? f.content : Buffer.from(f.content, "utf-8").toString("base64"),
          encoding: "base64",
        }),
      },
    );
    if (!blobRes.ok) throw new Error(`update_pr_branch blob ${f.path} HTTP ${blobRes.status}`);
    const blob = (await blobRes.json()) as { sha: string };
    treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: headTreeSha, tree: treeEntries }),
    },
  );
  if (!treeRes.ok) throw new Error(`update_pr_branch tree HTTP ${treeRes.status}`);
  const tree = (await treeRes.json()) as { sha: string };

  if (tree.sha === headTreeSha) {
    return {
      no_change: true,
      pull_number,
      head_branch,
      head_sha: headSha,
      commit_sha: null as string | null,
    };
  }

  const commitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: title,
        tree: tree.sha,
        parents: [headSha],
      }),
    },
  );
  if (!commitRes.ok) throw new Error(`update_pr_branch commit HTTP ${commitRes.status}`);
  const commit = (await commitRes.json()) as { sha: string };

  const patchRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${head_branch}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
  );
  if (!patchRes.ok) {
    if (patchRes.status === 422) {
      throw new ExpectedToolError(
        "non_fast_forward",
        `update_pr_branch: ${head_branch} advanced under us on ${owner}/${repo} — branch update not applied`,
      );
    }
    throw new Error(`update_pr_branch ref PATCH HTTP ${patchRes.status}`);
  }

  try {
    await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${pull_number}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: `[agent-auto] Pushed a follow-up commit to \`${head_branch}\` (${commit.sha.slice(0, 7)}): ${title}`,
        }),
      },
    );
  } catch {
  }

  return {
    no_change: false,
    pull_number,
    head_branch,
    head_sha: commit.sha,
    commit_sha: commit.sha,
  };
}

export const PUSH_BLOB_CONCURRENCY = 5;

export async function mapInOrderWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures = new Map<number, unknown>();
  let next = 0;
  const worker = async () => {
    while (failures.size === 0 && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failures.set(i, e);
      }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}

async function pushToMainImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof pushToMainInput>,
) {
  const { owner, repo, base_branch, title, files } = args;

  await assertDependencyAdmission(files, {
    readRepoFile: repoFileReader(tenant_id, installation_id, owner, repo, base_branch),
  });

  if (isPlatformSourceRepo(owner, repo)) {
    throw new ExpectedToolError(
      "platform_source_repo_protected",
      "Direct push to the Zavi platform source repo is never permitted from an agent run. Open a PR instead — a human merges it.",
    );
  }

  const baseRefRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch)}`,
    { method: "GET" },
  );
  if (!baseRefRes.ok) throw new Error(`push_to_main base ref HTTP ${baseRefRes.status}`);
  const baseRef = (await baseRefRes.json()) as { object: { sha: string } };
  const baseSha = baseRef.object.sha;

  for (const f of files) {
    if (f.action !== "delete" && typeof f.content !== "string") {
      throw new ExpectedToolError(
        "missing_content",
        `push_to_main: file ${f.path} action=${f.action} requires content`,
      );
    }
  }
  const treeEntries: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    sha: string | null;
  }> = await mapInOrderWithConcurrency(files, PUSH_BLOB_CONCURRENCY, async (f) => {
    if (f.action === "delete") {
      return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: null };
    }
    const content = f.content as string;
    const blobRes = await ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: f.encoding === "base64" ? content : Buffer.from(content, "utf-8").toString("base64"),
          encoding: "base64",
        }),
      },
    );
    if (!blobRes.ok) throw new Error(`push_to_main blob ${f.path} HTTP ${blobRes.status}`);
    const blob = (await blobRes.json()) as { sha: string };
    return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
  });

  const treeRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: baseSha, tree: treeEntries }),
    },
  );
  if (!treeRes.ok) throw new Error(`push_to_main tree HTTP ${treeRes.status}`);
  const tree = (await treeRes.json()) as { sha: string };

  const commitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: title,
        tree: tree.sha,
        parents: [baseSha],
      }),
    },
  );
  if (!commitRes.ok) throw new Error(`push_to_main commit HTTP ${commitRes.status}`);
  const commit = (await commitRes.json()) as { sha: string };

  const refRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(base_branch)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
  );
  if (!refRes.ok) {
    if (refRes.status === 422) {
      const text = await refRes.text().catch(() => "");
      throw new ExpectedToolError(
        "fast_forward_rejected",
        `push_to_main: ${base_branch} moved under us (422) — ${text.slice(0, 240)}`,
      );
    }
    throw new Error(`push_to_main ref HTTP ${refRes.status}`);
  }
  return {
    pushed: true,
    branch: base_branch,
    commit_sha: commit.sha,
  };
}

export async function revertCommitOnMain(params: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  base_branch: string;
  commit_sha: string;
  expected_head_sha?: string;
}): Promise<{ reverted: true; branch: string; new_commit_sha: string }> {
  const { tenant_id, installation_id, owner, repo, base_branch, commit_sha, expected_head_sha } = params;

  if (isPlatformSourceRepo(owner, repo)) {
    throw new ExpectedToolError(
      "platform_source_repo_protected",
      "Reverting a commit on the Zavi platform source repo is never permitted from an agent run. A human reverts via a PR.",
    );
  }

  const commitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${encodeURIComponent(commit_sha)}`,
    { method: "GET" },
  );
  if (!commitRes.ok) {
    if (commitRes.status === 404) {
      throw new ExpectedToolError(
        "commit_not_found",
        `revert: commit ${commit_sha} not found in ${owner}/${repo}`,
      );
    }
    throw new Error(`revert get-commit HTTP ${commitRes.status}`);
  }
  const target = (await commitRes.json()) as {
    sha: string;
    parents: Array<{ sha: string }>;
    message: string;
  };
  if (!target.parents || target.parents.length === 0) {
    throw new ExpectedToolError(
      "revert_root_commit",
      `revert: ${commit_sha} is the root commit (no parent to revert to)`,
    );
  }
  if (target.parents.length > 1) {
    throw new ExpectedToolError(
      "revert_merge_commit",
      `revert: ${commit_sha} is a merge commit (${target.parents.length} parents) — needs explicit mainline pick, not supported by autopilot undo`,
    );
  }
  const parentSha = target.parents[0].sha;

  const parentRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${encodeURIComponent(parentSha)}`,
    { method: "GET" },
  );
  if (!parentRes.ok) {
    throw new Error(`revert get-parent HTTP ${parentRes.status}`);
  }
  const parent = (await parentRes.json()) as { tree: { sha: string } };
  const restoreTreeSha = parent.tree.sha;

  const headRefRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch)}`,
    { method: "GET" },
  );
  if (!headRefRes.ok) {
    throw new Error(`revert head-ref HTTP ${headRefRes.status}`);
  }
  const headRef = (await headRefRes.json()) as { object: { sha: string } };
  const headSha = headRef.object.sha;
  if (expected_head_sha !== undefined && headSha.toLowerCase() !== expected_head_sha.toLowerCase()) {
    throw new ExpectedToolError(
      "revert_head_moved",
      `revert: ${base_branch} is at ${headSha.slice(0, 7)}, expected ${expected_head_sha.slice(0, 7)}`,
    );
  }

  const originalSubject = (target.message || "").split("\n")[0] || "previous commit";
  const revertMessage = `Revert "${originalSubject}"\n\nThis reverts commit ${commit_sha}.\n`;
  const newCommitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: revertMessage,
        tree: restoreTreeSha,
        parents: [headSha],
      }),
    },
  );
  if (!newCommitRes.ok) {
    throw new Error(`revert create-commit HTTP ${newCommitRes.status}`);
  }
  const newCommit = (await newCommitRes.json()) as { sha: string };

  const refRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(base_branch)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    },
  );
  if (!refRes.ok) {
    if (refRes.status === 422) {
      const text = await refRes.text().catch(() => "");
      throw new ExpectedToolError(
        "fast_forward_rejected",
        `revert: ${base_branch} moved under us (422) — ${text.slice(0, 240)}`,
      );
    }
    throw new Error(`revert ref-update HTTP ${refRes.status}`);
  }
  return { reverted: true, branch: base_branch, new_commit_sha: newCommit.sha };
}

export async function readCommitParentSha(params: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  commit_sha: string;
}): Promise<string | null> {
  const { tenant_id, installation_id, owner, repo, commit_sha } = params;
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${encodeURIComponent(commit_sha)}`,
    { method: "GET" },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read-commit HTTP ${res.status}`);
  const commit = (await res.json()) as { parents?: Array<{ sha: string }> };
  return commit.parents?.[0]?.sha ?? null;
}

export async function restoreCommitOnMain(params: {
  tenant_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  base_branch: string;
  commit_sha: string;
  label?: string;
}): Promise<{ restored: true; branch: string; new_commit_sha: string; noop: boolean }> {
  const { tenant_id, installation_id, owner, repo, base_branch, commit_sha } = params;
  if (isPlatformSourceRepo(owner, repo)) {
    throw new ExpectedToolError(
      "platform_source_repo_protected",
      "Restoring a version on the Zavi platform source repo is never permitted from an agent run.",
    );
  }
  const commitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${encodeURIComponent(commit_sha)}`,
    { method: "GET" },
  );
  if (!commitRes.ok) {
    if (commitRes.status === 404) {
      throw new ExpectedToolError("commit_not_found", `restore: commit ${commit_sha} not found in ${owner}/${repo}`);
    }
    throw new Error(`restore get-commit HTTP ${commitRes.status}`);
  }
  const target = (await commitRes.json()) as { sha: string; tree: { sha: string }; message: string };

  const headRefRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base_branch)}`,
    { method: "GET" },
  );
  if (!headRefRes.ok) throw new Error(`restore head-ref HTTP ${headRefRes.status}`);
  const headSha = ((await headRefRes.json()) as { object: { sha: string } }).object.sha;

  const headRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${encodeURIComponent(headSha)}`,
    { method: "GET" },
  );
  if (!headRes.ok) throw new Error(`restore get-head HTTP ${headRes.status}`);
  const head = (await headRes.json()) as { tree: { sha: string } };
  if (head.tree.sha === target.tree.sha) {
    return { restored: true, branch: base_branch, new_commit_sha: headSha, noop: true };
  }

  const subject = (params.label || target.message || "").split("\n")[0] || commit_sha.slice(0, 7);
  const message = `Restore "${subject}"\n\nThis restores the files as of commit ${commit_sha}.\n`;
  const newCommitRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree: target.tree.sha, parents: [headSha] }),
    },
  );
  if (!newCommitRes.ok) throw new Error(`restore create-commit HTTP ${newCommitRes.status}`);
  const newCommit = (await newCommitRes.json()) as { sha: string };

  const refRes = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(base_branch)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    },
  );
  if (!refRes.ok) {
    if (refRes.status === 422) {
      const text = await refRes.text().catch(() => "");
      throw new ExpectedToolError("fast_forward_rejected", `restore: ${base_branch} moved under us (422) — ${text.slice(0, 240)}`);
    }
    throw new Error(`restore ref-update HTTP ${refRes.status}`);
  }
  return { restored: true, branch: base_branch, new_commit_sha: newCommit.sha, noop: false };
}

type RepoAuth = { tenant_id: string; installation_id: number; owner: string; repo: string };

function assertNotPlatformRepo(a: RepoAuth, action: string): void {
  if (isPlatformSourceRepo(a.owner, a.repo)) {
    throw new ExpectedToolError(
      "platform_source_repo_protected",
      `${action} on the Zavi platform source repo is never permitted.`,
    );
  }
}

export async function readBranchSha(a: RepoAuth & { branch: string }): Promise<string | null> {
  const res = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/ref/heads/${encodeURIComponent(a.branch)}`,
    { method: "GET" },
    { retryTransient: true },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read-branch HTTP ${res.status}`);
  return ((await res.json()) as { object: { sha: string } }).object.sha;
}

export async function compareBranches(
  a: RepoAuth & { base: string; head: string },
): Promise<{ ahead_by: number; behind_by: number; commits: Array<{ sha: string; message: string }> } | null> {
  const res = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/compare/${encodeURIComponent(a.base)}...${encodeURIComponent(a.head)}`,
    { method: "GET" },
    { retryTransient: true },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`compare HTTP ${res.status}`);
  const j = (await res.json()) as {
    ahead_by?: number;
    behind_by?: number;
    commits?: Array<{ sha: string; commit?: { message?: string } }>;
  };
  return {
    ahead_by: Number(j.ahead_by ?? 0),
    behind_by: Number(j.behind_by ?? 0),
    commits: (j.commits ?? []).map((c) => ({
      sha: c.sha,
      message: (c.commit?.message ?? "").split("\n")[0].slice(0, 200),
    })),
  };
}

export async function commitFilesToBranch(
  a: RepoAuth & {
    branch: string;
    fallback_base: string;
    message: string;
    files: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }>;
    expected_parent_sha?: string;
  },
): Promise<{ branch: string; commit_sha: string; created: boolean }> {
  assertNotPlatformRepo(a, "Committing a draft");
  const RETRY: GhFetchOpts = { retryTransient: true };
  const existing = await readBranchSha(a);
  if (a.expected_parent_sha !== undefined && existing !== a.expected_parent_sha) {
    throw new ExpectedToolError("branch_moved", `commit-to-branch: ${a.branch} moved under us`);
  }
  const parentSha = existing ?? (await readBranchSha({ ...a, branch: a.fallback_base }));
  if (!parentSha) throw new Error(`commit-to-branch: base ${a.fallback_base} not found`);

  await assertDependencyAdmission(a.files, {
    readRepoFile: repoFileReader(a.tenant_id, a.installation_id, a.owner, a.repo, existing ? a.branch : a.fallback_base),
  });

  const parentRes = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/commits/${encodeURIComponent(parentSha)}`,
    { method: "GET" },
    RETRY,
  );
  if (!parentRes.ok) throw new Error(`commit-to-branch parent HTTP ${parentRes.status}`);
  const parentTree = ((await parentRes.json()) as { tree: { sha: string } }).tree.sha;

  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
  for (const f of a.files) {
    if (f.action === "delete") {
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (typeof f.content !== "string") {
      throw new ExpectedToolError("missing_content", `commit-to-branch: file ${f.path} requires content`);
    }
    const blobRes = await ghFetchWithRetry(
      a.tenant_id,
      a.installation_id,
      `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/blobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: f.encoding === "base64" ? f.content : Buffer.from(f.content, "utf-8").toString("base64"),
          encoding: "base64",
        }),
      },
      RETRY,
    );
    if (!blobRes.ok) throw new Error(`commit-to-branch blob ${f.path} HTTP ${blobRes.status}`);
    treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: ((await blobRes.json()) as { sha: string }).sha });
  }

  const treeRes = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: parentTree, tree: treeEntries }),
    },
    RETRY,
  );
  if (!treeRes.ok) throw new Error(`commit-to-branch tree HTTP ${treeRes.status}`);
  const treeSha = ((await treeRes.json()) as { sha: string }).sha;

  const commitRes = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: a.message, tree: treeSha, parents: [parentSha] }),
    },
    RETRY,
  );
  if (!commitRes.ok) throw new Error(`commit-to-branch commit HTTP ${commitRes.status}`);
  const commitSha = ((await commitRes.json()) as { sha: string }).sha;

  const refRes = existing
    ? await ghFetchWithRetry(
        a.tenant_id,
        a.installation_id,
        `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/refs/heads/${encodeURIComponent(a.branch)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sha: commitSha, force: false }),
        },
      )
    : await ghFetchWithRetry(
        a.tenant_id,
        a.installation_id,
        `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/refs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref: `refs/heads/${a.branch}`, sha: commitSha }),
        },
      );
  if (!refRes.ok) {
    if (refRes.status === 422) {
      throw new ExpectedToolError("branch_moved", `commit-to-branch: ${a.branch} moved under us (422)`);
    }
    throw new Error(`commit-to-branch ref HTTP ${refRes.status}`);
  }
  return { branch: a.branch, commit_sha: commitSha, created: !existing };
}

export async function fastForwardBranch(
  a: RepoAuth & { branch: string; to_sha: string },
): Promise<void> {
  assertNotPlatformRepo(a, "Publishing");
  const res = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/refs/heads/${encodeURIComponent(a.branch)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: a.to_sha, force: false }),
    },
  );
  if (!res.ok) {
    if (res.status === 422) {
      throw new ExpectedToolError("fast_forward_rejected", `${a.branch} is not an ancestor of ${a.to_sha.slice(0, 7)}`);
    }
    throw new Error(`fast-forward HTTP ${res.status}`);
  }
}

export async function deleteBranch(a: RepoAuth & { branch: string }): Promise<boolean> {
  assertNotPlatformRepo(a, "Deleting a branch");
  const res = await ghFetchWithRetry(
    a.tenant_id,
    a.installation_id,
    `${GITHUB_API}/repos/${a.owner}/${a.repo}/git/refs/heads/${encodeURIComponent(a.branch)}`,
    { method: "DELETE" },
  );
  if (res.status === 404 || res.status === 422) return false;
  if (!res.ok) throw new Error(`delete-branch HTTP ${res.status}`);
  return true;
}

export { resolveInstallationId };

export async function readBranchHeadSha(tenant_id: string, installation_id: number, owner: string, repo: string, branch: string): Promise<string> {
  const res = await ghFetchWithRetry(tenant_id, installation_id, `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { method: "GET" }, { retryTransient: true });
  if (!res.ok) throw new Error(`base ref HTTP ${res.status}`);
  const sha = ((await res.json()) as { object?: { sha?: string } }).object?.sha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("base ref unreadable");
  return sha;
}

async function postReviewImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof postReviewInput>,
  override: "COMMENT_OR_INPUT" | "REQUEST_CHANGES",
) {
  const event = override === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : args.event;
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/reviews`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: args.body, event }),
    },
  );
  if (!res.ok) throw new Error(`post_review HTTP ${res.status}`);
  const json = (await res.json()) as { id: number; state: string };
  return { review_id: json.id, state: json.state };
}

async function addLabelImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof addLabelInput>,
) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${args.owner}/${args.repo}/issues/${args.pull_number}/labels`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: args.labels }),
    },
  );
  if (!res.ok) throw new Error(`add_label HTTP ${res.status}`);
  const json = (await res.json()) as Array<{ name: string }>;
  return { labels: json.map((l) => l.name) };
}

async function squashMergeImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof squashMergeInput>,
) {
  if (isPlatformSourceRepo(args.owner, args.repo)) {
    throw new ExpectedToolError(
      "platform_source_repo_protected",
      "Merging a PR into the Zavi platform source repo is never permitted from an agent run. A human must merge it.",
    );
  }
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commit_title: args.commit_title,
        commit_message: args.commit_message,
        merge_method: "squash",
      }),
    },
  );
  if (!res.ok) {
    if (res.status === 405 || res.status === 409) {
      const text = await res.text().catch(() => "");
      throw new ExpectedToolError(
        "merge_blocked",
        `squash_merge: ${res.status} ${text.slice(0, 240)}`,
      );
    }
    throw new Error(`squash_merge HTTP ${res.status}`);
  }
  const json = (await res.json()) as { sha: string; merged: boolean };
  return { merged: json.merged, sha: json.sha };
}

async function closePrImpl(
  tenant_id: string,
  installation_id: number,
  args: z.infer<typeof closePrInput>,
) {
  const res = await ghFetchWithRetry(
    tenant_id,
    installation_id,
    `${GITHUB_API}/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    },
  );
  if (!res.ok) throw new Error(`close_pr HTTP ${res.status}`);
  return { closed: true };
}

async function searchIssuesImpl(
  tenant_id: string,
  installation_id: number,
  { query, max_results }: z.infer<typeof searchIssuesInput>,
) {
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=${max_results}`;
  const res = await ghFetchWithRetry(tenant_id, installation_id, url, { method: "GET" });
  if (!res.ok) {
    if (res.status === 422) {
      throw new ExpectedToolError(
        "github_search_query_invalid",
        `GitHub Issues search query rejected: ${query}. Check the DSL — needs at least one qualifier like 'is:issue' or 'repo:owner/name'.`,
      );
    }
    throw new Error(`search_issues HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    total_count?: number;
    items?: Array<{
      number?: number;
      title?: string;
      state?: string;
      html_url?: string;
      user?: { login?: string };
      repository_url?: string;
      labels?: Array<{ name?: string }>;
      created_at?: string;
    }>;
  };
  let allowedRepos: Set<string> | null = null;
  try {
    const scoped = await resolveScopedRepos(tenant_id);
    allowedRepos = scoped.mode === "all" ? null : new Set(scoped.repos);
  } catch {
    allowedRepos = new Set();
  }
  const repoOf = (repository_url: string | undefined): string => {
    const m = (repository_url ?? "").match(/\/repos\/([^/]+\/[^/]+)$/);
    return m ? m[1] : "";
  };
  const items = (json.items ?? [])
    .filter(
      (i) => allowedRepos === null || allowedRepos.has(repoOf(i.repository_url)),
    )
    .map((i) => ({
      number: i.number ?? 0,
      title: i.title ?? "",
      state: i.state ?? "",
      html_url: i.html_url ?? "",
      user_login: i.user?.login ?? "",
      repository_url: i.repository_url ?? "",
      labels: (i.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
      created_at: i.created_at ?? "",
    }));
  return {
    total_count:
      allowedRepos === null ? (json.total_count ?? 0) : items.length,
    items,
  };
}

export async function listBranchesImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, max_results }: z.infer<typeof listBranchesInput>,
  page = 1,
) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/branches?per_page=${max_results}&page=${page}`;
  const res = await ghFetchWithRetry(tenant_id, installation_id, url, { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError("not_found", `${owner}/${repo}: not found`);
    }
    throw new Error(`list_branches HTTP ${res.status}`);
  }
  const json = (await res.json()) as Array<{
    name?: string;
    commit?: { sha?: string };
    protected?: boolean;
  }>;
  return {
    branches: json.map((b) => ({
      name: b.name ?? "",
      sha: b.commit?.sha ?? "",
      protected: !!b.protected,
    })),
  };
}

async function getMeImpl(tenant_id: string, installation_id: number) {
  const [appRes, reposRes] = await Promise.all([
    ghFetchWithRetry(tenant_id, installation_id, `${GITHUB_API}/app`, { method: "GET" }),
    ghFetchWithRetry(
      tenant_id,
      installation_id,
      `${GITHUB_API}/installation/repositories?per_page=100`,
      { method: "GET" },
    ),
  ]);
  if (!appRes.ok) throw new Error(`get_me /app HTTP ${appRes.status}`);
  if (!reposRes.ok) throw new Error(`get_me /installation/repositories HTTP ${reposRes.status}`);
  const app = (await appRes.json()) as {
    id?: number;
    name?: string;
    slug?: string;
    html_url?: string;
  };
  const repos = (await reposRes.json()) as {
    total_count?: number;
    repositories?: Array<{ full_name?: string }>;
  };
  let scopedNames: string[] | null = null;
  try {
    const scoped = await resolveScopedRepos(tenant_id);
    scopedNames = scoped.mode === "all" ? null : scoped.repos;
  } catch {
    scopedNames = [];
  }
  const installNames = (repos.repositories ?? []).map((r) => r.full_name ?? "");
  const visibleNames =
    scopedNames === null
      ? installNames
      : installNames.filter((n) => scopedNames!.includes(n));
  return {
    app_id: app.id ?? 0,
    app_name: app.name ?? app.slug ?? "",
    app_slug: app.slug ?? "",
    app_url: app.html_url ?? "",
    installation_id,
    repo_count:
      scopedNames === null
        ? (repos.total_count ?? installNames.length)
        : visibleNames.length,
    accessible_repos: visibleNames.slice(0, 5),
  };
}

export async function listCommitsImpl(
  tenant_id: string,
  installation_id: number,
  { owner, repo, branch, since, max_results }: z.infer<typeof listCommitsInput>,
) {
  const params = new URLSearchParams();
  params.set("per_page", String(max_results));
  if (branch) params.set("sha", branch);
  if (since) params.set("since", since);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?${params.toString()}`;
  const res = await ghFetchWithRetry(tenant_id, installation_id, url, { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError(
        "not_found",
        `${owner}/${repo}${branch ? "@" + branch : ""}: not found`,
      );
    }
    throw new Error(`list_commits HTTP ${res.status}`);
  }
  const json = (await res.json()) as Array<{
    sha?: string;
    author?: { login?: string };
    commit?: { author?: { date?: string }; message?: string };
    html_url?: string;
  }>;
  return {
    commits: json.map((c) => ({
      sha: c.sha ?? "",
      author_login: c.author?.login ?? "",
      author_date: c.commit?.author?.date ?? "",
      message: (c.commit?.message ?? "").split("\n")[0],
      html_url: c.html_url ?? "",
    })),
  };
}

async function listTeamsImpl(
  tenant_id: string,
  installation_id: number,
  { org, max_results }: z.infer<typeof listTeamsInput>,
) {
  let allowedOrgs: Set<string> | null = null;
  try {
    const resolved = await resolveScopedOrgs(tenant_id);
    allowedOrgs = resolved.mode === "all" ? null : resolved.allowedOrgs;
  } catch {
    allowedOrgs = new Set();
  }
  if (allowedOrgs !== null && !allowedOrgs.has(org)) {
    throw new ExpectedToolError(
      "repo_not_authorized",
      `org '${org}' has no repository in this tenant's selected repositories${
        allowedOrgs.size
          ? ` [${[...allowedOrgs].join(", ")}]`
          : ""
      }. The operator restricted which repos Zavi may reach — list_teams is limited to orgs that own a selected repo.`,
    );
  }
  const url = `${GITHUB_API}/orgs/${encodeURIComponent(org)}/teams?per_page=${max_results}`;
  const res = await ghFetchWithRetry(tenant_id, installation_id, url, { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) {
      throw new ExpectedToolError(
        "not_found",
        `org '${org}': not found or installation lacks org-read scope.`,
      );
    }
    throw new Error(`list_teams HTTP ${res.status}`);
  }
  const json = (await res.json()) as Array<{
    id?: number;
    slug?: string;
    name?: string;
    description?: string;
    parent?: { slug?: string };
  }>;
  return {
    teams: json.map((t) => ({
      id: t.id ?? 0,
      slug: t.slug ?? "",
      name: t.name ?? "",
      description: t.description ?? "",
      parent_team_slug: t.parent?.slug ?? null,
    })),
  };
}
