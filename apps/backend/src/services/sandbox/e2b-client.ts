
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiClient, ConnectionConfig, Sandbox } from "e2b";
import { GITHUB_TOKEN_PATTERN } from "@/services/security/github-token-pattern";

const SANDBOX_TIMEOUT_MS = 50 * 60 * 1000;

const PRAXIS_ENV_FILE = "/home/user/.praxis-env";
const PRAXIS_ENV_KEYS = [
  "GITHUB_TOKEN",
  "NODE_OPTIONS",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
] as const;

const SANDBOX_ENV_ALLOWLIST: ReadonlySet<string> = new Set(PRAXIS_ENV_KEYS);

export function assertAllowlistedEnvKeys(vars: Record<string, unknown>): void {
  for (const k of Object.keys(vars)) {
    if (!SANDBOX_ENV_ALLOWLIST.has(k)) {
      throw new Error(
        `setEnv: refusing to write non-allowlisted key '${k}' into the sandbox ` +
          `(allowed: ${[...SANDBOX_ENV_ALLOWLIST].join(", ")}). Connector secrets are brokered server-side, never in-box.`,
      );
    }
  }
}

export type SandboxId = string;

export type ExecResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  ms: number;
  timed_out?: boolean;
  transport_error?: boolean;
};

export class E2BConfigError extends Error {
  constructor(msg: string) {
    super(`e2b: ${msg}`);
    this.name = "E2BConfigError";
  }
}

function getApiKey(): string {
  const k = process.env.E2B_API_KEY ?? process.env.E2B_KEY;
  if (!k) {
    throw new E2BConfigError(
      "E2B_API_KEY (or E2B_KEY) missing. Set it in AWS Secrets Manager praxis-envprod-1 (or .env for local dev).",
    );
  }
  return k;
}

export type CreateSandboxArgs = {
  tenant_id: string;
  repo_full_name: string;
  allow_internet_access?: boolean;
  template?: string;
};

export async function createSandbox(
  args: CreateSandboxArgs,
): Promise<SandboxId> {
  const tpl =
    args.template?.trim() ||
    process.env.E2B_DEFAULT_TEMPLATE?.trim() ||
    "praxis-qa";
  console.log(`[e2b] createSandbox template: ${tpl}`);
  const opts = {
    apiKey: getApiKey(),
    timeoutMs: SANDBOX_TIMEOUT_MS,
    autoPause: true,
    ...(args.allow_internet_access === false ? { allowInternetAccess: false } : {}),
    metadata: {
      tenant_id: args.tenant_id,
      repo: args.repo_full_name,
      product: "praxis",
    },
  };
  const sb = tpl
    ? await Sandbox.betaCreate(tpl, opts)
    : await Sandbox.betaCreate(opts);
  return sb.sandboxId;
}

type SandboxSession = { tenant_id: string; conns: Map<string, Promise<Sandbox>> };
const sandboxSessions = new AsyncLocalStorage<SandboxSession>();

export function withSandboxSession<T>(tenant_id: string, fn: () => Promise<T>): Promise<T> {
  if (!tenant_id) throw new Error("withSandboxSession: tenant_id required");
  const outer = sandboxSessions.getStore();
  if (outer && outer.tenant_id === tenant_id) return fn();
  return sandboxSessions.run({ tenant_id, conns: new Map() }, fn);
}

export function dropSandboxConnection(sandbox_id: SandboxId): void {
  sandboxSessions.getStore()?.conns.delete(sandbox_id);
}

const quarantinedSandboxes = new Set<SandboxId>();

export function isSandboxQuarantined(sandbox_id: SandboxId): boolean {
  return quarantinedSandboxes.has(sandbox_id);
}

export function __resetQuarantinedSandboxesForTests(): void {
  quarantinedSandboxes.clear();
}

export async function quarantineSandboxBox(
  sandbox_id: SandboxId,
  opts: { destroyOnly?: boolean } = {},
): Promise<"paused" | "destroyed"> {
  quarantinedSandboxes.add(sandbox_id);
  dropSandboxConnection(sandbox_id);
  if (opts.destroyOnly) {
    await destroySandbox(sandbox_id);
    return "destroyed";
  }
  try {
    const sb = await Sandbox.connect(sandbox_id, { apiKey: getApiKey() });
    await sb.betaPause();
    return "paused";
  } catch (pauseErr) {
    try {
      await destroySandbox(sandbox_id);
    } catch (destroyErr) {
      throw new Error(
        `quarantineSandboxBox: pause failed (${(pauseErr as Error)?.message ?? pauseErr}) and destroy failed (${(destroyErr as Error)?.message ?? destroyErr})`,
      );
    }
    return "destroyed";
  }
}

const CONNECT_TIMEOUT_S = 300;

let resumeWarned = false;
function warnResumeOnce(msg: string): void {
  if (resumeWarned) return;
  resumeWarned = true;
  console.warn(`[e2b] ${msg} (logged once per process)`);
}

async function resumeKeepingAutoPause(sandbox_id: SandboxId, apiKey: string): Promise<void> {
  try {
    const config = new ConnectionConfig({ apiKey });
    const client = new ApiClient(config);
    const res = await client.api.POST("/sandboxes/{sandboxID}/resume", {
      params: { path: { sandboxID: sandbox_id } },
      body: { autoPause: true, timeout: CONNECT_TIMEOUT_S },
      signal: config.getSignal(),
    });
    const status = res.response?.status ?? 0;
    if (status >= 400 && status !== 409 && status !== 404) {
      warnResumeOnce(`resume of ${sandbox_id} keeping auto-pause answered ${status}; connecting the default way`);
    }
  } catch (e) {
    warnResumeOnce(`resume of ${sandbox_id} keeping auto-pause failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

async function openSandbox(sandbox_id: SandboxId): Promise<Sandbox> {
  const apiKey = getApiKey();
  await resumeKeepingAutoPause(sandbox_id, apiKey);
  return Sandbox.connect(sandbox_id, { apiKey });
}

async function connect(sandbox_id: SandboxId): Promise<Sandbox> {
  if (quarantinedSandboxes.has(sandbox_id)) {
    throw new Error(`sandbox ${sandbox_id} is quarantined: its GitHub-token scrub failed`);
  }
  const session = sandboxSessions.getStore();
  if (!session) return openSandbox(sandbox_id);
  const cached = session.conns.get(sandbox_id);
  if (cached) return cached;
  const conn = openSandbox(sandbox_id);
  session.conns.set(sandbox_id, conn);
  conn.catch(() => {
    if (session.conns.get(sandbox_id) === conn) session.conns.delete(sandbox_id);
  });
  return conn;
}

async function withConnection<T>(sandbox_id: SandboxId, op: (sb: Sandbox) => Promise<T>): Promise<T> {
  const sb = await connect(sandbox_id);
  try {
    return await op(sb);
  } catch (e) {
    dropSandboxConnection(sandbox_id);
    throw e;
  }
}

export async function resumeSandbox(sandbox_id: SandboxId): Promise<void> {
  await withConnection(sandbox_id, (sb) => sb.setTimeout(SANDBOX_TIMEOUT_MS));
}

export async function extendSandboxTimeout(sandbox_id: SandboxId): Promise<void> {
  await withConnection(sandbox_id, (sb) => sb.setTimeout(SANDBOX_TIMEOUT_MS));
}

export async function pauseSandbox(sandbox_id: SandboxId): Promise<void> {
  try {
    const sb = await connect(sandbox_id);
    await sb.betaPause();
  } finally {
    dropSandboxConnection(sandbox_id);
  }
}

export async function getSandboxHost(
  sandbox_id: SandboxId,
  port = 3000,
): Promise<string> {
  const host = await withConnection(sandbox_id, async (sb) => sb.getHost(port));
  return `https://${host}`;
}

export async function destroySandbox(sandbox_id: SandboxId): Promise<void> {
  dropSandboxConnection(sandbox_id);
  try {
    await Sandbox.kill(sandbox_id, { apiKey: getApiKey() });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/not.?found|404/i.test(msg)) return;
    throw e;
  }
}

export type ListedSandbox = {
  sandbox_id: string;
  state: "running" | "paused";
  started_at: Date;
  metadata: Record<string, string>;
};

export async function listSandboxes(maxPages = 20): Promise<ListedSandbox[]> {
  const out: ListedSandbox[] = [];
  try {
    const paginator = Sandbox.list({ apiKey: getApiKey() });
    let page = 0;
    while (paginator.hasNext && page < maxPages) {
      const items = await paginator.nextItems();
      for (const s of items) {
        out.push({
          sandbox_id: s.sandboxId,
          state: s.state,
          started_at: s.startedAt,
          metadata: s.metadata ?? {},
        });
      }
      page += 1;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`listSandboxes: e2b list failed: ${(e as Error).message ?? e}`);
    return [];
  }
  return out;
}

export type ExecOptions = {
  env?: Record<string, string>;
  redact?: string[];
  user?: "root" | "user";
};

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_REDACT_ENV_LEN = 8;
const REDACTED = "[redacted]";

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.split(s).join(REDACTED);
  }
  return out;
}

export async function execCommand(
  sandbox_id: SandboxId,
  command: string,
  timeoutMs = 30_000,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const env = opts.env ?? {};
  for (const k of Object.keys(env)) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`execCommand: invalid env key '${k}'`);
  }
  const secrets = [
    ...Object.values(env).filter((v) => typeof v === "string" && v.length >= MIN_REDACT_ENV_LEN),
    ...(opts.redact ?? []).filter((v) => typeof v === "string" && v.length > 0),
  ];
  const hasEnv = Object.keys(env).length > 0;
  const start = Date.now();
  const sb = await connect(sandbox_id);
  const wrapped =
    opts.user === "root"
      ? `(set -e; ${command}\n)`
      : `(set -e; [ -f ${PRAXIS_ENV_FILE} ] && set -a && . ${PRAXIS_ENV_FILE} && set +a; ${command}\n)`;
  let timedOut = false;
  let transportError = false;
  const res = await sb.commands
    .run(wrapped, { timeoutMs, ...(hasEnv ? { envs: env } : {}), ...(opts.user ? { user: opts.user } : {}) })
    .catch((e: unknown) => {
    const err = e as {
      name?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const msg = err.message ?? "";
    if (err.name === "TimeoutError" || /\btimed?\s*out\b|timeout/i.test(msg)) {
      timedOut = true;
    }
    if (typeof err.exitCode !== "number") {
      transportError = true;
      dropSandboxConnection(sandbox_id);
    }
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      exitCode: typeof err.exitCode === "number" ? err.exitCode : 1,
    };
  });
  const ms = Date.now() - start;
  const exit_code = res.exitCode ?? 0;
  if (!timedOut && exit_code !== 0 && ms >= timeoutMs - 2000) timedOut = true;
  return {
    stdout: secrets.length ? redactSecrets(res.stdout ?? "", secrets) : res.stdout ?? "",
    stderr: secrets.length ? redactSecrets(res.stderr ?? "", secrets) : res.stderr ?? "",
    exit_code,
    ms,
    timed_out: timedOut,
    ...(transportError ? { transport_error: true } : {}),
  };
}

export async function writeFile(
  sandbox_id: SandboxId,
  path: string,
  content: string,
): Promise<void> {
  await withConnection(sandbox_id, (sb) => sb.files.write(path, content));
}

export async function writeFileBytes(
  sandbox_id: SandboxId,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const sb = await connect(sandbox_id);
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  await sb.files.write(path, copy.buffer);
}

export async function readFile(
  sandbox_id: SandboxId,
  path: string,
): Promise<string> {
  return withConnection(sandbox_id, (sb) => sb.files.read(path));
}

export async function readFileBytes(
  sandbox_id: SandboxId,
  path: string,
): Promise<Uint8Array> {
  return withConnection(sandbox_id, (sb) => sb.files.read(path, { format: "bytes" }));
}

export type SecretEnvMap = Partial<Record<(typeof PRAXIS_ENV_KEYS)[number], string>>;

export async function setEnv(
  sandbox_id: SandboxId,
  vars: SecretEnvMap,
): Promise<void> {
  assertAllowlistedEnvKeys(vars);
  const lines = Object.entries(vars)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => (v ? `export ${k}=${JSON.stringify(v)}` : `unset ${k}`))
    .join("\n");
  await writeFile(sandbox_id, PRAXIS_ENV_FILE, `${lines}\n`);
}

export async function wipeEnv(sandbox_id: SandboxId): Promise<void> {
  const lines = PRAXIS_ENV_KEYS.map((k) => `unset ${k}`).join("\n");
  await writeFile(sandbox_id, PRAXIS_ENV_FILE, `${lines}\n`);
}

export async function cloneRepo(
  sandbox_id: SandboxId,
  owner: string,
  repo: string,
  destPath = "/home/user/repo",
): Promise<ExecResult> {
  return execCommand(
    sandbox_id,
    `mkdir -p ${destPath} && git clone "https://x-access-token:$GITHUB_TOKEN@github.com/${owner}/${repo}.git" ${destPath} && cd ${destPath} && git remote set-url origin "https://x-access-token:$GITHUB_TOKEN@github.com/${owner}/${repo}.git"`,
    120_000,
  );
}

export function refreshOriginUrlStep(): string {
  return (
    `{ { __zu="$(git remote get-url origin)" && [ -n "\${GITHUB_TOKEN:-}" ] && ` +
    `case "$__zu" in https://*) __zr="\${__zu#https://}";; ssh://*) __zr="\${__zu#ssh://}";; ` +
    `*@github.com:*) __zr="github.com/\${__zu#*@github.com:}";; *) __zr="";; esac && ` +
    `__za="\${__zr%%/*}" && __zh="\${__za##*@}" && [ "$__zh" = github.com ] && ` +
    `git remote set-url origin "https://x-access-token:$GITHUB_TOKEN@github.com\${__zr#"$__za"}"; } ` +
    `|| { echo "refresh-origin: origin is not a github.com remote, or no token" >&2; false; }; } && `
  );
}

export const ENGINEER_NODE_OPTIONS = "--max-old-space-size=6144";

export function stripOriginTokenStep(): string {
  const leftover = `${GITHUB_TOKEN_PATTERN}|x-access-token:[^@[:space:]]+@`;
  return [
    `set -o pipefail`,
    `unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY`,
    `__zre='${leftover}'`,
    `__zfail() { echo "token-scrub: $2" >&2; exit "$1"; }`,
    `__zhas() { __zs=0; printf '%s\\n' "$1" | sed 's/x-access-token:REVOKED@//g' | grep -Eq -- "$__zre" || __zs=$?; case "$__zs" in 0) __zfail "$2" "token left in $3";; 1) ;; *) __zfail 6 "cannot scan $3";; esac; }`,
    `__zfile() { [ -e "$1" ] || [ -L "$1" ] || return 0; { [ -f "$1" ] && [ -r "$1" ]; } || __zfail 7 "cannot read $1"; __zc="$(cat -- "$1")" || __zfail 7 "cannot read $1"; __zhas "$__zc" "$2" "$1"; }`,
    `__zrewrite() { __zs=0; __zv="$(git config --get-all "$1")" || __zs=$?; case "$__zs" in 0) ;; 1) return 0;; *) __zfail 5 "cannot read $1";; esac; ` +
      `__zn="$(printf '%s\\n' "$__zv" | sed -E 's#^(https?)://[^/]*@#\\1://x-access-token:REVOKED@#')" || __zfail 1 "rewrite failed"; ` +
      `[ "$__zn" = "$__zv" ] && return 0; git config --unset-all "$1" || __zfail 1 "cannot unset $1"; ` +
      `while IFS= read -r __zl; do git config --add "$1" "$__zl" || __zfail 1 "cannot set $1"; done <<< "$__zn"; }`,
    `git credential-cache exit >/dev/null 2>&1 || true`,
    `__zrepo=0`,
    `if [ -d /home/user/repo ]; then`,
    `  cd /home/user/repo || __zfail 5 "cannot enter checkout"`,
    `  if __zgd="$(git rev-parse --git-common-dir 2>/dev/null)"; then __zrepo=1;`,
    `  elif [ -e .git ] || [ -L .git ]; then __zfail 5 "checkout is not readable by git"; fi`,
    `fi`,
    `if [ "$__zrepo" = 1 ]; then`,
    `  __zremotes="$(git remote)" || __zfail 5 "cannot list remotes"`,
    `  while IFS= read -r __zr; do [ -n "$__zr" ] || continue; __zrewrite "remote.$__zr.url"; __zrewrite "remote.$__zr.pushurl"; done <<< "$__zremotes"`,
    `  for __zf in "$__zgd/config" "$__zgd/config.worktree" "$__zgd"/worktrees/*/config.worktree; do __zfile "$__zf" 3; done`,
    `else`,
    `  cd / || __zfail 5 "cannot leave checkout"`,
    `fi`,
    `__zcfg="$(git config --list --show-origin --includes)" || __zfail 6 "cannot read git config"`,
    `__zhas "$__zcfg" 3 "git config"`,
    `for __zf in "$HOME/.gitconfig" "\${XDG_CONFIG_HOME:-$HOME/.config}/git/config" "\${GIT_CONFIG_GLOBAL:-}" /etc/gitconfig "\${GIT_CONFIG_SYSTEM:-}"; do [ -z "$__zf" ] || __zfile "$__zf" 3; done`,
    `__zfile "$HOME/.git-credentials" 4`,
    `__zfile "\${XDG_CONFIG_HOME:-$HOME/.config}/git/credentials" 4`,
    `__zmatch() { printf '%s\\n' "$1" | grep -Eq -- "$2"; }`,
    `__zs=0; git config --includes --get-regexp '^credential\\..*helper$' >/dev/null 2>&1 || __zs=$?`,
    `case "$__zs" in 0|1) ;; *) __zfail 6 "cannot read credential helpers";; esac`,
    `while IFS= read -r -d '' __ze; do`,
    `  case "$__ze" in *$'\\n'*) __zh="\${__ze#*$'\\n'}";; *) __zh="";; esac`,
    `  case "$__zh" in *$'\\n'*|*$'\\r'*) __zfail 8 "multi-line credential helper configured";; esac`,
    `  [ -n "$__zh" ] || continue`,
    `  if __zmatch "$__zh" '^cache([[:space:]]+--timeout(=|[[:space:]]+)[0-9]+)?$'; then continue; fi`,
    `  if __zmatch "$__zh" '^store$'; then continue; fi`,
    `  __zp="$(printf '%s\\n' "$__zh" | sed -nE 's/^store[[:space:]]+--file(=|[[:space:]]+)//p')"`,
    `  [ -n "$__zp" ] || __zfail 8 "untrusted credential helper configured"`,
    `  case "$__zp" in \\"*\\") __zp="\${__zp#\\"}"; __zp="\${__zp%\\"}"; __zok='^[A-Za-z0-9._/~+@%=:, -]+$';; \\'*\\') __zp="\${__zp#\\'}"; __zp="\${__zp%\\'}"; __zok='^[A-Za-z0-9._/~+@%=:, -]+$';; *) __zok='^[A-Za-z0-9._/~+@%=:,-]+$';; esac`,
    `  __zmatch "$__zp" "$__zok" || __zfail 8 "credential store path is not a plain literal"`,
    `  case "$__zp" in "~/"*) __zp="$HOME/\${__zp#\\~/}";; esac`,
    `  __zfile "$__zp" 4`,
    `done < <(git config -z --includes --get-regexp '^credential\\..*helper$' 2>/dev/null)`,
    `exit 0`,
  ].join("\n");
}

export async function revokeSandboxGithubToken(
  sandbox_id: SandboxId,
  keepEnv: SecretEnvMap = {},
): Promise<void> {
  let envErr: unknown = null;
  try {
    await setEnv(sandbox_id, keepEnv);
  } catch (e) {
    envErr = e;
  }
  const scrub = await execCommand(sandbox_id, stripOriginTokenStep(), 30_000);
  if (scrub.exit_code !== 0) {
    throw new Error(`revokeSandboxGithubToken: remote URL scrub failed (exit ${scrub.exit_code})`);
  }
  if (envErr) {
    throw new Error(`revokeSandboxGithubToken: env rewrite failed: ${(envErr as Error)?.message ?? envErr}`);
  }
}

export async function resetToMain(
  sandbox_id: SandboxId,
  default_branch: string,
  destPath = "/home/user/repo",
  opts: { refreshOriginUrl?: boolean } = {},
): Promise<ExecResult> {
  const escaped = default_branch.replace(/'/g, "'\\''");
  const refreshStep = opts.refreshOriginUrl ? refreshOriginUrlStep() : "";
  return execCommand(sandbox_id, resetToMainScript(escaped, destPath, refreshStep), 60_000);
}

export function resetToMainScript(escapedBranch: string, destPath: string, refreshStep = ""): string {
  return `if [ -d ${destPath}/.git ]; then cd ${destPath} && exec 9>/tmp/_praxis_wt.lock && flock -w 60 9 && BRANCH='${escapedBranch}' && if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then echo "unsafe-branch:$BRANCH"; exit 0; fi && ${refreshStep}git fetch origin && git checkout -f "$BRANCH" && git reset --hard "origin/$BRANCH" && git clean -fd; else echo "no-repo-yet"; fi`;
}
