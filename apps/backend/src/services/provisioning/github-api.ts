
import type { LogEventInput } from "@/services/logging/logEvent";

export type GitHubHeaders = { get(name: string): string | null };

export type GitHubResponse = {
  status: number;
  headers?: GitHubHeaders;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export type GitHubFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<GitHubResponse>;

export type GitHubFailure = {
  status: number;
  message: string | null;
  errors: string[];
  documentation_url: string | null;
  request_id: string | null;
  date: string | null;
  ratelimit_remaining: number | null;
  ratelimit_reset: number | null;
  ratelimit_resource: string | null;
  retry_after_s: number | null;
  accepted_permissions: string | null;
  oauth_scopes: string | null;
  token_expiration: string | null;
  sso_required: boolean;
};

const MAX_FIELD = 200;
const MAX_ERRORS = 3;

function oneLine(v: unknown, max = MAX_FIELD): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function header(res: GitHubResponse, name: string): string | null {
  try {
    const v = res.headers?.get?.(name);
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 128) : null;
  } catch {
    return null;
  }
}

function intHeader(res: GitHubResponse, name: string): number | null {
  const v = header(res, name);
  if (v === null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function errorLine(e: unknown): string | null {
  if (typeof e === "string") return oneLine(e, 160);
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const where = [oneLine(o.resource, 40), oneLine(o.field, 40)].filter(Boolean).join(".");
  const code = oneLine(o.code, 40);
  const message = oneLine(o.message, 160);
  const head = [where, code].filter(Boolean).join(" ");
  const line = head && message ? `${head}: ${message}` : head || message;
  return line ? line.slice(0, MAX_FIELD) : null;
}

export async function readGitHubFailure(res: GitHubResponse): Promise<GitHubFailure> {
  let body: unknown = null;
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.split("\n").find((l) => l.trim()) ?? null };
    }
  } catch {
    body = null;
  }
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errors = Array.isArray(b.errors) ? b.errors.map(errorLine).filter((l): l is string => !!l).slice(0, MAX_ERRORS) : [];
  return {
    status: res.status,
    message: oneLine(b.message),
    errors,
    documentation_url: oneLine(b.documentation_url),
    request_id: header(res, "x-github-request-id"),
    date: header(res, "date"),
    ratelimit_remaining: intHeader(res, "x-ratelimit-remaining"),
    ratelimit_reset: intHeader(res, "x-ratelimit-reset"),
    ratelimit_resource: header(res, "x-ratelimit-resource"),
    retry_after_s: intHeader(res, "retry-after"),
    accepted_permissions: header(res, "x-accepted-github-permissions"),
    oauth_scopes: header(res, "x-oauth-scopes"),
    token_expiration: header(res, "github-authentication-token-expiration"),
    sso_required: header(res, "x-github-sso") !== null,
  };
}

function replay(res: GitHubResponse, text: string): GitHubResponse {
  return {
    status: res.status,
    ...(res.headers ? { headers: res.headers } : {}),
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

export function isGitHubRateLimit(f: GitHubFailure): boolean {
  if (f.status === 429) return true;
  if (f.status !== 403) return false;
  if (f.retry_after_s !== null) return true;
  if (f.ratelimit_remaining === 0) return true;
  return /rate limit|abuse detection/i.test(f.message ?? "");
}

export function isRetryableGitHubFailure(f: GitHubFailure): boolean {
  return f.status >= 500 || isGitHubRateLimit(f);
}

export function shortGitHubFailure(f: GitHubFailure): string {
  const parts: string[] = [];
  if (f.message) parts.push(`GitHub said "${f.message.slice(0, 160)}"`);
  if (isGitHubRateLimit(f)) {
    parts.push(`rate limited${f.retry_after_s !== null ? `, retry after ${f.retry_after_s}s` : ""}`);
  }
  if (f.request_id) parts.push(`request ${f.request_id}`);
  return parts.join("; ");
}

export function describeGitHubFailure(f: GitHubFailure): string {
  const parts: string[] = [];
  if (f.message) parts.push(`GitHub said "${f.message}"`);
  if (f.errors.length) parts.push(`errors: ${f.errors.join("; ")}`);
  if (isGitHubRateLimit(f)) {
    parts.push(
      `rate limited${f.ratelimit_resource ? ` (${f.ratelimit_resource})` : ""}${f.retry_after_s !== null ? `, retry after ${f.retry_after_s}s` : ""}`,
    );
  }
  if (f.sso_required) parts.push("org requires SSO authorization for this token");
  if (f.accepted_permissions !== null) parts.push(`endpoint needs ${f.accepted_permissions || "(none listed)"}`);
  if (f.oauth_scopes !== null) parts.push(`token scopes ${f.oauth_scopes || "(none)"}`);
  if (f.token_expiration) parts.push(`token expires ${f.token_expiration}`);
  if (f.request_id) parts.push(`request ${f.request_id}`);
  if (f.date) parts.push(`at ${f.date}`);
  return parts.join("; ");
}

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  readonly status: number;
  readonly failure: GitHubFailure;
  readonly retryable: boolean;
  constructor(what: string, failure: GitHubFailure) {
    const detail = shortGitHubFailure(failure);
    super(`${what} failed (${failure.status})${detail ? `: ${detail}` : ""}`.slice(0, 400));
    this.status = failure.status;
    this.failure = failure;
    this.retryable = isRetryableGitHubFailure(failure);
  }
}

export type GitHubAttemptFailure = {
  method: string;
  path: string;
  attempt: number;
  attempts: number;
  will_retry: boolean;
  failure: GitHubFailure | null;
  network_error: string | null;
  recovered?: boolean;
};

export type GitHubRetryOptions = {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  attemptTimeoutMs?: number;
  deadline?: () => number | null;
  nowMs?: () => number;
  onFailure?: (f: GitHubAttemptFailure) => void;
  expected?: (method: string, status: number) => boolean;
};

export const GITHUB_RETRY_ATTEMPTS = 3;
export const GITHUB_RETRY_BASE_MS = 1_000;
export const GITHUB_RETRY_MAX_DELAY_MS = 10_000;
export const GITHUB_ATTEMPT_TIMEOUT_MS = 30_000;

export function gitHubPathTemplate(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? "";
  }
  return path
    .replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/:owner/:repo")
    .replace(/^\/orgs\/[^/]+/, "/orgs/:org")
    .replace(/\/git\/(refs?)\/heads\/.+$/, "/git/$1/heads/:branch")
    .slice(0, 200);
}

export function gitHubRetryDelayMs(
  f: GitHubFailure | null,
  retry: number,
  o: { baseDelayMs?: number; maxDelayMs?: number; nowMs?: () => number } = {},
): number | null {
  const maxDelayMs = o.maxDelayMs ?? GITHUB_RETRY_MAX_DELAY_MS;
  if (f && !isRetryableGitHubFailure(f)) return null;
  if (f && isGitHubRateLimit(f)) {
    const nowS = Math.floor((o.nowMs ?? Date.now)() / 1000);
    let ms: number;
    if (f.retry_after_s !== null) ms = f.retry_after_s * 1000;
    else if (f.ratelimit_remaining === 0 && f.ratelimit_reset !== null) ms = Math.max(0, f.ratelimit_reset - nowS) * 1000 + 1000;
    else ms = 60_000;
    return ms <= maxDelayMs ? ms : null;
  }
  const backoff = (o.baseDelayMs ?? GITHUB_RETRY_BASE_MS) * 2 ** (retry - 1);
  return Math.min(maxDelayMs, Math.round(backoff * (1 + Math.random() * 0.25)));
}

export function errorClass(e: unknown): string {
  const name = (e as { name?: unknown })?.name;
  return typeof name === "string" && name ? name.slice(0, 40) : typeof e;
}

export function withGitHubRetry(fetchFn: GitHubFetch, opts: GitHubRetryOptions = {}): GitHubFetch {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, opts.attempts ?? GITHUB_RETRY_ATTEMPTS);
  const nowMs = opts.nowMs ?? Date.now;
  const timeoutMs = opts.attemptTimeoutMs ?? GITHUB_ATTEMPT_TIMEOUT_MS;
  const expected = opts.expected ?? ((method: string, status: number) => status === 404 && (method === "GET" || method === "DELETE"));
  const report = (f: GitHubAttemptFailure) => {
    try {
      opts.onFailure?.(f);
    } catch {
    }
  };
  const waitFor = (f: GitHubFailure | null, retry: number, last: boolean): number | null => {
    if (last) return null;
    const ms = gitHubRetryDelayMs(f, retry, { baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs, nowMs });
    if (ms === null) return null;
    const deadline = opts.deadline?.() ?? null;
    return deadline !== null && nowMs() + ms > deadline ? null : ms;
  };

  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = gitHubPathTemplate(url);
    const callerSignal = init?.signal;
    for (let attempt = 0; ; attempt++) {
      if (callerSignal?.aborted) throw abortError("the caller cancelled the GitHub request");
      const last = attempt >= attempts - 1;
      const deadline = opts.deadline?.() ?? null;
      const remaining = deadline === null ? Infinity : deadline - nowMs();
      if (remaining <= 0) throw budgetExhausted();
      const limitMs = Math.min(timeoutMs, remaining);
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const onCallerAbort = () => controller?.abort();
      if (controller && callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      const timer = controller && limitMs > 0 && Number.isFinite(limitMs) ? setTimeout(() => controller.abort(), limitMs) : null;
      (timer as { unref?: () => void } | null)?.unref?.();
      const clear = () => {
        if (timer) clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      };
      let res: GitHubResponse;
      let text: string;
      try {
        res = await fetchFn(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
        if ((res.status >= 200 && res.status < 300) || expected(method, res.status)) {
          const ok = res;
          return {
            status: ok.status,
            ...(ok.headers ? { headers: ok.headers } : {}),
            json: () => ok.json().finally(clear),
            text: () => ok.text().finally(clear),
          };
        }
        text = await res.text();
      } catch (e) {
        clear();
        if (callerSignal?.aborted) throw e;
        const wait = waitFor(null, attempt + 1, last);
        report({ method, path, attempt, attempts, will_retry: wait !== null, failure: null, network_error: errorClass(e) });
        if (wait === null) throw e;
        await sleep(wait);
        continue;
      }
      clear();
      const failure = await readGitHubFailure(replay(res, text));
      const wait = waitFor(failure, attempt + 1, last);
      report({ method, path, attempt, attempts, will_retry: wait !== null, failure, network_error: null });
      if (wait === null) return replay(res, text);
      await sleep(wait);
    }
  };
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function budgetExhausted(): Error {
  return Object.assign(new Error("GitHub call budget exhausted (network timeout)"), { name: "TimeoutError" });
}

export type GitHubOp = "create" | "read" | "seed" | "delete" | "other";

export function gitHubOpOf(method: string, path: string): GitHubOp {
  if (path.includes("/git/")) return "seed";
  if (method === "POST" && /^\/orgs\/[^/]+\/repos\/?$/.test(path)) return "create";
  if (method === "DELETE" && /^\/repos\/[^/]+\/[^/]+\/?$/.test(path)) return "delete";
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/?$/.test(path)) return "read";
  return "other";
}

export function gitHubFailureLogInput(source: string, f: GitHubAttemptFailure): LogEventInput {
  const op = gitHubOpOf(f.method, f.path);
  const failure = f.failure;
  const status = failure ? String(failure.status) : "network";
  const detail = failure ? describeGitHubFailure(failure) : `network error (${f.network_error ?? "unknown"})`;
  const docs = failure?.documentation_url ? `; docs ${failure.documentation_url.replace(/^https?:\/\//i, "")}` : "";
  return {
    level: f.will_retry || f.recovered ? "warn" : "error",
    source,
    code: `github_repo_${op}_failed`,
    message: `GitHub ${f.method} ${f.path} answered ${status} (attempt ${f.attempt + 1}/${f.attempts}${f.will_retry ? ", retrying" : ""}${f.recovered ? ", recovered: it landed anyway" : ""})${detail ? `: ${detail}` : ""}${docs}`,
    meta: {
      stage: op,
      method: f.method,
      path: f.path,
      retry_count: f.attempt,
      ...(failure ? { http_status: failure.status } : { error_class: f.network_error ?? "network" }),
      ...(failure?.request_id ? { github_request_id: failure.request_id } : {}),
      ...(failure?.ratelimit_remaining != null ? { ratelimit_remaining: failure.ratelimit_remaining } : {}),
      ...(failure?.ratelimit_reset != null ? { ratelimit_reset: failure.ratelimit_reset } : {}),
      ...(failure?.ratelimit_resource ? { ratelimit_resource: failure.ratelimit_resource } : {}),
      ...(failure?.retry_after_s != null ? { retry_after_s: failure.retry_after_s } : {}),
    },
  };
}

export function logGitHubFailure(source: string, f: GitHubAttemptFailure): void {
  const input = gitHubFailureLogInput(source, f);
  void import("@/services/logging/logEvent")
    .then((m) => m.logEvent(input))
    .catch(() => undefined);
}
