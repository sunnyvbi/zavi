import { randomUUID } from "node:crypto";
import { getBoolSetting } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { realResolveResourcesDeps } from "@/services/provisioning/resolve-resources";
import { refreshOriginUrlStep } from "@/services/sandbox/e2b-client";
import { uploadStaticDirectory } from "./static-upload";

export { contentTypeFor, STATIC_UPLOAD_CONCURRENCY } from "./static-upload";

export type SandboxRunResult = { exitCode: number; stdout: string; stderr: string };

export interface SandboxExec {
  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<SandboxRunResult>;
  readFile(path: string): Promise<Buffer | string>;
}

export type StaticFetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type StaticFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array },
) => Promise<StaticFetchResponse>;

export type StaticEnv = Record<string, string | undefined>;

export type StaticHostingConfig =
  | {
      ok: true;
      accountId: string;
      token: string;
      zoneId: string;
      bucket: string;
      kvNamespaceId: string;
      workerName: string;
    }
  | { ok: false; reason: "not_configured"; missing: string[] };

export type StaticPublishDeps = {
  env?: StaticEnv;
  fetchFn?: StaticFetch;
  flagEnabled?: (tenant_id: string) => Promise<boolean>;
  newDeployId?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  verifyAttempts?: number;
  verifyDelayMs?: number;
};

export type PublishStaticInput = {
  tenant_id: string;
  hostname: string;
  repo_full_name: string;
  sha: string;
  sandbox: SandboxExec;
  verify?: boolean;
  withRepoToken?: <T>(fn: () => Promise<T>) => Promise<T>;
  beforeFlip?: () => Promise<boolean>;
};

export const STATIC_SUPERSEDED = "superseded";

export type PublishStage = "build" | "export" | "upload" | "flip" | "verify";

export type PublishStaticResult =
  | { ok: true; deploy_id: string; file_count: number; ms: number; kv_previous?: string | null }
  | { ok: false; stage: PublishStage; error: string };

export type StaticEligibilityInput = {
  tenant_id: string;
  hasDatabase: boolean;
  files?: string[];
  sandbox?: SandboxExec;
  repoDir?: string;
};

export type DnsSnapshot = {
  id: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl?: number;
};

export type StaticRoutingPrevious = {
  dns: DnsSnapshot[];
  created_dns_id: string | null;
  route: { id: string; script: string | null } | null;
  created_route_id: string | null;
};

export type StaticRoutingResult =
  | { ok: true; previous: StaticRoutingPrevious; changed: boolean }
  | { ok: false; error: string; previous?: StaticRoutingPrevious };

export type StaticState = {
  status: "publishing" | "live" | "failed" | "rolled_back";
  sha: string;
  deploy_id: string | null;
  error?: string;
  at: string;
  hostname?: string;
  routing_previous?: StaticRoutingPrevious;
};

export type StaticStateStore = {
  load(tenant_id: string): Promise<Record<string, unknown> | null>;
  save(tenant_id: string, external_ref: Record<string, unknown>): Promise<void>;
};

export const STATIC_REPO_DIR = "/home/user/repo";
export const STATIC_MAX_FILES = 10_000;
export const STATIC_PLACEHOLDER_IP = "192.0.2.1";

const CF = "https://api.cloudflare.com/client/v4";

const ENV_KEYS = {
  accountId: "CLOUDFLARE_ACCOUNT_ID",
  token: "CLOUDFLARE_STATIC_API_TOKEN",
  zoneId: "CLOUDFLARE_ZONE_ID",
  bucket: "ZAVI_STATIC_R2_BUCKET",
  kvNamespaceId: "ZAVI_STATIC_KV_NAMESPACE_ID",
  workerName: "ZAVI_STATIC_WORKER_NAME",
} as const;

export function staticHostingConfig(env: StaticEnv = process.env): StaticHostingConfig {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const v = (env[key] ?? "").trim();
    if (!v) missing.push(key);
    values[field] = v;
  }
  if (missing.length) return { ok: false, reason: "not_configured", missing };
  return {
    ok: true,
    accountId: values.accountId,
    token: values.token,
    zoneId: values.zoneId,
    bucket: values.bucket,
    kvNamespaceId: values.kvNamespaceId,
    workerName: values.workerName,
  };
}

const SERVER_PATH_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)app\/api(\/|$)/, reason: "api_routes" },
  { re: /(^|\/)pages\/api(\/|$)/, reason: "api_routes" },
  { re: /^(src\/)?middleware\.(m?[jt]sx?)$/, reason: "middleware" },
  { re: /(^|\/)app\/(.*\/)?route\.(m?[jt]sx?)$/, reason: "route_handlers" },
];

function repoFileReason(files: string[]): string | null {
  for (const raw of files) {
    const f = raw.replace(/^\.\//, "");
    if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue;
    for (const rule of SERVER_PATH_RULES) {
      if (rule.re.test(f)) return rule.reason;
    }
  }
  return null;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function hasServerActions(sandbox: SandboxExec, repoDir: string): Promise<boolean> {
  const cmd =
    `grep -rlE --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git ` +
    `--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.mjs' ` +
    `"^[[:space:]]*['\\"]use server['\\"]" . || true`;
  const r = await sandbox.run(cmd, { cwd: repoDir, timeoutMs: 60_000 });
  return r.stdout.trim().length > 0;
}

let warnedNotConfigured = false;

export function resetStaticNotConfiguredWarning(): void {
  warnedNotConfigured = false;
}

export async function isStaticEligible(
  input: StaticEligibilityInput,
  deps: StaticPublishDeps = {},
): Promise<{ eligible: boolean; reason?: string }> {
  const flag = deps.flagEnabled ?? ((t: string) => getBoolSetting("static_hosting_enabled", t));
  if (!(await flag(input.tenant_id))) return { eligible: false, reason: "flag_off" };
  const cfg = staticHostingConfig(deps.env ?? process.env);
  if (!cfg.ok) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn(`[static-hosting] static_hosting_enabled is on but not configured (missing ${cfg.missing.join(", ")}); publishing on Render`);
    }
    return { eligible: false, reason: "not_configured" };
  }
  if (input.hasDatabase) return { eligible: false, reason: "has_database" };
  const repoDir = input.repoDir ?? STATIC_REPO_DIR;
  let files = input.files;
  if (!files && input.sandbox) {
    const ls = await input.sandbox.run("git ls-files", { cwd: repoDir, timeoutMs: 60_000 });
    if (ls.exitCode !== 0) return { eligible: false, reason: "repo_unreadable" };
    files = ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  if (files) {
    const reason = repoFileReason(files);
    if (reason) return { eligible: false, reason };
  }
  if (input.sandbox && (await hasServerActions(input.sandbox, repoDir))) {
    return { eligible: false, reason: "server_actions" };
  }
  return { eligible: true };
}

function tail(s: string, n = 2000): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

function runError(r: SandboxRunResult): string {
  return tail(`${r.stderr}\n${r.stdout}`) || `exit ${r.exitCode}`;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

const WRAPPER_JS = `import base from "__IMPORT__";
const load = async (phase, ctx) => {
  const src = base && base.__esModule && "default" in base ? base.default : base;
  const resolved = typeof src === "function" ? await src(phase, ctx) : await src;
  const cfg = resolved && typeof resolved === "object" ? resolved : {};
  const images = cfg.images && typeof cfg.images === "object" ? cfg.images : {};
  return { ...cfg, output: "export", images: { ...images, unoptimized: true } };
};
export default load;
`;

const WRAPPER_TS = `import base from "__IMPORT__";
const load = async (phase: string, ctx: unknown): Promise<Record<string, unknown>> => {
  const src = base as unknown;
  const resolved = typeof src === "function" ? await (src as (p: string, c: unknown) => unknown)(phase, ctx) : await src;
  const cfg = resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
  const images = cfg.images && typeof cfg.images === "object" ? (cfg.images as Record<string, unknown>) : {};
  return { ...cfg, output: "export", images: { ...images, unoptimized: true } };
};
export default load;
`;

const WRAPPER_NONE = `const load = async () => ({ output: "export", images: { unoptimized: true } });
export default load;
`;

const CONFIG_ORDER = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts", "next.config.mts"];

export function nextConfigOverridePlan(existing: string[]): { script: string; target: string } {
  const present = CONFIG_ORDER.filter((f) => existing.includes(f));
  const original = present[0] ?? null;
  let target = "next.config.mjs";
  let body = WRAPPER_NONE;
  const moves: string[] = [];
  if (original) {
    const ext = original.slice("next.config.".length);
    const renamed = `next.config.original.${ext}`;
    moves.push(`mv ${original} ${renamed}`);
    if (ext === "ts" || ext === "mts") {
      target = `next.config.${ext}`;
      body = WRAPPER_TS.replace("__IMPORT__", "./next.config.original");
    } else {
      body = WRAPPER_JS.replace("__IMPORT__", `./${renamed}`);
    }
  }
  const b64 = Buffer.from(body, "utf8").toString("base64");
  const script = [
    ...moves,
    `rm -f ${CONFIG_ORDER.join(" ")}`,
    `printf '%s' '${b64}' | base64 -d > next.config.static.mjs`,
    `mv next.config.static.mjs ${target}`,
  ].join(" && ");
  return { script, target };
}

function cfHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function cfJson(res: StaticFetchResponse): Promise<{ success?: boolean; result?: unknown; errors?: Array<{ code?: number; message?: string }> }> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as { success?: boolean; result?: unknown };
  } catch {
    return { success: false, errors: [{ message: tail(text, 300) }] };
  }
}

function cfErr(label: string, status: number, env: { errors?: Array<{ code?: number; message?: string }> }): Error {
  const detail = (env.errors ?? []).map((e) => `${e.code ?? "?"}:${e.message ?? ""}`).join("; ") || "unknown";
  return new Error(`${label} failed (${status}): ${detail}`);
}

function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function resolveFetch(deps: StaticPublishDeps): StaticFetch {
  return deps.fetchFn ?? ((globalThis as unknown as { fetch: StaticFetch }).fetch);
}

export async function publishStatic(
  input: PublishStaticInput,
  deps: StaticPublishDeps = {},
): Promise<PublishStaticResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const cfg = staticHostingConfig(deps.env ?? process.env);
  if (!cfg.ok) return { ok: false, stage: "build", error: "not_configured" };
  const hostname = input.hostname.trim().toLowerCase();
  if (!HOSTNAME_RE.test(hostname)) return { ok: false, stage: "build", error: `invalid hostname: ${input.hostname}` };
  if (!SHA_RE.test(input.sha)) return { ok: false, stage: "build", error: `invalid sha: ${input.sha}` };
  const fetchFn = resolveFetch(deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deploy_id = (deps.newDeployId ?? (() => `d${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`))();
  const dir = `/tmp/static-${deploy_id}`;
  const sb = input.sandbox;
  let stage: PublishStage = "build";

  try {
    const extractRun = () => sb.run(
      `set -o pipefail; rm -rf ${dir} && mkdir -p ${dir} && ` +
        `(git -C ${STATIC_REPO_DIR} cat-file -e ${input.sha}^{commit} 2>/dev/null || (${refreshOriginUrlStep()}git -C ${STATIC_REPO_DIR} fetch --quiet origin ${input.sha})) && ` +
        `git -C ${STATIC_REPO_DIR} archive ${input.sha} | tar -x -C ${dir}`,
      { cwd: STATIC_REPO_DIR, timeoutMs: 120_000 },
    );
    const extract = input.withRepoToken ? await input.withRepoToken(extractRun) : await extractRun();
    if (extract.exitCode !== 0) return { ok: false, stage: "build", error: `archive: ${runError(extract)}` };

    const ls = await sb.run("ls -1a", { cwd: dir, timeoutMs: 30_000 });
    if (ls.exitCode !== 0) return { ok: false, stage: "build", error: `ls: ${runError(ls)}` };
    const plan = nextConfigOverridePlan(ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    const override = await sb.run(plan.script, { cwd: dir, timeoutMs: 30_000 });
    if (override.exitCode !== 0) return { ok: false, stage: "build", error: `config: ${runError(override)}` };

    const install = await sb.run("npm ci --prefer-offline --no-audit --no-fund", { cwd: dir, timeoutMs: 600_000 });
    if (install.exitCode !== 0) return { ok: false, stage: "build", error: `npm ci: ${runError(install)}` };

    const build = await sb.run("NEXT_TELEMETRY_DISABLED=1 npx next build", { cwd: dir, timeoutMs: 900_000 });
    if (build.exitCode !== 0) return { ok: false, stage: "build", error: `next build: ${runError(build)}` };

    stage = "export";
    const list = await sb.run("test -d out && cd out && find . -type f | sed 's|^\\./||'", { cwd: dir, timeoutMs: 60_000 });
    if (list.exitCode !== 0) return { ok: false, stage: "export", error: `no out/ directory: ${runError(list)}` };
    const files = list.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0 && !l.split("/").includes(".."));
    if (!files.includes("index.html")) return { ok: false, stage: "export", error: "export produced no index.html" };
    if (files.length > STATIC_MAX_FILES) return { ok: false, stage: "export", error: `too many files: ${files.length}` };

    stage = "upload";
    const uploadFailure = await uploadStaticDirectory({
      sandbox: sb,
      root: `${dir}/out`,
      files,
      keyPrefix: `sites/${hostname}/${deploy_id}/`,
      accountId: cfg.accountId,
      bucket: cfg.bucket,
      token: cfg.token,
      fetchFn,
    });
    if (uploadFailure !== null) return { ok: false, stage: "upload", error: uploadFailure };

    stage = "flip";
    if (input.beforeFlip && !(await input.beforeFlip())) return { ok: false, stage: "flip", error: STATIC_SUPERSEDED };
    const kvUrl = `${CF}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(`host:${hostname}`)}`;
    let previous: string | null = null;
    try {
      const prev = await fetchFn(kvUrl, { method: "GET", headers: cfHeaders(cfg.token) });
      if (ok2xx(prev.status)) previous = await prev.text();
      else if (prev.status !== 404) {
        return { ok: false, stage: "flip", error: `kv read failed (${prev.status})` };
      }
    } catch (e) {
      return { ok: false, stage: "flip", error: `kv read failed: ${(e as Error).message}` };
    }
    const value = JSON.stringify({
      deploy_id,
      sha: input.sha,
      tenant_id: input.tenant_id,
      published_at: new Date(now()).toISOString(),
    });
    try {
      const put = await fetchFn(kvUrl, {
        method: "PUT",
        headers: cfHeaders(cfg.token, { "Content-Type": "text/plain" }),
        body: value,
      });
      if (!ok2xx(put.status)) {
        return { ok: false, stage: "flip", error: `kv write failed (${put.status}): ${tail(await put.text().catch(() => ""), 300)}` };
      }
    } catch (e) {
      return { ok: false, stage: "flip", error: `kv write failed: ${(e as Error).message}` };
    }

    if (input.verify === false) {
      return { ok: true, deploy_id, file_count: files.length, ms: now() - started, kv_previous: previous };
    }
    const verified = await verifyStaticHost(hostname, deploy_id, { ...deps, fetchFn, sleep });
    if (verified.ok) return { ok: true, deploy_id, file_count: files.length, ms: now() - started };
    const restored = await restoreStaticKv(hostname, previous, { ...deps, fetchFn });
    return { ok: false, stage: "verify", error: `${verified.error}; ${restored.ok ? "kv restored" : restored.error}` };
  } catch (e) {
    return { ok: false, stage, error: (e as Error).message };
  } finally {
    await sb.run(`rm -rf ${dir}`, { timeoutMs: 60_000 }).catch(() => undefined);
  }
}

export async function verifyStaticHost(
  hostnameRaw: string,
  expectedDeployId: string,
  deps: StaticPublishDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hostname = hostnameRaw.trim().toLowerCase();
  const fetchFn = resolveFetch(deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, deps.verifyAttempts ?? 18);
  const delay = deps.verifyDelayMs ?? 5_000;
  let error = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delay);
    try {
      const res = await fetchFn(`https://${hostname}/`, { method: "GET" });
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      const servedDeployId = res.headers.get("x-zavi-deploy-id");
      if (res.status === 200 && ct.includes("text/html") && servedDeployId === expectedDeployId) {
        return { ok: true };
      }
      error = `GET https://${hostname}/ returned ${res.status} ${ct || "no content-type"} deploy=${servedDeployId ?? "none"}`;
    } catch (e) {
      error = `GET https://${hostname}/ failed: ${(e as Error).message}`;
    }
  }
  return { ok: false, error };
}

export async function restoreStaticKv(
  hostnameRaw: string,
  previous: string | null,
  deps: StaticPublishDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = staticHostingConfig(deps.env ?? process.env);
  if (!cfg.ok) return { ok: false, error: "not_configured" };
  const hostname = hostnameRaw.trim().toLowerCase();
  const fetchFn = resolveFetch(deps);
  const kvUrl = `${CF}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(`host:${hostname}`)}`;
  try {
    const res =
      previous !== null
        ? await fetchFn(kvUrl, { method: "PUT", headers: cfHeaders(cfg.token, { "Content-Type": "text/plain" }), body: previous })
        : await fetchFn(kvUrl, { method: "DELETE", headers: cfHeaders(cfg.token) });
    return ok2xx(res.status) || res.status === 404 ? { ok: true } : { ok: false, error: `kv restore failed (${res.status})` };
  } catch (e) {
    return { ok: false, error: `kv restore failed: ${(e as Error).message}` };
  }
}

export type CfDnsRecord = { id?: string; name?: string; type?: string; content?: string; proxied?: boolean; ttl?: number };
export type CfRoute = { id?: string; pattern?: string; script?: string | null };

function routingDeps(deps: StaticPublishDeps): { cfg: StaticHostingConfig; fetchFn: StaticFetch } {
  return { cfg: staticHostingConfig(deps.env ?? process.env), fetchFn: resolveFetch(deps) };
}

export async function cfCall(
  fetchFn: StaticFetch,
  token: string,
  label: string,
  url: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method,
    headers: cfHeaders(token, { "Content-Type": "application/json", Accept: "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const env = await cfJson(res);
  if (!ok2xx(res.status) || env.success === false) throw cfErr(label, res.status, env);
  return env.result;
}

export async function findRoute(fetchFn: StaticFetch, token: string, zoneId: string, pattern: string): Promise<CfRoute | null> {
  const list = (await cfCall(fetchFn, token, "workers routes list", `${CF}/zones/${zoneId}/workers/routes`)) as CfRoute[] | undefined;
  return (list ?? []).find((r) => (r.pattern ?? "").toLowerCase() === pattern) ?? null;
}

export async function findDns(fetchFn: StaticFetch, token: string, zoneId: string, hostname: string): Promise<CfDnsRecord[]> {
  const list = (await cfCall(
    fetchFn,
    token,
    "dns list",
    `${CF}/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
  )) as CfDnsRecord[] | undefined;
  return (list ?? []).filter(
    (r) => (r.name ?? "").toLowerCase() === hostname && ["A", "AAAA", "CNAME"].includes((r.type ?? "").toUpperCase()),
  );
}

export function matchingWildcardRoute(routes: CfRoute[], hostname: string, path: string): CfRoute | null {
  const matches = routes.filter((r) => {
    const pattern = (r.pattern ?? "").toLowerCase();
    const slash = pattern.indexOf("/");
    if (slash < 0 || pattern.slice(slash) !== path) return false;
    const host = pattern.slice(0, slash);
    const suffix = host.slice(1);
    return host.startsWith("*") && !!suffix && hostname.endsWith(suffix) && hostname !== suffix;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function wildcardRouteServes(routes: CfRoute[], hostname: string, worker: string): boolean {
  if (routes.some((r) => (r.pattern ?? "").toLowerCase() === `${hostname}/*`)) return false;
  return matchingWildcardRoute(routes, hostname, "/*")?.script === worker;
}

async function wildcardDnsServes(fetchFn: StaticFetch, token: string, zoneId: string, hostname: string): Promise<boolean> {
  const exact = (await cfCall(fetchFn, token, "dns list", `${CF}/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`)) as
    | CfDnsRecord[]
    | undefined;
  if ((exact ?? []).some((r) => (r.name ?? "").toLowerCase() === hostname)) return false;
  const wildcard = await findDns(fetchFn, token, zoneId, `*${hostname.slice(hostname.indexOf("."))}`);
  return wildcard.length > 0 && wildcard.every((r) => r.proxied === true);
}

export async function ensureStaticRouting(
  hostnameRaw: string,
  deps: StaticPublishDeps = {},
): Promise<StaticRoutingResult> {
  const { cfg, fetchFn } = routingDeps(deps);
  if (!cfg.ok) return { ok: false, error: "not_configured" };
  const hostname = hostnameRaw.trim().toLowerCase();
  if (!HOSTNAME_RE.test(hostname)) return { ok: false, error: `invalid hostname: ${hostnameRaw}` };
  const pattern = `${hostname}/*`;
  const previous: StaticRoutingPrevious = { dns: [], created_dns_id: null, route: null, created_route_id: null };
  let changed = false;
  try {
    const routes = ((await cfCall(fetchFn, cfg.token, "workers routes list", `${CF}/zones/${cfg.zoneId}/workers/routes`)) as CfRoute[] | undefined) ?? [];
    const route = routes.find((r) => (r.pattern ?? "").toLowerCase() === pattern) ?? null;
    const routedByWildcard = wildcardRouteServes(routes, hostname, cfg.workerName);
    if (!routedByWildcard && route?.id && route.script !== cfg.workerName) {
      previous.route = { id: route.id, script: route.script ?? null };
      await cfCall(fetchFn, cfg.token, "workers route update", `${CF}/zones/${cfg.zoneId}/workers/routes/${route.id}`, "PUT", {
        pattern,
        script: cfg.workerName,
      });
      changed = true;
    } else if (!routedByWildcard && !route?.id) {
      const created = (await cfCall(fetchFn, cfg.token, "workers route create", `${CF}/zones/${cfg.zoneId}/workers/routes`, "POST", {
        pattern,
        script: cfg.workerName,
      })) as CfRoute | undefined;
      previous.created_route_id = created?.id ?? null;
      changed = true;
    }

    const records = await findDns(fetchFn, cfg.token, cfg.zoneId, hostname);
    if (records.length === 0 && !(await wildcardDnsServes(fetchFn, cfg.token, cfg.zoneId, hostname))) {
      const created = (await cfCall(fetchFn, cfg.token, "dns create", `${CF}/zones/${cfg.zoneId}/dns_records`, "POST", {
        type: "A",
        name: hostname,
        content: STATIC_PLACEHOLDER_IP,
        ttl: 1,
        proxied: true,
      })) as CfDnsRecord | undefined;
      previous.created_dns_id = created?.id ?? null;
      changed = true;
    }
    for (const r of records) {
      if (r.proxied === true || !r.id) continue;
      previous.dns.push({
        id: r.id,
        type: (r.type ?? "").toUpperCase(),
        content: r.content ?? "",
        proxied: false,
        ...(typeof r.ttl === "number" ? { ttl: r.ttl } : {}),
      });
      await cfCall(fetchFn, cfg.token, "dns update", `${CF}/zones/${cfg.zoneId}/dns_records/${r.id}`, "PATCH", { proxied: true });
      changed = true;
    }
    return { ok: true, previous, changed };
  } catch (e) {
    const error = (e as Error).message;
    if (!changed) return { ok: false, error };
    const undo = await restoreRenderRouting(hostname, previous, deps).catch((err: unknown) => ({
      ok: false as const,
      error: String((err as Error)?.message ?? err),
    }));
    return undo.ok ? { ok: false, error } : { ok: false, error: `${error}; restore: ${undo.error}`, previous };
  }
}

export async function restoreRenderRouting(
  hostnameRaw: string,
  previous: StaticRoutingPrevious,
  deps: StaticPublishDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { cfg, fetchFn } = routingDeps(deps);
  if (!cfg.ok) return { ok: false, error: "not_configured" };
  const hostname = hostnameRaw.trim().toLowerCase();
  const errors: string[] = [];
  const attempt = async (fn: () => Promise<unknown>, gone404 = false): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error).message;
      if (gone404 && msg.includes("failed (404)")) return;
      errors.push(msg);
    }
  };
  for (const d of previous.dns) {
    await attempt(() =>
      cfCall(fetchFn, cfg.token, "dns restore", `${CF}/zones/${cfg.zoneId}/dns_records/${d.id}`, "PATCH", {
        type: d.type,
        name: hostname,
        content: d.content,
        proxied: d.proxied,
        ...(d.ttl === undefined ? {} : { ttl: d.ttl }),
      }),
    );
  }
  if (previous.created_dns_id) {
    const id = previous.created_dns_id;
    await attempt(() => cfCall(fetchFn, cfg.token, "dns delete", `${CF}/zones/${cfg.zoneId}/dns_records/${id}`, "DELETE"), true);
  }
  if (previous.created_route_id) {
    const id = previous.created_route_id;
    await attempt(() => cfCall(fetchFn, cfg.token, "workers route delete", `${CF}/zones/${cfg.zoneId}/workers/routes/${id}`, "DELETE"), true);
  } else if (previous.route) {
    const { id, script } = previous.route;
    await attempt(() =>
      cfCall(fetchFn, cfg.token, "workers route restore", `${CF}/zones/${cfg.zoneId}/workers/routes/${id}`, "PUT", {
        pattern: `${hostname}/*`,
        ...(script ? { script } : {}),
      }),
    );
  }
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
}

export const supabaseStaticStateStore: StaticStateStore = {
  load: (tenant_id) => realResolveResourcesDeps.loadExternalRef(tenant_id, "hosting"),
  async save(tenant_id, external_ref) {
    const { error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_resources")
      .update({ external_ref })
      .eq("resource_kind", "hosting");
    if (error) throw new Error(`static state write failed: ${error.message}`);
  },
};

const STATES = new Set(["publishing", "live", "failed", "rolled_back"]);

function parseRoutingPrevious(v: unknown): StaticRoutingPrevious | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.dns)) return null;
  const route = o.route as { id?: unknown; script?: unknown } | null | undefined;
  return {
    dns: (o.dns as unknown[]).filter(
      (d): d is DnsSnapshot =>
        !!d &&
        typeof (d as DnsSnapshot).id === "string" &&
        typeof (d as DnsSnapshot).type === "string" &&
        typeof (d as DnsSnapshot).content === "string" &&
        typeof (d as DnsSnapshot).proxied === "boolean",
    ),
    created_dns_id: typeof o.created_dns_id === "string" ? o.created_dns_id : null,
    route:
      route && typeof route.id === "string"
        ? { id: route.id, script: typeof route.script === "string" ? route.script : null }
        : null,
    created_route_id: typeof o.created_route_id === "string" ? o.created_route_id : null,
  };
}

function parseState(v: unknown): StaticState | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.status !== "string" || !STATES.has(o.status) || typeof o.sha !== "string") return null;
  const routing_previous = parseRoutingPrevious(o.routing_previous);
  return {
    status: o.status as StaticState["status"],
    sha: o.sha,
    deploy_id: typeof o.deploy_id === "string" ? o.deploy_id : null,
    ...(typeof o.error === "string" ? { error: o.error } : {}),
    at: typeof o.at === "string" ? o.at : "",
    ...(typeof o.hostname === "string" ? { hostname: o.hostname } : {}),
    ...(routing_previous ? { routing_previous } : {}),
  };
}

export async function readStaticState(
  tenant_id: string,
  store: StaticStateStore = supabaseStaticStateStore,
): Promise<StaticState | null> {
  const ref = await store.load(tenant_id);
  return parseState(ref?.static);
}

export function staticRoutingActive(state: StaticState | null | undefined, hostname?: string): boolean {
  if (!state || state.status === "rolled_back" || !state.hostname || !state.routing_previous) return false;
  return hostname === undefined || state.hostname === hostname.trim().toLowerCase();
}

export async function writeStaticState(
  tenant_id: string,
  state: StaticState,
  store: StaticStateStore = supabaseStaticStateStore,
): Promise<void> {
  const ref = await store.load(tenant_id);
  if (!ref) throw new Error(`static state write failed: no hosting resource for tenant ${tenant_id}`);
  const prior = parseState(ref.static);
  const hostname = state.hostname ?? prior?.hostname;
  const carry = staticRoutingActive(prior, hostname) && state.routing_previous === undefined;
  const merged: StaticState = {
    ...state,
    ...(hostname ? { hostname } : {}),
    ...(carry && prior?.routing_previous ? { routing_previous: prior.routing_previous } : {}),
  };
  await store.save(tenant_id, { ...ref, static: merged });
}

export async function rollbackStaticHosting(
  tenant_id: string,
  deps: StaticPublishDeps & { store?: StaticStateStore } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = deps.store ?? supabaseStaticStateStore;
  const state = await readStaticState(tenant_id, store);
  if (!state?.hostname || !state.routing_previous) return { ok: false, error: "nothing_to_roll_back" };
  if (state.status === "rolled_back") return { ok: true };
  const restored = await restoreRenderRouting(state.hostname, state.routing_previous, deps);
  if (!restored.ok) return restored;
  const kv = await restoreStaticKv(state.hostname, null, deps);
  if (!kv.ok) return kv;
  const now = deps.now ?? Date.now;
  await writeStaticState(tenant_id, { ...state, status: "rolled_back", at: new Date(now()).toISOString() }, store);
  return { ok: true };
}

export function e2bSandboxExec(sandbox_id: string): SandboxExec {
  return {
    async run(cmd, opts = {}) {
      const { execCommand } = await import("@/services/sandbox/e2b-client");
      const full = opts.cwd ? `cd ${shq(opts.cwd)} && ${cmd}` : cmd;
      const r = await execCommand(sandbox_id, full, opts.timeoutMs ?? 30_000);
      return { exitCode: r.exit_code, stdout: r.stdout, stderr: r.stderr };
    },
    async readFile(path) {
      const { readFileBytes } = await import("@/services/sandbox/e2b-client");
      return Buffer.from(await readFileBytes(sandbox_id, path));
    },
  };
}
