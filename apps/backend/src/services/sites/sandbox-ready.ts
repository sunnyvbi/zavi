
import type { SiteSandboxReadyContext, SiteStore } from "./contract";
import { SITE_REPO_DIR, SitePublishPlatformError, VITE_DEV_PORT, siteVaultKey } from "./contract";
import { siteStore } from "./store";
import { siteDevStartCmd, writeSitePreviewConfigCmd } from "./preview-picker";
import { CLEAR_FIRST_DRAFT_CMD, isFirstSiteBuildPayload } from "./first-draft";
import type { FirstViewMark } from "./first-view";
import {
  buildSiteDepsInstallScript,
  DEPS_LEFT_NO_MODULES,
  installSiteDeps,
  SITE_DEPS_INSTALL_TIMEOUT_S,
  SITE_DEPS_SYNC_TIMEOUT_MS,
} from "@/services/build/deps-install-script";

export { SITE_DEPS_INSTALL_TIMEOUT_S, SITE_DEPS_SYNC_TIMEOUT_MS };

type ExecResult = { stdout: string; stderr: string; exit_code: number; timed_out?: boolean };

export type SandboxReadyDeps = {
  store: SiteStore;
  headOf: (github_full_name: string) => Promise<string | null>;
  resetRepo: (sandbox_id: string, remoteUrl: string, sha: string, opts?: { before?: string }) => Promise<void>;
  readAnonKey: (tenant_id: string, site_id: string) => Promise<string | null>;
  exec: (
    sandbox_id: string,
    cmd: string,
    timeoutMs: number,
    opts?: { env?: Record<string, string> },
  ) => Promise<ExecResult>;
  startPreview: (
    sandbox_id: string,
    port: number,
    opts: { repo_dir: string; start_cmd: string; sanitize_secret_env: boolean },
  ) => Promise<{ url: string; port: number }>;
  recordPreview: (input: {
    tenant_id: string;
    repo_full_name: string;
    url: string | null;
    port: number;
    status: "starting" | "live" | "dead";
  }) => Promise<boolean>;
  probeReady?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (p: Promise<unknown>) => void;
  markFirstView?: (input: { tenant_id: string; site_id: string; mark: FirstViewMark }) => Promise<unknown>;
  installDeps?: (input: { tenant_id: string; site_id: string; sandbox_id: string }) => Promise<{ ok: boolean; reason: string; stale?: boolean }>;
  homeChanged?: (sandbox_id: string) => Promise<boolean>;
};

export const PREVIEW_READY_DELAYS_MS: readonly number[] = [
  1_000, 1_000, 2_000, 2_000, 3_000, 3_000, 5_000, 5_000, 5_000, 5_000,
  10_000, 10_000, 10_000, 10_000, 15_000, 15_000, 15_000, 15_000, 30_000, 30_000, 30_000, 30_000,
];

export const PREVIEW_READY_STREAK = 2;
export const PREVIEW_READY_CONFIRM_GAP_MS = 1_000;

export const SITE_DEV_START_CMD = siteDevStartCmd(VITE_DEV_PORT);

export const WRITE_ENV_LOCAL_CMD = [
  `cd ${SITE_REPO_DIR}`,
  `printf 'VITE_SUPABASE_URL=%s\\nVITE_SUPABASE_ANON_KEY=%s\\n' "$VITE_SUPABASE_URL" "$VITE_SUPABASE_ANON_KEY" > .env.local`,
  `mkdir -p .git/info`,
  `{ grep -qx '.env.local' .git/info/exclude 2>/dev/null || echo '.env.local' >> .git/info/exclude; }`,
].join(" && ");

export const STAMP_BAKED_DEPS_CMD = [
  `cd ${SITE_REPO_DIR}`,
  `[ -d node_modules ]`,
  `[ ! -e node_modules/.zavi-lock ]`,
  `[ -f package-lock.json ]`,
  `! git remote get-url origin >/dev/null 2>&1`,
  `[ -z "$(git status --porcelain 2>/dev/null)" ]`,
  `git ls-files --error-unmatch -- package-lock.json >/dev/null 2>&1`,
  `{ (sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40 > node_modules/.zavi-lock; }`,
].join(" && ");

export const REMOVE_ENV_LOCAL_CMD = `cd ${SITE_REPO_DIR} && rm -f .env.local .env.production.local`;

export function buildStopDevServerCmd(port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid port ${port}`);
  const script = Buffer.from(PORT_HOLDER_SCRIPT, "utf8").toString("base64");
  const holder = (prefix: string, mode: "kill" | "report") =>
    `printf %s '${script}' | base64 -d | ${prefix}"$(command -v node)" - ${port} ${mode}`;
  const kill = (prefix: string) =>
    [
      `{ command -v node >/dev/null 2>&1 && ${holder(prefix, "kill")} >/dev/null 2>&1; } || true;`,
      `{ command -v fuser >/dev/null 2>&1 && ${prefix}fuser -k ${port}/tcp >/dev/null 2>&1; } || true;`,
      `${prefix}pkill -f '[v]ite' >/dev/null 2>&1 || true;`,
    ].join(" ");
  return [
    `__busy() { if command -v node >/dev/null 2>&1; then`,
    `! node -e "const s=require('net').connect(${port},'127.0.0.1');s.setTimeout(1000,()=>process.exit(1));s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0))";`,
    `else (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; fi; };`,
    `__wait_free() { for __i in 1 2 3 4 5 6 7 8; do __busy || return 0; sleep 0.25; done; return 1; };`,
    `if ! __busy; then echo __stop=nothing_running; exit 0; fi;`,
    kill(""),
    `if __wait_free; then echo __stop=stopped; exit 0; fi;`,
    `{ command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1 && { ${kill("sudo -n ")} }; } || true;`,
    `if __wait_free; then echo __stop=stopped_as_root; exit 0; fi;`,
    `__d=$( { command -v node >/dev/null 2>&1 && ${holder("", "report")} 2>/dev/null; } || true );`,
    `[ -n "$__d" ] || __d=$( { ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || true; } | grep ':${port} ' | head -3 | tr -s ' \\n' ' ' || true );`,
    `echo "__stop_diag=$__d";`,
    `exit 1`,
  ].join(" ");
}

export const PORT_HOLDER_SCRIPT = [
  `const fs=require('fs');`,
  `const port=Number(process.argv[2]);const mode=process.argv[3]||'kill';const root=process.argv[4]||'/proc';`,
  `const hex=port.toString(16).toUpperCase().padStart(4,'0');`,
  `const socks=new Map();`,
  `for(const f of ['/net/tcp','/net/tcp6']){let t='';try{t=fs.readFileSync(root+f,'utf8')}catch(e){continue}`,
  `for(const l of t.split('\\n').slice(1)){const c=l.trim().split(/\\s+/);if(c.length<10||c[3]!=='0A')continue;`,
  `if(String(c[1].split(':').pop()).toUpperCase()!==hex)continue;socks.set(c[9],c[7]);}}`,
  `const pids=[];let names=[];try{names=fs.readdirSync(root)}catch(e){}`,
  `for(const p of names){if(!/^\\d+$/.test(p)||Number(p)===process.pid)continue;let fds;try{fds=fs.readdirSync(root+'/'+p+'/fd')}catch(e){continue}`,
  `for(const fd of fds){let l;try{l=fs.readlinkSync(root+'/'+p+'/fd/'+fd)}catch(e){continue}`,
  `const m=/^socket:\\[(\\d+)\\]$/.exec(l);if(m&&socks.has(m[1])){pids.push(Number(p));break}}}`,
  `if(mode==='report'){const who=pids.map((p)=>{let n='?';try{n=fs.readFileSync(root+'/'+p+'/comm','utf8').trim().slice(0,32)}catch(e){}return n+'('+p+')'});`,
  `console.log('listeners='+socks.size+' uid='+[...new Set(socks.values())].join(',')+' holders='+(who.join(',')||'not visible to this user'))}`,
  `else{for(const p of pids){try{process.kill(p,'SIGKILL')}catch(e){}}console.log('killed='+pids.join(','))}`,
].join("");

export const STOP_DEV_SERVER_TIMEOUT_MS = 30_000;

export const STOP_TEMPLATE_DEV_SERVER_CMD = buildStopDevServerCmd(VITE_DEV_PORT);

function stopDiagnostic(stdout: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith("__stop_diag="));
  const diag = (line ?? "").slice("__stop_diag=".length).trim();
  return diag ? `; still listening: ${diag.slice(0, 200)}` : "";
}

async function realDeps(): Promise<SandboxReadyDeps> {
  const [{ readProvisionedRepoHeadSha }, { resetSiteRepo }, { getSecret }, { execCommand }, { startPreviewServer }, driver] =
    await Promise.all([
      import("@/services/provisioning/github-repo"),
      import("@/services/sandbox/lifecycle"),
      import("@/services/secrets/vault"),
      import("@/services/sandbox/e2b-client"),
      import("@/services/sandbox/preview"),
      import("@/services/agents/conductor-driver"),
    ]);
  return {
    store: siteStore(),
    headOf: (full) => readProvisionedRepoHeadSha(full, "main"),
    resetRepo: (id, remoteUrl, sha, opts) => resetSiteRepo(id, remoteUrl, sha, process.env.GITHUB_PROVISION_TOKEN?.trim() || null, opts),
    readAnonKey: (tenant_id, site_id) => getSecret(tenant_id, siteVaultKey.anon(site_id)),
    exec: (id, cmd, t, opts) => execCommand(id, cmd, t, opts ?? {}),
    startPreview: (id, port, opts) => startPreviewServer(id, port, opts),
    recordPreview: driver.recordSiteSandboxPreview,
    markFirstView: async (input) => (await import("./first-view")).markFirstView(input),
    installDeps: async (input) => {
      const started = Date.now();
      const r = await installSiteDeps(input.sandbox_id, (id, cmd, t) => execCommand(id, cmd, t));
      if (r.stale) {
        const template = r.lock_sha1 ? (await starterLockSha1s()).has(r.lock_sha1) : false;
        await reportDepsReinstalled({ ...input, template, ok: r.ok, reason: r.reason, ms: Date.now() - started });
      }
      return r;
    },
    homeChanged: async (sandbox_id) => {
      const [{ fileChangedInSandbox }, { DRAFT_HOME_PATH }] = await Promise.all([import("./first-view"), import("./first-draft")]);
      return fileChangedInSandbox(sandbox_id, SITE_REPO_DIR, DRAFT_HOME_PATH);
    },
  };
}

let starterLocks: Promise<Set<string>> | null = null;
function starterLockSha1s(): Promise<Set<string>> {
  starterLocks ??= (async () => {
    const [{ createHash }, { zaviStarterProvider }, { viteStarterProvider }] = await Promise.all([
      import("node:crypto"),
      import("@/services/provisioning/templates/vite-react-zavi"),
      import("@/services/provisioning/templates/vite-react-supabase"),
    ]);
    const out = new Set<string>();
    for (const provider of [zaviStarterProvider, viteStarterProvider]) {
      try {
        const lock = provider.starterFiles().files["package-lock.json"];
        if (typeof lock === "string") out.add(createHash("sha1").update(lock, "utf8").digest("hex"));
      } catch {
      }
    }
    return out;
  })();
  return starterLocks;
}

async function reportDepsReinstalled(input: { tenant_id: string; site_id: string; template: boolean; ok: boolean; reason: string; ms: number }): Promise<void> {
  const outcome = input.ok ? "ok" : input.reason;
  if (input.template) {
    console.warn(
      `[site-sandbox-ready] sandbox template is stale for site=${input.site_id}: reinstalled the starter's dependencies (${outcome}, ${input.ms}ms); rebake the site template`,
    );
  }
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: input.template ? "warn" : "info",
      source: "sites.build",
      code: input.template ? "site_template_stale" : "site_deps_reinstalled",
      tenant_id: input.tenant_id,
      message: input.template
        ? `site template node_modules are not the starter's lockfile; reinstalled in ${input.ms}ms (${outcome})`
        : `site dependencies changed; reinstalled in ${input.ms}ms (${outcome})`,
      meta: { ms: input.ms, build_stage: "preview_deps" },
    });
  } catch {
  }
}

export const PREVIEW_CONFIG_WRITE_TIMEOUT_MS = 20_000;

export type SitePreviewBoot = "preview_starting" | "preview_failed";

export async function onSiteSandboxReady(
  ctx: SiteSandboxReadyContext,
  injected?: SandboxReadyDeps,
  options: { repoAlreadyReset?: boolean; payload?: unknown; awaitReadiness?: boolean } = {},
): Promise<SitePreviewBoot> {
  const deps = injected ?? (await realDeps());
  const head = options.repoAlreadyReset ? null : deps.headOf(ctx.repo_full_name.trim()).catch(() => null);
  const site = await deps.store.get(ctx.tenant_id, ctx.site_id);
  if (!site || site.tenant_id !== ctx.tenant_id) {
    throw new Error("onSiteSandboxReady: the run's site does not belong to this tenant");
  }
  const repo = (site.github_full_name ?? "").trim();
  if (!repo || repo.toLowerCase() !== ctx.repo_full_name.trim().toLowerCase()) {
    throw new Error("onSiteSandboxReady: the sandbox repo is not this site's repo");
  }

  const dedicated = (site.backend_mode ?? "dedicated") === "dedicated" && !site.kernel_shard_id;
  const supabaseUrl = dedicated ? site.supabase_url : null;
  const anon = supabaseUrl ? readDedicatedAnon(ctx, site.id, deps) : null;

  if (head) {
    const sha = (await head) ?? site.desired_sha;
    if (!sha) throw new Error("onSiteSandboxReady: no commit to check out for this site");
    await deps.resetRepo(ctx.e2b_sandbox_id, `https://github.com/${repo}.git`, sha, { before: STAMP_BAKED_DEPS_CMD });
  }

  const key = anon ? await anon : null;
  const envMode: SiteTreeEnvMode = !supabaseUrl ? "remove" : key?.anon ? "write" : "remove_after_unwritable";
  const why = !dedicated
    ? `a ${site.backend_mode} site's sandbox`
    : !supabaseUrl
      ? "a dedicated site's sandbox with no project yet"
      : "a dedicated site's sandbox after a failed write";
  const prepare = () =>
    deps
      .exec(
        ctx.e2b_sandbox_id,
        buildPrepareSiteTreeCmd(envMode),
        PREPARE_SITE_TREE_TIMEOUT_MS,
        envMode === "write" && supabaseUrl && key?.anon
          ? { env: { VITE_SUPABASE_URL: supabaseUrl, VITE_SUPABASE_ANON_KEY: key.anon } }
          : undefined,
      )
      .catch(() => null);
  const first = await prepare();
  const r = first && (first.timed_out || (first.stdout ?? "").includes("__step=")) ? first : await prepare();
  const out = r?.stdout ?? "";
  const marks = new Set(out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("__step=")));
  if (!marks.has("__step=stopped")) {
    const reason = !r
      ? "exec failed"
      : r.timed_out
        ? `timed out after ${PREPARE_SITE_TREE_TIMEOUT_MS}ms`
        : `exit ${r.exit_code}${stopDiagnostic(out)}`;
    throw new SitePublishPlatformError(`onSiteSandboxReady: the running preview could not be stopped (${reason})`);
  }
  const removed = marks.has("__step=env_removed");
  if (envMode !== "write" || !marks.has("__step=env_written")) {
    if (!removed) {
      throw new SitePublishPlatformError(`onSiteSandboxReady: could not remove a stale .env.local from ${why} (${r ? `exit ${r.exit_code}` : "exec failed"})`);
    }
    if (envMode !== "remove") {
      const failure = key?.failure ?? "the .env.local write failed";
      console.warn(`[site-sandbox-ready] preview not started for tenant=${ctx.tenant_id} site=${site.id}: ${failure}`);
      await deps
        .recordPreview({ tenant_id: ctx.tenant_id, repo_full_name: repo, url: null, port: VITE_DEV_PORT, status: "dead" })
        .catch(() => false);
      return "preview_failed";
    }
  }

  try {
    const starting = deps
      .recordPreview({ tenant_id: ctx.tenant_id, repo_full_name: repo, url: null, port: VITE_DEV_PORT, status: "starting" })
      .catch(() => false);
    const install = async () => {
      if (!deps.installDeps) return;
      const r = await deps.installDeps({ tenant_id: ctx.tenant_id, site_id: site.id, sandbox_id: ctx.e2b_sandbox_id }).catch(() => null);
      if (r && !r.ok) console.warn(`[site-sandbox-ready] dependencies not installed for site=${site.id}: ${r.reason}`);
      if (r && !r.ok && DEPS_LEFT_NO_MODULES.has(r.reason)) throw new Error("the site's dependencies could not be installed");
      const w = await deps.exec(ctx.e2b_sandbox_id, writeSitePreviewConfigCmd(), PREVIEW_CONFIG_WRITE_TIMEOUT_MS).catch(() => null);
      if (!w || w.exit_code !== 0 || w.timed_out) throw new Error("the preview config could not be written after the install");
    };
    const boot = () =>
      deps.startPreview(ctx.e2b_sandbox_id, VITE_DEV_PORT, {
        repo_dir: SITE_REPO_DIR,
        start_cmd: SITE_DEV_START_CMD,
        sanitize_secret_env: true,
      });
    const booted = (async () => {
      await install();
      return boot();
    })();
    booted.catch(() => undefined);
    await starting;
    const { url, port } = await booted;
    await deps.recordPreview({ tenant_id: ctx.tenant_id, repo_full_name: repo, url, port, status: "starting" });
    const firstBuild = isFirstSiteBuildPayload(options.payload);
    const schedule = options.awaitReadiness
      ? (p: Promise<unknown>) => p.catch(() => undefined)
      : deps.schedule ?? ((p: Promise<unknown>) => void p.catch(() => undefined));
    await schedule(
      publishWhenReady(
        { tenant_id: ctx.tenant_id, repo_full_name: repo, url, port, site_id: site.id },
        {
          ...deps,
          contentReady: firstBuild && deps.homeChanged ? () => deps.homeChanged!(ctx.e2b_sandbox_id) : undefined,
        },
      ),
    );
    return "preview_starting";
  } catch (e) {
    console.warn(`[site-sandbox-ready] preview failed for tenant=${ctx.tenant_id} site=${site.id}: ${(e as Error).message ?? e}`);
    await deps
      .recordPreview({ tenant_id: ctx.tenant_id, repo_full_name: repo, url: null, port: VITE_DEV_PORT, status: "dead" })
      .catch(() => false);
    return "preview_failed";
  }
}

export type SiteTreeEnvMode = "remove" | "write" | "remove_after_unwritable";

export function buildSyncSiteDepsCmd(repo_dir: string = SITE_REPO_DIR): string {
  return buildSiteDepsInstallScript(repo_dir);
}

export const SYNC_SITE_DEPS_CMD = buildSyncSiteDepsCmd();

export function buildSiteDepsStaleCmd(repo_dir: string = SITE_REPO_DIR): string {
  const dir = `'${repo_dir.replace(/'/g, "'\\''")}'`;
  return [
    `cd ${dir} 2>/dev/null || { echo __deps=norepo; exit 0; }`,
    `if [ ! -f package-lock.json ]; then echo __deps=nolock;`,
    `elif [ ! -d node_modules ] || [ "$(cat node_modules/.zavi-lock 2>/dev/null)" != "$( (sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40)" ]; then echo __deps=stale;`,
    `else echo __deps=ok; fi`,
  ].join("\n");
}

export const SITE_DEPS_STALE_CMD = buildSiteDepsStaleCmd();

export const PREPARE_SITE_TREE_TIMEOUT_MS = STOP_DEV_SERVER_TIMEOUT_MS + 40_000;

export function buildPrepareSiteTreeCmd(
  env: SiteTreeEnvMode,
  parts: { stop: string; remove: string; write: string; config: string } = {
    stop: STOP_TEMPLATE_DEV_SERVER_CMD,
    remove: REMOVE_ENV_LOCAL_CMD,
    write: WRITE_ENV_LOCAL_CMD,
    config: writeSitePreviewConfigCmd(),
  },
  draft: string = CLEAR_FIRST_DRAFT_CMD,
): string {
  const sub = (cmd: string) => `( ${cmd}\n)`;
  const remove = `if ${sub(parts.remove)}; then echo __step=env_removed; else echo __step=env_remove_failed; exit 1; fi;`;
  const config = `if ${sub(parts.config)} >/dev/null 2>&1; then echo __step=config_written; else echo __step=config_failed; fi;`;
  const envPart =
    env === "write"
      ? `if ${sub(parts.write)}; then echo __step=env_written; ${config} else echo __step=env_write_failed; ${remove} fi;`
      : env === "remove"
        ? `${remove} ${config}`
        : remove;
  return [
    `__rc=0; ${sub(parts.stop)} || __rc=$?;`,
    `if [ "$__rc" -ne 0 ]; then echo "__step=stop_failed"; exit 1; fi;`,
    `echo __step=stopped;`,
    envPart,
    `${sub(draft)} 2>/dev/null || true;`,
  ].join(" ");
}

type DedicatedAnon = { anon: string | null; failure: string | null };

async function readDedicatedAnon(ctx: SiteSandboxReadyContext, site_id: string, deps: SandboxReadyDeps): Promise<DedicatedAnon> {
  try {
    const anon = await deps.readAnonKey(ctx.tenant_id, site_id);
    return anon ? { anon, failure: null } : { anon: null, failure: "the project has no anon key" };
  } catch {
    return { anon: null, failure: "the project's anon key could not be read" };
  }
}

export async function publishWhenReady(
  p: { tenant_id: string; repo_full_name: string; url: string; port: number; site_id: string },
  deps: Pick<SandboxReadyDeps, "recordPreview" | "probeReady" | "sleep" | "markFirstView"> & {
    contentReady?: () => Promise<boolean>;
  },
): Promise<"live" | "timeout"> {
  const probe = deps.probeReady ?? (await defaultProbe());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let streak = 0;
  for (let i = 0; ; ) {
    const ok = await probe(p.url).catch(() => false);
    streak = ok ? streak + 1 : 0;
    if (ok && streak < PREVIEW_READY_STREAK) {
      await sleep(PREVIEW_READY_CONFIRM_GAP_MS);
      continue;
    }
    const published =
      ok &&
      (await deps
        .recordPreview({ tenant_id: p.tenant_id, repo_full_name: p.repo_full_name, url: p.url, port: p.port, status: "live" })
        .catch(() => false));
    if (ok && !published) streak = 0;
    if (published) {
      const mark = (m: FirstViewMark) => deps.markFirstView?.({ tenant_id: p.tenant_id, site_id: p.site_id, mark: m }).catch(() => undefined);
      await mark("preview");
      if (deps.contentReady && (await deps.contentReady().catch(() => false))) await mark("content");
      return "live";
    }
    if (i >= PREVIEW_READY_DELAYS_MS.length) break;
    await sleep(PREVIEW_READY_DELAYS_MS[i]);
    i++;
  }
  console.warn(`[site-sandbox-ready] preview never served its app for site=${p.site_id}; left 'starting'`);
  return "timeout";
}

async function defaultProbe(): Promise<(url: string) => Promise<boolean>> {
  const { probeSandboxDevServer } = await import("@/services/sandbox/preview-ready-probe");
  return (url) => probeSandboxDevServer(new URL(url).origin);
}
