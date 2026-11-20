
import { createHmac, randomUUID } from "node:crypto";
import { projectHostRecord, type KvStore } from "@/services/sites/host-record";
import {
  SITE_POINTER_TERMINAL,
  SITE_REPO_DIR,
  SiteBuildFailed,
  SiteCredentialsMissing,
  SitePublishPlatformError,
  SitePublishTransientError,
  siteVaultKey,
  type SitePointerLedger,
  type SitePointerResult,
  type SiteRow,
  type SitePublisher,
  type SiteSandbox,
  type SiteStore,
  type StagedDeploy,
} from "@/services/sites/contract";
import {
  cfCall,
  ensureStaticRouting,
  findDns,
  findRoute,
  STATIC_MAX_FILES,
  STATIC_PLACEHOLDER_IP,
  staticHostingConfig,
  verifyStaticHost,
  type StaticEnv,
  type StaticFetch,
  type StaticRoutingResult,
} from "./static-publish";
import { mapPool, r2ObjectUrl, uploadStaticDirectory } from "./static-upload";
import { withPublishedEditorRuntime } from "@/services/sites/preview-picker";
import { ensureSiteCommit } from "@/services/sites/site-commit";
import { installCacheKey, restoreInstall, saveInstall } from "./install-cache";
import { isNpmNetworkFailure } from "@/services/sites/platform-errors";

export const SITE_PREVIEW_PATH = "/__zavi_preview/";
export const SITE_PREVIEW_TTL_S = 15 * 60;
export const SITE_PREVIEW_SECRET_ENV = "SITE_PREVIEW_HMAC_SECRET";
export const SITE_PREVIEW_EMBED_PARAM = "zavi_embed";
export const SITE_RETAIN_PREVIOUS = 20;
export const SITE_POINTER_MAX_PASSES = 4;
export const SITE_POINTER_ALERT_AT = 3;
const BUILD_TIMEOUT_MS = 600_000;
const STDERR_TAIL_LINES = 40;

const CF = "https://api.cloudflare.com/client/v4";
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const DEPLOY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SITE_DEPLOY_ID_RE = /^d([0-9a-z]{9})-[0-9a-f]{8}$/;

export type SitePublishDeps = {
  store: SiteStore;
  pointer?: SitePointerLedger;
  log?: (line: string) => void;
  env?: StaticEnv;
  fetchFn?: StaticFetch;
  now?: () => number;
  newDeployId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  verifyAttempts?: number;
  verifyDelayMs?: number;
  ensureRouting?: (hostname: string) => Promise<StaticRoutingResult>;
  readAnonKey?: (tenant_id: string, site_id: string) => Promise<string | null>;
  repoFetchToken?: () => Promise<string | null>;
};

export type SitePublisherImpl = SitePublisher & {
  hasDeploy(input: { tenant_id: string; site_id: string; deploy_id: string }): Promise<boolean>;
  versionPreviewUrl(input: { tenant_id: string; site_id: string; deploy_id: string }): Promise<{ url: string; expires_at: string }>;
  prune(input: { tenant_id: string; site_id: string }): Promise<{ deleted: string[] }>;
  reconcile(input: { tenant_id: string; site_id: string; source: SitePointerSource }): Promise<SitePointerResult>;
};

export type SitePointerSource = "activation" | "sweep" | "verify" | "teardown";

export const DEV_MARKER = "__zavi_dev";

export function desiredPointer(site: Pick<SiteRow, "status" | "live_deploy_id" | "live_sha">): { deploy_id: string; sha: string } | null {
  if (SITE_POINTER_TERMINAL.has(site.status)) return null;
  if (!site.live_deploy_id || !site.live_sha) return null;
  return { deploy_id: site.live_deploy_id, sha: site.live_sha };
}

export function newSiteDeployId(nowMs: number = Date.now()): string {
  return `d${nowMs.toString(36).padStart(9, "0")}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function deployIdTime(deployId: string | null | undefined): number | null {
  const m = SITE_DEPLOY_ID_RE.exec(deployId ?? "");
  return m ? parseInt(m[1], 36) : null;
}

function olderThan(candidate: string, live: string | null): boolean {
  const c = deployIdTime(candidate);
  const l = deployIdTime(live);
  return c !== null && l !== null && c < l;
}

export function signPreviewToken(secret: string, hostname: string, deployId: string, nowMs: number, ttlS = SITE_PREVIEW_TTL_S): string {
  const exp = Math.floor(nowMs / 1000) + Math.min(ttlS, SITE_PREVIEW_TTL_S);
  const sig = createHmac("sha256", secret).update(`preview.${hostname}.${deployId}.${exp}`).digest("hex");
  return `${exp}.${sig}`;
}

export function sitePreviewUrl(hostname: string, deployId: string, token: string): string {
  return `https://${hostname}${SITE_PREVIEW_PATH}${deployId}/?t=${encodeURIComponent(token)}`;
}

export function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">): "live" | "superseded" | "pending" {
  if (site.live_deploy_id === staged.deploy_id) return "live";
  if (site.desired_sha !== staged.sha) return "superseded";
  if (olderThan(staged.deploy_id, site.live_deploy_id)) return "superseded";
  return "pending";
}

function siteHostname(site: SiteRow): string {
  const hostname = String(site.hostname ?? "").trim().toLowerCase();
  if (!HOSTNAME_RE.test(hostname)) throw new Error(`site ${site.id}: invalid hostname`);
  return hostname;
}

function lastLines(s: string, n: number): string {
  return s.trimEnd().split("\n").slice(-n).join("\n");
}

export const SITE_BUILD_WITH_CONFIG_CMD =
  'VITE_SUPABASE_URL="$ZAVI_PUB_URL" VITE_SUPABASE_ANON_KEY="$ZAVI_PUB_ANON" npm run build';
export const SITE_BUILD_WITHOUT_CONFIG_CMD = "env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npm run build";
export const SITE_BUILD_NO_PROJECT_CMD = "VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build";

export function siteSupabaseHost(supabaseUrl: string | null | undefined): string | null {
  const raw = String(supabaseUrl ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && HOSTNAME_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

export class StageYielded extends Error {
  constructor() {
    super("the version build gave way to work on the site");
    this.name = "StageYielded";
  }
}

export const STAGE_YIELD_POLL_MS = 5_000;

export function stageKillScript(dir: string): string {
  if (!/^\/tmp\/site-[A-Za-z0-9-]+$/.test(dir)) throw new Error("invalid stage dir");
  return `for p in /proc/[0-9]*; do c=$(readlink "$p/cwd" 2>/dev/null) || continue; case "$c" in ${dir}|${dir}/*) kill -KILL "\${p#/proc/}" 2>/dev/null;; esac; done; true`;
}

async function runOrYield(
  sandbox: SiteSandbox,
  dir: string,
  cmd: string,
  opts: Parameters<SiteSandbox["run"]>[1],
  shouldYield: () => Promise<boolean>,
): ReturnType<SiteSandbox["run"]> {
  if (await shouldYield().catch(() => true)) throw new StageYielded();
  let done = false;
  let yielded = false;
  let timer: NodeJS.Timeout | undefined;
  const watch = () => {
    timer = setTimeout(async () => {
      if (done) return;
      if ((await shouldYield().catch(() => true)) && !done) {
        yielded = true;
        await sandbox.run(stageKillScript(dir), { cwd: "/", timeoutMs: 30_000 }).catch(() => undefined);
        return;
      }
      watch();
    }, STAGE_YIELD_POLL_MS);
    timer.unref?.();
  };
  watch();
  try {
    const r = await sandbox.run(cmd, opts).catch((e: unknown) => {
      if (yielded) throw new StageYielded();
      throw e;
    });
    if (yielded) throw new StageYielded();
    return r;
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

function runFailure(label: string, r: { exitCode: number; stdout: string; stderr: string }): Error {
  const out = r.stderr.trim() ? r.stderr : r.stdout;
  return new Error(`${label} failed (exit ${r.exitCode}):\n${lastLines(out, STDERR_TAIL_LINES)}`);
}

function probed<T extends { stdout: string; timedOut?: boolean; transportError?: boolean }>(what: string, r: T): T {
  if (r.transportError || r.timedOut) throw new Error(`${what}: the build workspace did not answer${r.timedOut ? " (timed out)" : ""}`);
  return r;
}

function buildFailure(
  label: string,
  r: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; transportError?: boolean },
): Error {
  const e = runFailure(label, r);
  if (r.transportError || r.timedOut) return new Error(`${e.message}\n(${r.timedOut ? "timed out" : "the build workspace did not answer"})`);
  if (label === "npm ci" && isNpmNetworkFailure(`${r.stderr}\n${r.stdout}`)) return e;
  return new SiteBuildFailed(e.message);
}

function isNoClaim(e: unknown): boolean {
  return /P0002|no .* claim/i.test(String((e as Error)?.message ?? e));
}

export function createSitePublisher(deps: SitePublishDeps): SitePublisherImpl {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const fetchFn: StaticFetch = deps.fetchFn ?? ((globalThis as unknown as { fetch: StaticFetch }).fetch);
  const newDeployId = deps.newDeployId ?? (() => newSiteDeployId(now()));
  const ensureRouting = deps.ensureRouting ?? ((hostname: string) => ensureStaticRouting(hostname, { env, fetchFn }));
  let _pointer: SitePointerLedger | null = deps.pointer ?? null;
  const pointer = async (): Promise<SitePointerLedger> =>
    (_pointer ??= (await import("@/services/sites/pointer-ledger")).sitePointerLedger());
  const log = deps.log ?? ((line: string) => console.warn(line));
  const emit = (fields: Record<string, unknown>) => log(JSON.stringify({ evt: "site_pointer", ...fields }));
  const readAnonKey =
    deps.readAnonKey ??
    (async (tenant_id: string, site_id: string) =>
      (await import("@/services/secrets/vault")).getSecret(tenant_id, siteVaultKey.anon(site_id)));

  function config() {
    const cfg = staticHostingConfig(env);
    const secret = (env[SITE_PREVIEW_SECRET_ENV] ?? "").trim();
    const missing = [...(cfg.ok ? [] : cfg.missing), ...(secret ? [] : [SITE_PREVIEW_SECRET_ENV])];
    if (!cfg.ok || missing.length) throw new SiteCredentialsMissing(missing);
    return { cfg, secret };
  }

  async function loadSite(tenant_id: string, site_id: string): Promise<SiteRow> {
    const site = await deps.store.get(tenant_id, site_id);
    if (!site) throw new Error(`site not found: ${site_id}`);
    return site;
  }

  function kvUrl(accountId: string, nsId: string, key: string): string {
    return `${CF}/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`;
  }

  function cfKv(cfg: { accountId: string; kvNamespaceId: string; token: string }): KvStore {
    const auth = { Authorization: `Bearer ${cfg.token}` };
    return {
      async get(key) {
        const res = await fetchFn(kvUrl(cfg.accountId, cfg.kvNamespaceId, key), { method: "GET", headers: auth });
        if (res.status === 404) return null;
        if (res.status < 200 || res.status >= 300) throw new Error(`kv read failed (${res.status})`);
        return res.text();
      },
      async put(key, value, opts) {
        const qs = opts?.expirationTtl ? `?expiration_ttl=${Math.floor(opts.expirationTtl)}` : "";
        const res = await fetchFn(`${kvUrl(cfg.accountId, cfg.kvNamespaceId, key)}${qs}`, {
          method: "PUT",
          headers: { ...auth, "Content-Type": "text/plain" },
          body: value,
        });
        if (res.status < 200 || res.status >= 300) throw new Error(`kv write failed (${res.status})`);
      },
      async delete(key) {
        const res = await fetchFn(kvUrl(cfg.accountId, cfg.kvNamespaceId, key), { method: "DELETE", headers: auth });
        if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw new Error(`kv delete failed (${res.status})`);
      },
    };
  }

  async function reconcile({ tenant_id, site_id, source }: { tenant_id: string; site_id: string; source: SitePointerSource }): Promise<SitePointerResult> {
    const cfg = staticHostingConfig(env);
    if (!cfg.ok) throw new SiteCredentialsMissing(cfg.missing);
    const ledger = await pointer();
    const kv = cfKv(cfg);
    const get = (t: string, s: string) => deps.store.get(t, s);
    let site: SiteRow | null = null;
    let lastError = "row kept moving";
    try {
      for (let pass = 0; pass < SITE_POINTER_MAX_PASSES; pass++) {
        const p = await projectHostRecord({ kv, get }, { tenant_id, site_id });
        if (p.outcome === "gone") return { outcome: "gone", site: null };
        site = p.site as SiteRow;
        const hostname = siteHostname(site);
        const inSync = p.outcome === "in_sync";
        const drift = !inSync && source === "sweep";
        if (inSync && (site.kv_host_version ?? null) === p.version) return { outcome: "in_sync", site, drift_count: site.kv_drift_count ?? 0 };
        const count = await ledger.markProjected(tenant_id, site_id, p.version, drift);
        if (count < 0) continue;
        const outcome = inSync ? "in_sync" : p.outcome === "removed" ? "removed" : "repaired";
        const dbDeploy = desiredPointer(site)?.deploy_id ?? null;
        const kvDeploy = typeof p.before?.deploy_id === "string" ? p.before.deploy_id : null;
        if (drift) {
          emit({
            level: count >= SITE_POINTER_ALERT_AT ? "alert" : "warn",
            msg: count >= SITE_POINTER_ALERT_AT ? "ALERT repeated KV pointer drift" : "KV pointer drift repaired",
            tenant_id, site_id, hostname, outcome, db_deploy_id: dbDeploy, kv_deploy_id: kvDeploy, version: p.version, drift_count: count,
          });
        } else if (outcome !== "in_sync") {
          emit({ level: "info", msg: "KV pointer projected", tenant_id, site_id, hostname, outcome, deploy_id: dbDeploy, version: p.version, source });
        }
        return { outcome, site, drift_count: count };
      }
    } catch (e) {
      lastError = String((e as Error)?.message ?? e).slice(0, 300);
    }
    const count = await ledger.noteDrift(tenant_id, site_id).catch(() => -1);
    emit({
      level: count >= SITE_POINTER_ALERT_AT ? "alert" : "error",
      msg: count >= SITE_POINTER_ALERT_AT ? "ALERT repeated KV pointer drift" : "KV pointer reconcile failed",
      tenant_id, site_id, source, db_deploy_id: site?.live_deploy_id ?? null, drift_count: count, error: lastError,
    });
    throw new Error(`site ${site_id}: KV pointer reconcile failed: ${lastError}`);
  }

  async function listKeys(cfg: { accountId: string; bucket: string; token: string }, prefix: string, limit?: number): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams({ prefix, per_page: String(limit ?? 1000), ...(cursor ? { cursor } : {}) });
      const res = await fetchFn(`${CF}/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects?${qs}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      const text = await res.text().catch(() => "");
      if (res.status < 200 || res.status >= 300) throw new Error(`r2 list failed (${res.status})`);
      const body = JSON.parse(text) as { result?: Array<{ key?: string }>; result_info?: { cursor?: string; is_truncated?: boolean } };
      for (const o of body.result ?? []) if (typeof o.key === "string" && o.key.startsWith(prefix)) keys.push(o.key);
      cursor = body.result_info?.cursor;
      if (limit !== undefined && keys.length >= limit) break;
      if (!body.result_info?.is_truncated || !cursor) break;
    }
    return keys;
  }

  async function deleteKeys(cfg: { accountId: string; bucket: string; token: string }, keys: string[]): Promise<string | null> {
    return mapPool(keys, 8, async (key) => {
      const res = await fetchFn(r2ObjectUrl(cfg.accountId, cfg.bucket, key), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfg.token}` },
      });
      if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw new Error(`r2 delete ${key} failed (${res.status})`);
    });
  }

  return {
    reconcile,

    async stage({ tenant_id, site_id, sha, sandbox, reuseInstall, shouldYield }) {
      if (!SHA_RE.test(sha)) throw new Error(`invalid sha: ${sha}`);
      const site = await loadSite(tenant_id, site_id);
      if (site.status === "deleting" || site.status === "deleted") throw new Error(`site ${site_id} is ${site.status}`);
      const hostname = siteHostname(site);
      const { cfg, secret } = config();
      const deploy_id = newDeployId();
      if (!DEPLOY_ID_RE.test(deploy_id)) throw new Error(`invalid deploy id: ${deploy_id}`);
      const dir = `/tmp/site-${deploy_id}`;
      const repo = SITE_REPO_DIR;
      const dedicated = (site.backend_mode ?? "dedicated") === "dedicated" && !site.kernel_shard_id;
      try {
        const copyEnv = dedicated
          ? ` && for f in .env.local .env.production.local; do if [ -f ${repo}/$f ]; then cp ${repo}/$f ${dir}/$f; fi; done`
          : ` && rm -f ${dir}/.env.local ${dir}/.env.production.local`;
        const fetchToken = deps.repoFetchToken ? await deps.repoFetchToken().catch(() => null) : null;
        await ensureSiteCommit(sandbox, site.github_full_name, sha, fetchToken);
        const extract = await sandbox.run(
          `set -o pipefail; rm -rf ${dir} && mkdir -p ${dir} && ` +
            `git -C ${repo} archive ${sha} | tar -x -C ${dir}${copyEnv}`,
          { cwd: repo, timeoutMs: 120_000 },
        );
        if (extract.exitCode !== 0) throw runFailure("archive", extract);

        const supabaseHost = dedicated ? siteSupabaseHost(site.supabase_url) : null;
        let needsConfig = false;
        if (dedicated) {
          const reads = probed("config probe", await sandbox.run("grep -rlF -e VITE_SUPABASE_URL src 2>/dev/null; true", { cwd: dir, timeoutMs: 60_000 }));
          needsConfig = reads.stdout.trim().length > 0;
        }
        let anon: string | null = null;
        if (supabaseHost) {
          try {
            anon = ((await readAnonKey(tenant_id, site_id)) ?? "").trim() || null;
          } catch (e) {
            throw new SitePublishTransientError(`reading the site's Supabase anon key failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          }
        }
        if (needsConfig && (!supabaseHost || !anon)) {
          throw new SitePublishPlatformError(
            !supabaseHost
              ? "the site's code needs its Supabase project, but the site has no project URL"
              : "the site's Supabase anon key is missing from the vault",
          );
        }

        const install_started = now();
        const run = (c: string, o?: Parameters<SiteSandbox["run"]>[1]) => sandbox.run(c, o);
        const heavy = (c: string, o: Parameters<SiteSandbox["run"]>[1]) =>
          shouldYield ? runOrYield(sandbox, dir, c, o, shouldYield) : sandbox.run(c, o);
        if (shouldYield && (await shouldYield().catch(() => true))) throw new StageYielded();
        const cacheRun = (c: string, o?: Parameters<SiteSandbox["run"]>[1]) => (shouldYield ? runOrYield(sandbox, dir, c, o, shouldYield) : run(c, o));
        const cacheKey = reuseInstall === true ? await installCacheKey(cacheRun, dir) : null;
        if (shouldYield && (await shouldYield().catch(() => true))) throw new StageYielded();
        const restored = cacheKey !== null && (await restoreInstall(cacheRun, dir, cacheKey, site_id));
        if (!restored) {
          const install = await heavy("npm ci --prefer-offline --no-audit --no-fund", { cwd: dir, timeoutMs: BUILD_TIMEOUT_MS });
          if (install.exitCode !== 0) throw buildFailure("npm ci", install);
          if (cacheKey !== null) await saveInstall(cacheRun, dir, cacheKey, deploy_id, site_id);
        }
        const build_started = now();
        const build =
          supabaseHost && anon
            ? await heavy(SITE_BUILD_WITH_CONFIG_CMD, {
                cwd: dir,
                timeoutMs: BUILD_TIMEOUT_MS,
                env: { ZAVI_PUB_URL: `https://${supabaseHost}`, ZAVI_PUB_ANON: anon },
                redact: [anon],
              })
            : await heavy(dedicated ? SITE_BUILD_WITHOUT_CONFIG_CMD : SITE_BUILD_NO_PROJECT_CMD, { cwd: dir, timeoutMs: BUILD_TIMEOUT_MS });
        if (build.exitCode !== 0) throw buildFailure("npm run build", build);
        if (reuseInstall === true) {
          console.info(
            `[site-publish] event=version_stage_build site=${site_id} install=${cacheKey === null ? "uncached" : restored ? "cache_hit" : "cache_miss"} install_ms=${build_started - install_started} build_ms=${now() - build_started}`,
          );
        }

        const list = await sandbox.run("test -d dist && cd dist && find . -type f | sed 's|^\\./||'", { cwd: dir, timeoutMs: 60_000 });
        if (list.exitCode !== 0) throw buildFailure("list dist", list);
        const files = list.stdout
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter((l) => l.length > 0 && !l.split("/").includes(".."));
        if (!files.includes("index.html")) throw new SiteBuildFailed("build produced no dist/index.html");
        if (files.length > STATIC_MAX_FILES) throw new SiteBuildFailed(`too many files: ${files.length}`);

        if (needsConfig && supabaseHost && anon) {
          const has = async (envName: string, value: string) =>
            probed(
              "bundle config probe",
              await sandbox.run(`grep -rlF --exclude='*.map' -e "$${envName}" dist 2>/dev/null; true`, {
                cwd: dir,
                timeoutMs: 60_000,
                env: { [envName]: value },
                redact: [anon],
              }),
            ).stdout.trim().length > 0;
          if (!(await has("ZAVI_PUB_HOST", supabaseHost)) || !(await has("ZAVI_PUB_ANON", anon))) {
            throw new SitePublishPlatformError(
              `the production bundle does not contain the site's Supabase project (${supabaseHost}), so its sign-in and data pages would not work`,
            );
          }
        }

        const dev = probed("dev-marker probe", await sandbox.run(`grep -rlF -e ${DEV_MARKER} dist 2>/dev/null; true`, { cwd: dir, timeoutMs: 60_000 }));
        const marked = dev.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        if (marked.length) {
          throw new SiteBuildFailed(
            `the production bundle contains the dev-mode marker ${DEV_MARKER} (${marked.slice(0, 3).join(", ")}): ` +
              "the in-browser dev server must not ship; build the site with its production config",
          );
        }

        await deps.store.claimProvider(tenant_id, site_id, "cloudflare_host", { hostname });
        const routing = await ensureRouting(hostname);
        if (!routing.ok) throw new Error(`routing: ${routing.error}`);
        const created: Record<string, unknown> = {};
        if (routing.previous.created_route_id) created.route_id = routing.previous.created_route_id;
        if (routing.previous.created_dns_id) created.dns_id = routing.previous.created_dns_id;
        await deps.store.setProviderState(tenant_id, site_id, "cloudflare_host", "created", created);

        const prefix = `sites/${hostname}/`;
        await deps.store.claimProvider(tenant_id, site_id, "r2_prefix", { prefix });
        const indexPath = `${dir}/dist/index.html`;
        const failure = await uploadStaticDirectory({
          sandbox: {
            readFile: async (path: string) => {
              const raw = await sandbox.readFile(path);
              if (path !== indexPath) return raw;
              return withPublishedEditorRuntime(typeof raw === "string" ? raw : raw.toString("utf8"));
            },
          },
          root: `${dir}/dist`,
          files,
          keyPrefix: `${prefix}${deploy_id}/`,
          accountId: cfg.accountId,
          bucket: cfg.bucket,
          token: cfg.token,
          fetchFn,
        });
        if (failure !== null) throw new Error(`upload: ${failure}`);
        await deps.store.setProviderState(tenant_id, site_id, "r2_prefix", "created");
      } finally {
        await sandbox.run(`rm -rf ${dir}`, { timeoutMs: 60_000 }).catch(() => undefined);
      }
      const preview_url = sitePreviewUrl(hostname, deploy_id, signPreviewToken(secret, hostname, deploy_id, now()));
      return { deploy_id, preview_url, sha };
    },

    async previewUrl({ tenant_id, site_id, deploy_id, host }) {
      if (!SITE_DEPLOY_ID_RE.test(deploy_id)) throw new Error(`invalid deploy id: ${deploy_id}`);
      const h = String(host ?? "").trim().toLowerCase();
      if (!HOSTNAME_RE.test(h)) throw new Error("invalid preview host");
      const site = await loadSite(tenant_id, site_id);
      if (site.status === "deleting" || site.status === "deleted") throw new Error(`site ${site_id} is ${site.status}`);
      if (h === siteHostname(site)) throw new Error("the preview host must not be the site's own hostname");
      const { secret } = config();
      return sitePreviewUrl(h, deploy_id, signPreviewToken(secret, h, deploy_id, now()));
    },

    async hasDeploy({ tenant_id, site_id, deploy_id }) {
      if (!SITE_DEPLOY_ID_RE.test(deploy_id)) return false;
      const site = await loadSite(tenant_id, site_id);
      const { cfg } = config();
      return (await listKeys(cfg, `sites/${siteHostname(site)}/${deploy_id}/`, 1)).length > 0;
    },

    async versionPreviewUrl({ tenant_id, site_id, deploy_id }) {
      if (!SITE_DEPLOY_ID_RE.test(deploy_id)) throw new Error(`invalid deploy id: ${deploy_id}`);
      const site = await loadSite(tenant_id, site_id);
      if (site.status === "deleting" || site.status === "deleted") throw new Error(`site ${site_id} is ${site.status}`);
      const hostname = siteHostname(site);
      const { secret } = config();
      const at = now();
      const token = signPreviewToken(secret, hostname, deploy_id, at);
      return {
        url: `${sitePreviewUrl(hostname, deploy_id, token)}&${SITE_PREVIEW_EMBED_PARAM}=1`,
        expires_at: new Date((Math.floor(at / 1000) + SITE_PREVIEW_TTL_S) * 1000).toISOString(),
      };
    },

    async activate({ tenant_id, site_id, staged, generation, conductor_run_id }) {
      if (!DEPLOY_ID_RE.test(staged.deploy_id)) throw new Error(`invalid deploy id: ${staged.deploy_id}`);
      if (!SHA_RE.test(staged.sha)) throw new Error(`invalid sha: ${staged.sha}`);
      const site = await loadSite(tenant_id, site_id);
      const hostname = siteHostname(site);
      const cfg = staticHostingConfig(env);
      if (!cfg.ok) throw new SiteCredentialsMissing(cfg.missing);

      const url = `https://${hostname}`;
      const won = olderThan(staged.deploy_id, site.live_deploy_id)
        ? false
        : await deps.store.activateIfDesired(tenant_id, site_id, staged.sha, staged.deploy_id, url, generation, conductor_run_id ?? null);
      const r = await reconcile({ tenant_id, site_id, source: "activation" });
      if (!won || r.site?.live_deploy_id !== staged.deploy_id) return { superseded: true };
      return { url };
    },

    async verify(hostnameRaw) {
      const hostname = String(hostnameRaw ?? "").trim().toLowerCase();
      if (!HOSTNAME_RE.test(hostname)) return false;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const attempts = Math.max(1, deps.verifyAttempts ?? 18);
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(deps.verifyDelayMs ?? 5_000);
        try {
          const res = await fetchFn(`https://${hostname}/`, { method: "GET" });
          const ct = (res.headers.get("content-type") ?? "").toLowerCase();
          if (res.status === 200 && ct.includes("text/html")) return true;
        } catch {
        }
      }
      return false;
    },

    async prune({ tenant_id, site_id }) {
      const site = await loadSite(tenant_id, site_id);
      const hostname = siteHostname(site);
      const live = site.live_deploy_id;
      const liveAt = deployIdTime(live);
      if (!live || liveAt === null) return { deleted: [] };
      const cfg = staticHostingConfig(env);
      if (!cfg.ok) return { deleted: [] };
      const prefix = `sites/${hostname}/`;
      const keys = await listKeys(cfg, prefix);
      const byDeploy = new Map<string, string[]>();
      for (const key of keys) {
        const id = key.slice(prefix.length).split("/")[0];
        byDeploy.set(id, [...(byDeploy.get(id) ?? []), key]);
      }
      const older = [...byDeploy.keys()]
        .filter((id) => id !== live)
        .map((id) => ({ id, at: deployIdTime(id) }))
        .filter((d): d is { id: string; at: number } => d.at !== null && d.at < liveAt)
        .sort((a, b) => b.at - a.at);
      const doomed = older.slice(SITE_RETAIN_PREVIOUS).map((d) => d.id);
      const failure = await deleteKeys(cfg, doomed.flatMap((id) => byDeploy.get(id) ?? []));
      if (failure) throw new Error(`prune: ${failure}`);
      return { deleted: doomed };
    },

    async teardown({ tenant_id, site_id }) {
      const site = await deps.store.get(tenant_id, site_id);
      if (!site) return;
      const hostname = siteHostname(site);
      const cfg = staticHostingConfig(env);
      if (!cfg.ok) throw new SiteCredentialsMissing(cfg.missing);
      const errors: string[] = [];
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          errors.push(String((e as Error)?.message ?? e));
        }
      };
      const auth = { Authorization: `Bearer ${cfg.token}` };
      await attempt(async () => {
        if (!SITE_POINTER_TERMINAL.has(site.status)) throw new Error(`host record kept: site is ${site.status}, not deleting`);
        await reconcile({ tenant_id, site_id, source: "teardown" });
      });
      for (const key of [`paused:${hostname}`, `lastseen:${hostname}`]) {
        await attempt(async () => {
          const res = await fetchFn(kvUrl(cfg.accountId, cfg.kvNamespaceId, key), { method: "DELETE", headers: auth });
          if ((res.status < 200 || res.status >= 300) && res.status !== 404) throw new Error(`kv delete ${key} failed (${res.status})`);
        });
      }
      await attempt(async () => {
        const failure = await deleteKeys(cfg, await listKeys(cfg, `sites/${hostname}/`));
        if (failure) throw new Error(failure);
      });
      await attempt(async () => {
        const route = await findRoute(fetchFn, cfg.token, cfg.zoneId, `${hostname}/*`);
        if (route?.id && route.script === cfg.workerName) {
          await cfCall(fetchFn, cfg.token, "workers route delete", `${CF}/zones/${cfg.zoneId}/workers/routes/${route.id}`, "DELETE");
        }
        for (const r of await findDns(fetchFn, cfg.token, cfg.zoneId, hostname)) {
          if (r.id && r.content === STATIC_PLACEHOLDER_IP) {
            await cfCall(fetchFn, cfg.token, "dns delete", `${CF}/zones/${cfg.zoneId}/dns_records/${r.id}`, "DELETE");
          }
        }
      });
      if (errors.length) throw new Error(`site teardown: ${errors.join("; ")}`);
      for (const kind of ["cloudflare_host", "r2_prefix"] as const) {
        await deps.store.setProviderState(tenant_id, site_id, kind, "deleted").catch((e: unknown) => {
          if (!isNoClaim(e)) throw e;
        });
      }
    },
  };
}

export function verifySiteDeploy(
  hostname: string,
  deployId: string,
  deps: { fetchFn?: StaticFetch; sleep?: (ms: number) => Promise<void>; verifyAttempts?: number } = {},
) {
  return verifyStaticHost(hostname, deployId, deps);
}
