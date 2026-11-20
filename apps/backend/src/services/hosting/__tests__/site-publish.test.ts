import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SITE_POINTER_TERMINAL,
  SiteBuildFailed,
  SiteCredentialsMissing,
  SitePublishPlatformError,
  SitePublishTransientError,
  type SitePointerLedger,
  type SiteRow,
  type SiteSandbox,
  type SiteStore,
} from "@/services/sites/contract";
import {
  activationState,
  createSitePublisher,
  deployIdTime,
  newSiteDeployId,
  SITE_PREVIEW_TTL_S,
  SITE_RETAIN_PREVIOUS,
  SITE_PREVIEW_EMBED_PARAM,
  STAGE_YIELD_POLL_MS,
  StageYielded,
  stageKillScript,
  type SitePublishDeps,
} from "../site-publish";
import { __resetInstallDigests } from "../install-cache";
import { renderHostRecord, syncHostRecord, type GatewayBindingRow, type KvStore } from "@/services/sites/host-record";
import { FakeCloudflare, FULL_ENV } from "./static-fakes";
import type { StaticFetch } from "../static-publish";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOST_A = "shop-1a2b3c4d-aaaaaa.zaviagent.com";
const HOST_B = "blog-1a2b3c4d-bbbbbb.zaviagent.com";
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const PREVIEW_SECRET = "pv-secret";
const ENV = { ...FULL_ENV, SITE_PREVIEW_HMAC_SECRET: PREVIEW_SECRET };
const ANON = "anon-public-key-abcdefghijklmnop";
const SB_URL = "https://abcdefghijklmnop.supabase.co";

function siteRow(id: string, hostname: string, patch: Partial<SiteRow> = {}): SiteRow {
  return {
    id, tenant_id: TENANT, root_conductor_run_id: null, started_by_user_id: null, owner_email: null,
    label: hostname.split(".")[0], hostname, github_full_name: null, supabase_project_ref: null, supabase_url: null,
    status: "building", live_url: null, desired_sha: SHA1, live_sha: null, live_deploy_id: null,
    last_visit_at: null, last_edit_at: null, paused_at: null, last_error: null,
    created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", ...patch,
  };
}

type Log = string[];

const TERMINAL = (r: SiteRow) => SITE_POINTER_TERMINAL.has(r.status);
class SitesTable extends Map<string, SiteRow> {
  override set(id: string, next: SiteRow): this {
    const old = super.get(id);
    let row = next;
    if (!old) {
      if (row.live_deploy_id || row.gateway_binding) row = { ...row, kv_host_version: -1 };
    } else {
      const ov = old.host_version ?? 0;
      const nv = row.host_version ?? 0;
      if (nv < ov) throw new Error("host_version can never go down");
      const projected =
        row.live_deploy_id !== old.live_deploy_id || row.live_sha !== old.live_sha || row.hostname !== old.hostname ||
        row.tenant_id !== old.tenant_id || JSON.stringify(row.gateway_binding ?? null) !== JSON.stringify(old.gateway_binding ?? null) ||
        JSON.stringify(row.gateway_config ?? null) !== JSON.stringify(old.gateway_config ?? null) || TERMINAL(row) !== TERMINAL(old);
      if (nv === ov && projected) row = { ...row, host_version: ov + 1 };
    }
    return super.set(id, row);
  }
}

const confirmed = (r: SiteRow | null) => !!r && (r.kv_host_version ?? 0) === (r.host_version ?? 0);

class FakeStore implements Partial<SiteStore> {
  sites: Map<string, SiteRow> = new SitesTable();
  providers = new Map<string, { state: string; ref: Record<string, unknown> }>();
  afterCas: ((deploy_id: string) => Promise<void>) | null = null;
  beforeCas: ((deploy_id: string) => Promise<void>) | null = null;
  constructor(public log: Log, rows: SiteRow[]) {
    for (const r of rows) this.sites.set(r.id, r);
  }
  async get(tenant_id: string, site_id: string) {
    const r = this.sites.get(site_id);
    return r && r.tenant_id === tenant_id ? { ...r } : null;
  }
  runs = new Map<string, { tenant_id: string; status: string }>();
  async activateIfDesired(tenant_id: string, site_id: string, sha: string, deploy_id: string, live_url: string, generation?: number, conductor_run_id?: string | null) {
    if (this.beforeCas) await this.beforeCas(deploy_id);
    const r = this.sites.get(site_id);
    if (!r || r.tenant_id !== tenant_id || r.desired_sha !== sha || SITE_POINTER_TERMINAL.has(r.status)) return false;
    if (conductor_run_id) {
      const run = this.runs.get(conductor_run_id);
      if (!run || run.tenant_id !== tenant_id || !["provisioning", "active", "paused"].includes(run.status)) return false;
    }
    const SITE_ID = /^d[0-9a-z]{9}-[0-9a-f]{8}$/;
    if (r.live_deploy_id && SITE_ID.test(r.live_deploy_id) && SITE_ID.test(deploy_id) && r.live_deploy_id.slice(1, 10) > deploy_id.slice(1, 10)) return false;
    this.sites.set(site_id, { ...r, live_sha: sha, live_deploy_id: deploy_id, live_url });
    this.log.push(`cas:${deploy_id}`);
    if (this.afterCas) await this.afterCas(deploy_id);
    return true;
  }
  failMark = false;
  ledger: SitePointerLedger = {
    markProjected: async (tenant_id, site_id, version, drift) => {
      if (this.failMark) throw new Error("ledger down");
      const r = this.sites.get(site_id);
      if (!r || r.tenant_id !== tenant_id) return -1;
      if ((r.host_version ?? 0) !== version) return -1;
      const count = drift ? (r.kv_drift_count ?? 0) + 1 : 0;
      this.sites.set(site_id, { ...r, kv_host_version: version, kv_drift_count: count });
      this.log.push(`mark:${r.live_deploy_id}:${drift}`);
      return count;
    },
    noteDrift: async (tenant_id, site_id) => {
      const r = this.sites.get(site_id);
      if (!r || r.tenant_id !== tenant_id) return 0;
      const count = (r.kv_drift_count ?? 0) + 1;
      this.sites.set(site_id, { ...r, kv_drift_count: count });
      return count;
    },
    driftBatch: async () =>
      [...this.sites.values()]
        .filter((r) => !confirmed(r))
        .map((r) => ({ tenant_id: r.tenant_id, site_id: r.id })),
  };
  async claimProvider(_t: string, site_id: string, kind: string, ref: Record<string, unknown>) {
    this.log.push(`claim:${kind}`);
    const k = `${site_id}:${kind}`;
    const cur = this.providers.get(k);
    this.providers.set(k, { state: cur?.state ?? "claimed", ref: { ...(cur?.ref ?? {}), ...ref } });
  }
  async setProviderState(_t: string, site_id: string, kind: string, state: string, ref?: Record<string, unknown>) {
    const k = `${site_id}:${kind}`;
    const cur = this.providers.get(k);
    if (!cur) throw new Error("P0002 no claim");
    this.log.push(`provider:${kind}:${state}`);
    this.providers.set(k, { state, ref: { ...cur.ref, ...(ref ?? {}) } });
  }
}

class SiteFakeCloudflare extends FakeCloudflare {
  constructor(log: Log) {
    super();
    const base = this.fetch;
    this.fetch = (async (url, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const u = new URL(url);
      const list = u.pathname.match(/^\/client\/v4\/accounts\/acct1\/r2\/buckets\/bucket1\/objects$/);
      if (list && method === "GET") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const keys = [...this.r2.keys()].filter((k) => k.startsWith(prefix)).sort();
        return {
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ success: true, result: keys.map((key) => ({ key })), result_info: { is_truncated: false } }),
        };
      }
      const obj = u.pathname.match(/^\/client\/v4\/accounts\/acct1\/r2\/buckets\/bucket1\/objects\/(.+)$/);
      if (obj && method === "DELETE") {
        this.r2.delete(decodeURIComponent(obj[1]));
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ success: true, result: {} }) };
      }
      if (u.hostname === "api.cloudflare.com" && method !== "GET") log.push(`cf:${method}:${u.pathname.split("/").slice(3, 7).join("/")}`);
      return base(url, init);
    }) as StaticFetch;
  }
}

class FakeSiteSandbox implements SiteSandbox {
  runs: Array<{ cmd: string; cwd?: string; env?: Record<string, string>; redact?: string[]; user?: string }> = [];
  files = new Map<string, string>();
  fail: Partial<Record<"archive" | "npm" | "build", { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; transportError?: boolean }>> = {};
  devMarkerFiles = "";
  readsSupabase = false;
  async run(cmd: string, opts: { cwd?: string; env?: Record<string, string>; redact?: string[]; user?: "root" | "user" } = {}) {
    this.runs.push({ cmd, cwd: opts.cwd, env: opts.env, redact: opts.redact, user: opts.user });
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (cmd.includes("git -C /home/user/repo archive")) return this.fail.archive ?? ok();
    if (cmd.startsWith("npm ci")) return this.fail.npm ?? ok();
    if (cmd.includes("npm run build")) return this.fail.build ?? ok();
    if (cmd.startsWith("grep -rlF -e VITE_SUPABASE_URL src")) return ok(this.readsSupabase ? "src/lib/supabase.ts\n" : "");
    const probe = /^grep -rlF --exclude='\*\.map' -e "\$([A-Z_]+)" dist/.exec(cmd);
    if (probe) {
      const needle = opts.env?.[probe[1]];
      if (!needle) throw new Error(`grep probe without its env value ${probe[1]}`);
      expect(cmd).not.toContain(needle);
      return ok([...this.files.entries()].filter(([k, v]) => !k.endsWith(".map") && v.includes(needle)).map(([k]) => `dist/${k}\n`).join(""));
    }
    if (cmd.startsWith("test -d dist")) return ok([...this.files.keys()].join("\n") + "\n");
    if (cmd.startsWith("grep -rlF -e __zavi_dev dist")) return ok(this.devMarkerFiles);
    return ok();
  }
  async readFile(path: string) {
    const m = /^\/tmp\/site-[^/]+\/dist\/(.+)$/.exec(path);
    const v = m ? this.files.get(m[1]) : undefined;
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  async listFiles() {
    return [];
  }
  seedDist(files: Record<string, string> = { "index.html": "<div id=root></div>", "assets/app.js": "js" }) {
    for (const [k, v] of Object.entries(files)) this.files.set(k, v);
  }
}

function setup(rows: SiteRow[] = [siteRow(SITE_A, HOST_A), siteRow(SITE_B, HOST_B)], env: Record<string, string> = ENV) {
  const log: Log = [];
  const cf = new SiteFakeCloudflare(log);
  const store = new FakeStore(log, rows);
  const logs: Array<Record<string, unknown>> = [];
  let n = 0;
  const ids: string[] = [];
  const deps: SitePublishDeps = {
    store: store as unknown as SiteStore,
    pointer: store.ledger,
    log: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    env,
    fetchFn: cf.fetch,
    now: () => NOW,
    newDeployId: () => {
      const id = newSiteDeployId(NOW + n++ * 1000);
      ids.push(id);
      return id;
    },
    sleep: async () => undefined,
    verifyAttempts: 1,
    readAnonKey: async () => ANON,
  };
  return { log, logs, cf, store, deps, ids, publisher: createSitePublisher(deps) };
}

function hostRecord(cf: FakeCloudflare, host: string): Record<string, unknown> | null {
  const raw = cf.kv.get(`host:${host}`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function stageOne(t: ReturnType<typeof setup>, site_id = SITE_A, sha = SHA1) {
  const sb = new FakeSiteSandbox();
  sb.seedDist();
  const staged = await t.publisher.stage({ tenant_id: TENANT, site_id, sha, sandbox: sb });
  expect(staged.deploy_id).toBe(t.ids.at(-1));
  return { staged, sb };
}

describe("staging a commit the sandbox no longer has", () => {
  class ForgetfulSandbox extends FakeSiteSandbox {
    fetched = false;
    async run(cmd: string, opts: { cwd?: string; env?: Record<string, string>; redact?: string[]; user?: "root" | "user" } = {}) {
      if (cmd.startsWith("git cat-file -e")) {
        this.runs.push({ cmd, cwd: opts.cwd, env: opts.env, redact: opts.redact, user: opts.user });
        return { exitCode: this.fetched ? 0 : 1, stdout: "", stderr: "" };
      }
      if (/ fetch --quiet /.test(cmd)) {
        this.runs.push({ cmd, cwd: opts.cwd, env: opts.env, redact: opts.redact, user: opts.user });
        this.fetched = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return super.run(cmd, opts);
    }
  }

  it("fetches it with its own credential through env only, never through the scrubbed origin or the command", async () => {
    const t = setup();
    t.deps.repoFetchToken = async () => "ghp_SECRETTOKEN123";
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, github_full_name: "Zavi-Latest-Build/yoga-studio" });
    const publisher = createSitePublisher(t.deps);
    const sb = new ForgetfulSandbox();
    sb.seedDist();
    const staged = await publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb });
    expect(staged.deploy_id).toBe(t.ids.at(-1));
    const fetch = sb.runs.find((r) => / fetch --quiet /.test(r.cmd))!;
    expect(fetch).toBeTruthy();
    expect(fetch.cmd).toContain(`fetch --quiet --no-tags https://github.com/Zavi-Latest-Build/yoga-studio.git ${SHA1}`);
    expect(fetch.user).toBe("root");
    expect(fetch.cmd).not.toContain("ghp_SECRETTOKEN123");
    expect(Object.values(fetch.env ?? {}).join(" ")).toContain(Buffer.from("x-access-token:ghp_SECRETTOKEN123").toString("base64"));
    expect(fetch.redact).toEqual(expect.arrayContaining(["ghp_SECRETTOKEN123"]));
    const archive = sb.runs.find((r) => r.cmd.includes("archive"))!;
    expect(sb.runs.indexOf(fetch)).toBeLessThan(sb.runs.indexOf(archive));
    for (const r of sb.runs) expect(r.cmd).not.toMatch(/fetch[^\n]*\borigin\b/);
  });

  it("a commit that is present is never fetched", async () => {
    const t = setup();
    t.deps.repoFetchToken = async () => "ghp_SECRETTOKEN123";
    const { sb } = await stageOne(t);
    expect(sb.runs.some((r) => / fetch --quiet /.test(r.cmd))).toBe(false);
  });

  it("without a repo to fetch from, a missing commit fails the stage plainly", async () => {
    const t = setup();
    const sb = new ForgetfulSandbox();
    sb.seedDist();
    await expect(createSitePublisher(t.deps).stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/no valid repo/);
  });
});

describe("deploy ids", () => {
  it("sort by time and parse back", () => {
    const a = newSiteDeployId(NOW);
    const b = newSiteDeployId(NOW + 1);
    expect(a < b).toBe(true);
    expect(deployIdTime(a)).toBe(NOW);
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(deployIdTime("d_whatever")).toBeNull();
  });
});

describe("stage", () => {
  it("uploads under the store's hostname, never touches host:<hostname>, and routes before the first upload", async () => {
    const t = setup();
    t.cf.kv.set(`host:${HOST_A}`, JSON.stringify({ deploy_id: "dOLD", sha: SHA2 }));
    const { staged } = await stageOne(t);
    expect(t.cf.kv.get(`host:${HOST_A}`)).toBe(JSON.stringify({ deploy_id: "dOLD", sha: SHA2 }));
    expect([...t.cf.kv.keys()]).toEqual([`host:${HOST_A}`]);
    const keys = [...t.cf.r2.keys()].sort();
    expect(keys).toEqual([`sites/${HOST_A}/${staged.deploy_id}/assets/app.js`, `sites/${HOST_A}/${staged.deploy_id}/index.html`]);
    expect(t.cf.routes.map((r) => r.pattern)).toEqual([`${HOST_A}/*`]);
    expect(t.cf.dns.map((d) => [d.name, d.proxied])).toEqual([[HOST_A, true]]);
    const firstUpload = Math.min(...[...t.cf.r2.values()].map((v) => v.seq));
    const routingDone = Math.max(...t.cf.calls.filter((c) => /workers\/routes|dns_records/.test(c.url) && c.method === "POST").map((c) => c.seq));
    expect(routingDone).toBeLessThan(firstUpload);
    expect(t.log.indexOf("claim:cloudflare_host")).toBeLessThan(t.log.findIndex((l) => l.startsWith("cf:POST")));
    expect(t.store.providers.get(`${SITE_A}:cloudflare_host`)?.state).toBe("created");
    expect(t.store.providers.get(`${SITE_A}:r2_prefix`)).toEqual({ state: "created", ref: { prefix: `sites/${HOST_A}/` } });
    expect(staged.sha).toBe(SHA1);
  });

  it("the published index.html carries the framed-only editor loader from the production origin; other files are untouched", async () => {
    const prev = process.env.ZAVI_EDITOR_RUNTIME_ORIGIN;
    process.env.ZAVI_EDITOR_RUNTIME_ORIGIN = "http://localhost:3010";
    try {
      const t = setup();
      const sb = new FakeSiteSandbox();
      sb.seedDist({ "index.html": "<!doctype html><html><head><title>x</title></head><body><div id=root></div></body></html>", "assets/app.js": "js" });
      const staged = await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb });
      const html = t.cf.r2.get(`sites/${HOST_A}/${staged.deploy_id}/index.html`)!.body.toString("utf8");
      expect(html.split("zavi-editor-runtime.js")).toHaveLength(2);
      expect(html).toContain('s.src="https://www.zaviagent.com/zavi-editor-runtime.js"');
      expect(html).toContain("if(window.parent!==window)");
      expect(html).not.toContain("localhost");
      expect(html.indexOf("zavi-editor-runtime.js")).toBeLessThan(html.indexOf("</head>"));
      expect(html.startsWith("<!doctype html><html><head><title>x</title>")).toBe(true);
      expect(t.cf.r2.get(`sites/${HOST_A}/${staged.deploy_id}/assets/app.js`)!.body.toString("utf8")).toBe("js");
      expect(sb.files.get("index.html")).not.toContain("zavi-editor-runtime");
    } finally {
      if (prev === undefined) delete process.env.ZAVI_EDITOR_RUNTIME_ORIGIN;
      else process.env.ZAVI_EDITOR_RUNTIME_ORIGIN = prev;
    }
  });

  it("returns a preview URL on the hostname with a short-lived HMAC token the Worker accepts", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    const u = new URL(staged.preview_url);
    expect(u.origin).toBe(`https://${HOST_A}`);
    expect(u.pathname).toBe(`/__zavi_preview/${staged.deploy_id}/`);
    const [exp, sig] = (u.searchParams.get("t") ?? "").split(".");
    expect(Number(exp)).toBe(Math.floor(NOW / 1000) + SITE_PREVIEW_TTL_S);
    expect(sig).toBe(createHmac("sha256", PREVIEW_SECRET).update(`preview.${HOST_A}.${staged.deploy_id}.${exp}`).digest("hex"));
  });

  it("previewUrl: the staged deploy on the gate's TEST host, signed for that host; never the live hostname", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    const host = "v-0123456789abcdef.preview.zaviagent.com";
    const u = new URL(await t.publisher.previewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: staged.deploy_id, host: host.toUpperCase() }));
    expect(u.origin).toBe(`https://${host}`);
    expect(u.pathname).toBe(`/__zavi_preview/${staged.deploy_id}/`);
    const [exp, sig] = (u.searchParams.get("t") ?? "").split(".");
    expect(sig).toBe(createHmac("sha256", PREVIEW_SECRET).update(`preview.${host}.${staged.deploy_id}.${exp}`).digest("hex"));
    expect([...t.cf.r2.keys()].some((k) => k.startsWith(`sites/${host}/`))).toBe(false);
    await expect(t.publisher.previewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: staged.deploy_id, host: HOST_A })).rejects.toThrow(/must not be the site's own hostname/);
    await expect(t.publisher.previewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: staged.deploy_id, host: "evil.example/x" })).rejects.toThrow(/invalid preview host/);
    await expect(t.publisher.previewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: "../x", host })).rejects.toThrow(/invalid deploy id/);
    await expect(t.publisher.previewUrl({ tenant_id: "22222222-2222-4222-8222-222222222222", site_id: SITE_A, deploy_id: staged.deploy_id, host })).rejects.toThrow();
  });

  it("takes the hostname only from the site row, ignoring anything the caller passes", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    sb.seedDist();
    const input = { tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb, hostname: HOST_B } as never;
    await t.publisher.stage(input);
    expect([...t.cf.r2.keys()].every((k) => k.startsWith(`sites/${HOST_A}/`))).toBe(true);
    expect(t.cf.routes.map((r) => r.pattern)).toEqual([`${HOST_A}/*`]);
  });

  it("a site of another tenant is not found", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { tenant_id: "22222222-2222-4222-8222-222222222222" })]);
    const sb = new FakeSiteSandbox();
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/site not found/);
    expect(sb.runs).toEqual([]);
  });

  it("builds from the exact commit with npm ci then npm run build, copies the Vite env, and cleans up", async () => {
    const t = setup();
    const { staged, sb } = await stageOne(t);
    const dir = `/tmp/site-${staged.deploy_id}`;
    const cmds = sb.runs.map((r) => r.cmd);
    const archive = cmds.findIndex((c) => c.includes(`git -C /home/user/repo archive ${SHA1}`));
    const ci = cmds.findIndex((c) => c.startsWith("npm ci"));
    const build = cmds.findIndex((c) => c.includes("npm run build"));
    expect(archive).toBeGreaterThanOrEqual(0);
    expect(cmds[archive]).toContain(".env.local");
    expect(ci).toBeGreaterThan(archive);
    expect(build).toBeGreaterThan(ci);
    expect(sb.runs[ci].cwd).toBe(dir);
    expect(sb.runs[build].cwd).toBe(dir);
    expect(cmds.at(-1)).toBe(`rm -rf ${dir}`);
  });

  it("a failing build throws with the last 40 lines of stderr and uploads nothing", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    sb.fail.build = { exitCode: 1, stdout: "", stderr: lines.join("\n") };
    const err = await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("line 61\n");
    expect((err as Error).message).toContain("line 100");
    expect((err as Error).message).not.toContain("line 60\n");
    expect(t.cf.r2.size).toBe(0);
    expect(sb.runs.at(-1)?.cmd).toMatch(/^rm -rf \/tmp\/site-/);
  });

  it("REFUSES a production bundle carrying the dev-mode marker __zavi_dev, before any upload or routing", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    sb.seedDist();
    sb.devMarkerFiles = "dist/assets/app.js\n";
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/dev-mode marker __zavi_dev \(dist\/assets\/app\.js\)/);
    expect([...t.cf.r2.keys()]).toEqual([]);
    expect(t.log.some((l) => l.startsWith("cf:"))).toBe(false);
  });

  it("a failing npm ci throws", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    sb.fail.npm = { exitCode: 1, stdout: "", stderr: "ERESOLVE" };
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/npm ci.*ERESOLVE/s);
  });

  it("a failing npm run build or a bad lockfile is the site's (SiteBuildFailed)", async () => {
    for (const key of ["npm", "build"] as const) {
      const t = setup();
      const sb = new FakeSiteSandbox();
      sb.fail[key] = { exitCode: 1, stdout: "", stderr: key === "npm" ? "npm ERR! code ERESOLVE" : "src/App.tsx(4,1): error TS2304: Cannot find name 'Foo'." };
      await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toBeInstanceOf(SiteBuildFailed);
    }
    {
      const t = setup();
      const sb = new FakeSiteSandbox();
      sb.fail.build = { exitCode: 2, stdout: "", stderr: "src/api.ts(3,7): error TS2322: Type '\"fetch failed\"' is not assignable to type 'number'. HTTP 503 socket hang up ECONNRESET" };
      await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toBeInstanceOf(SiteBuildFailed);
    }
  });

  it("an npm registry outage, a dropped workspace or a timeout is NOT the site's (never SiteBuildFailed)", async () => {
    const cases: Array<["npm" | "build", { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; transportError?: boolean }]> = [
      ["npm", { exitCode: 1, stdout: "", stderr: "npm ERR! code ECONNRESET\nnpm ERR! network aborted" }],
      ["npm", { exitCode: 1, stdout: "", stderr: "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/react" }],
      ["build", { exitCode: 1, stdout: "", stderr: "SandboxError: connection lost", transportError: true }],
      ["build", { exitCode: 124, stdout: "", stderr: "", timedOut: true }],
    ];
    for (const [key, r] of cases) {
      const t = setup();
      const sb = new FakeSiteSandbox();
      sb.fail[key] = r;
      const err = await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SiteBuildFailed);
    }
  });

  it("a PGRST002 from Zavi's database while recording hosting is NOT the site's (never SiteBuildFailed)", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    sb.seedDist();
    t.store.setProviderState = async () => {
      throw new Error("SiteStore: site_provider_set failed (PGRST002): Could not query the database for the schema cache. Retrying.");
    };
    const err = await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/PGRST002/);
    expect(err).not.toBeInstanceOf(SiteBuildFailed);
  });

  it("a build without dist/index.html fails before any upload", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    sb.seedDist({ "other.html": "x" });
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/index\.html/);
    expect(t.cf.r2.size).toBe(0);
  });

  it("missing Cloudflare or preview credentials throw SiteCredentialsMissing with key names", async () => {
    const noPreview = setup(undefined, { ...FULL_ENV });
    const e1 = await noPreview.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: new FakeSiteSandbox() }).catch((e) => e);
    expect(e1).toBeInstanceOf(SiteCredentialsMissing);
    expect((e1 as SiteCredentialsMissing).missing).toEqual(["SITE_PREVIEW_HMAC_SECRET"]);
    const noCf = setup(undefined, { SITE_PREVIEW_HMAC_SECRET: "x" });
    const e2 = await noCf.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: new FakeSiteSandbox() }).catch((e) => e);
    expect((e2 as SiteCredentialsMissing).missing).toContain("CLOUDFLARE_STATIC_API_TOKEN");
  });

  it("refuses a bad sha, a bad hostname on the row, and a deleting site", async () => {
    const t = setup([
      siteRow(SITE_A, "not a host"),
      siteRow(SITE_B, HOST_B, { status: "deleting" }),
    ]);
    const sb = new FakeSiteSandbox();
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_B, sha: "zz", sandbox: sb })).rejects.toThrow(/invalid sha/);
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/invalid hostname/);
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_B, sha: SHA1, sandbox: sb })).rejects.toThrow(/deleting/);
    expect(t.cf.calls).toEqual([]);
  });
});

describe("stage: the site's Supabase config comes from the platform, not the sandbox env file", () => {
  it("a dedicated site builds with its own URL + anon key mapped onto the VITE_ names, passed via env and redacted", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { supabase_url: SB_URL })]);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist({ "index.html": "<div id=root></div>", "assets/app.js": `createClient("${SB_URL}","${ANON}")` });
    await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb });
    const build = sb.runs.find((r) => r.cmd.includes("npm run build"))!;
    expect(build.cmd).toBe('VITE_SUPABASE_URL="$ZAVI_PUB_URL" VITE_SUPABASE_ANON_KEY="$ZAVI_PUB_ANON" npm run build');
    expect(build.cmd).not.toContain(ANON);
    expect(build.env).toEqual({ ZAVI_PUB_URL: SB_URL, ZAVI_PUB_ANON: ANON });
    expect(build.redact).toEqual([ANON]);
    expect(t.cf.r2.size).toBe(2);
  });

  it("REFUSES a dedicated bundle that does not contain the site's Supabase host, as a platform error, before any upload", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { supabase_url: SB_URL })]);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist();
    const err = await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SitePublishPlatformError);
    expect((err as Error).message).toMatch(/abcdefghijklmnop\.supabase\.co/);
    expect(t.cf.r2.size).toBe(0);
    expect(t.log.some((l) => l.startsWith("cf:"))).toBe(false);
  });

  it("REFUSES a bundle whose project URL is present but the anon key is not (or only in a sourcemap)", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { supabase_url: SB_URL })]);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist({ "index.html": "<div id=root></div>", "assets/app.js": `createClient("${SB_URL}","")`, "assets/app.js.map": `"${ANON}"` });
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toBeInstanceOf(SitePublishPlatformError);
    expect(t.cf.r2.size).toBe(0);
  });

  it("a Vault read that throws is TRANSIENT (retried), never a platform failure or a repair", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { supabase_url: SB_URL })]);
    t.deps.readAnonKey = async () => { throw new Error("get_secret failed: timeout"); };
    const publisher = createSitePublisher(t.deps);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist();
    await expect(publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toBeInstanceOf(SitePublishTransientError);
  });

  it("a dedicated site whose anon key is missing fails as a platform error before the build", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { supabase_url: SB_URL })]);
    t.deps.readAnonKey = async () => null;
    const publisher = createSitePublisher(t.deps);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist();
    await expect(publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toBeInstanceOf(SitePublishPlatformError);
    expect(sb.runs.some((r) => r.cmd.includes("npm run build"))).toBe(false);
  });

  it("a pooled / static site (no project, code does not read VITE_SUPABASE) builds with the VITE_ names forced empty (beats any .env.local) and no assertion", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { backend_mode: "pooled" })]);
    const anon = vi.fn(async () => ANON);
    t.deps.readAnonKey = anon;
    const publisher = createSitePublisher(t.deps);
    const sb = new FakeSiteSandbox();
    sb.seedDist();
    await publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb });
    const build = sb.runs.find((r) => r.cmd.includes("npm run build"))!;
    expect(build.cmd).toBe("VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build");
    expect(build.env).toBeUndefined();
    expect(anon).not.toHaveBeenCalled();
    expect(t.cf.r2.size).toBe(2);
  });

  it("a pooled site whose row still carries a supabase_url (graduation in flight / rolled back) never gets those credentials", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { backend_mode: "pooled", supabase_url: SB_URL })]);
    const anon = vi.fn(async () => ANON);
    t.deps.readAnonKey = anon;
    const publisher = createSitePublisher(t.deps);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist();
    await publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb });
    const archive = sb.runs.find((r) => r.cmd.includes("archive"))!.cmd;
    expect(archive).not.toMatch(/cp \/home\/user\/repo\/\$f/);
    expect(archive).toMatch(/rm -f \/tmp\/site-[^ ]+\/\.env\.local/);
    const build = sb.runs.find((r) => r.cmd.includes("npm run build"))!;
    expect(build.cmd).toBe("VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build");
    expect(build.env).toBeUndefined();
    expect(anon).not.toHaveBeenCalled();
    expect(t.cf.r2.size).toBe(2);
  });

  it("a KERNEL site (own project served through the gateway, graduated or built) never gets its project's keys", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { supabase_url: SB_URL, backend_mode: "dedicated", kernel_shard_id: "k1" })]);
    const anon = vi.fn(async () => ANON);
    t.deps.readAnonKey = anon;
    const publisher = createSitePublisher(t.deps);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist();
    await publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb });
    const archive = sb.runs.find((r) => r.cmd.includes("archive"))!.cmd;
    expect(archive).toMatch(/rm -f \/tmp\/site-[^ ]+\/\.env\.local/);
    const build = sb.runs.find((r) => r.cmd.includes("npm run build"))!;
    expect(build.cmd).toBe("VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build");
    expect(anon).not.toHaveBeenCalled();
    expect(t.cf.r2.size).toBe(2);
  });

  it("a site whose code needs Supabase but has no project URL fails as a platform error", async () => {
    const t = setup([siteRow(SITE_A, HOST_A)]);
    const sb = new FakeSiteSandbox();
    sb.readsSupabase = true;
    sb.seedDist();
    await expect(t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb })).rejects.toThrow(/no project URL/);
  });
});

describe("activate", () => {
  it("CAS then host record with spa:true; returns the live url", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    const res = await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    expect(res).toEqual({ url: `https://${HOST_A}` });
    expect(hostRecord(t.cf, HOST_A)).toMatchObject({ deploy_id: staged.deploy_id, sha: SHA1, tenant_id: TENANT, spa: true });
    expect(t.log.indexOf(`cas:${staged.deploy_id}`)).toBeLessThan(t.log.findIndex((l) => l.startsWith("cf:PUT:") && l.includes("storage/kv")));
    const row = await t.store.get(TENANT, SITE_A);
    expect(row?.live_deploy_id).toBe(staged.deploy_id);
  });

  it("a (re)publish renders the pooled gateway binding FROM THE ROW (no merge in KV; stale KV junk is replaced)", async () => {
    const binding = { shard_id: "abcdefghijklmnopqrst", shard_url: "https://abcdefghijklmnopqrst.supabase.co", status: "active" as const, manifest_hash: "mh" };
    const t = setup([siteRow(SITE_A, HOST_A, { gateway_binding: binding, host_version: 7 }), siteRow(SITE_B, HOST_B)]);
    t.cf.kv.set(`host:${HOST_A}`, JSON.stringify({ deploy_id: "dOLD", rv: 3, junk_from_elsewhere: "x" }));
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    const rec = hostRecord(t.cf, HOST_A)!;
    expect(rec).toMatchObject({
      v: 1, site_id: SITE_A, ...binding, deploy_id: staged.deploy_id, sha: SHA1, spa: true, rv: 8, binding_version: 8,
    });
    expect(rec).not.toHaveProperty("junk_from_elsewhere");
  });

  it("a row whose binding is tombstoned publishes the tombstone (the gateway refuses it)", async () => {
    const binding = { shard_id: "abcdefghijklmnopqrst", shard_url: "https://abcdefghijklmnopqrst.supabase.co", status: "tombstoned" as const, manifest_hash: "" };
    const t = setup([siteRow(SITE_A, HOST_A, { gateway_binding: binding }), siteRow(SITE_B, HOST_B)]);
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    expect(hostRecord(t.cf, HOST_A)).toMatchObject({ status: "tombstoned" });
  });

  it("is refused when superseded (desired_sha moved on); KV untouched", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { desired_sha: SHA2 })]);
    const { staged } = await stageOne(t);
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged })).toEqual({ superseded: true });
    expect(t.cf.kv.has(`host:${HOST_A}`)).toBe(false);
  });

  it.each(["halted", "failed", "done"])("is refused when the run that asked for it is %s by the time it lands; nothing goes public", async (status) => {
    const t = setup();
    const { staged } = await stageOne(t);
    t.store.runs.set(RUN, { tenant_id: TENANT, status });
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged, conductor_run_id: RUN })).toEqual({ superseded: true });
    expect(t.cf.kv.has(`host:${HOST_A}`)).toBe(false);
    expect((await t.store.get(TENANT, SITE_A))?.live_deploy_id).toBeNull();
  });

  it("is refused for another tenant's run of the same id", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    t.store.runs.set(RUN, { tenant_id: "99999999-9999-4999-8999-999999999999", status: "active" });
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged, conductor_run_id: RUN })).toEqual({ superseded: true });
    expect(t.cf.kv.has(`host:${HOST_A}`)).toBe(false);
  });

  it.each(["provisioning", "active", "paused"])("goes live while the run that asked for it is %s", async (status) => {
    const t = setup();
    const { staged } = await stageOne(t);
    t.store.runs.set(RUN, { tenant_id: TENANT, status });
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged, conductor_run_id: RUN })).toEqual({ url: `https://${HOST_A}` });
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(staged.deploy_id);
  });

  it("is refused when a newer deploy is already live", async () => {
    const t = setup();
    const { staged: older } = await stageOne(t);
    const { staged: newer } = await stageOne(t);
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: newer })).toEqual({ url: `https://${HOST_A}` });
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: older })).toEqual({ superseded: true });
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(newer.deploy_id);
  });

  it("two concurrent activations end with KV at the newest desired deploy", async () => {
    const t = setup();
    const { staged: a } = await stageOne(t, SITE_A, SHA1);
    const { staged: b } = await stageOne(t, SITE_A, SHA2);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, desired_sha: SHA2 });
    const [ra, rb] = await Promise.all([
      t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a }),
      t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: b }),
    ]);
    expect(ra).toEqual({ superseded: true });
    expect(rb).toEqual({ url: `https://${HOST_A}` });
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(b.deploy_id);
  });

  it("a stale KV write that lands after a newer activation is repaired by the re-check", async () => {
    const t = setup();
    const { staged: a } = await stageOne(t, SITE_A, SHA1);
    const { staged: b } = await stageOne(t, SITE_A, SHA2);
    let releaseA: () => void = () => undefined;
    t.store.afterCas = async (id) => {
      if (id !== a.deploy_id) return;
      t.store.afterCas = null;
      t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, desired_sha: SHA2 });
      await new Promise<void>((r) => (releaseA = r));
    };
    const pa = t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a });
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: b })).toEqual({ url: `https://${HOST_A}` });
    releaseA();
    expect(await pa).toEqual({ superseded: true });
    expect(hostRecord(t.cf, HOST_A)).toMatchObject({ deploy_id: b.deploy_id, sha: SHA2, spa: true });
  });

  it("activating site A never touches site B's host record", async () => {
    const t = setup();
    t.cf.kv.set(`host:${HOST_B}`, "B-record");
    const { staged } = await stageOne(t, SITE_A);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    expect(t.cf.kv.get(`host:${HOST_B}`)).toBe("B-record");
  });
});

describe("version history links", () => {
  it("versionPreviewUrl shows a stored deploy on the site's OWN hostname, signed for it, in embed mode", async () => {
    const t = setup();
    const id = newSiteDeployId(NOW - 60_000);
    t.cf.r2.set(`sites/${HOST_A}/${id}/index.html`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    const { url, expires_at } = await t.publisher.versionPreviewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: id });
    const u = new URL(url);
    expect(u.origin).toBe(`https://${HOST_A}`);
    expect(u.pathname).toBe(`/__zavi_preview/${id}/`);
    expect(u.searchParams.get(SITE_PREVIEW_EMBED_PARAM)).toBe("1");
    const [exp, sig] = (u.searchParams.get("t") ?? "").split(".");
    expect(sig).toBe(createHmac("sha256", PREVIEW_SECRET).update(`preview.${HOST_A}.${id}.${exp}`).digest("hex"));
    expect(Date.parse(expires_at)).toBe(Number(exp) * 1000);
  });

  it("versionPreviewUrl refuses another tenant's site, a deleted site and a malformed id", async () => {
    const t = setup();
    const id = newSiteDeployId(NOW);
    await expect(t.publisher.versionPreviewUrl({ tenant_id: "22222222-2222-4222-8222-222222222222", site_id: SITE_A, deploy_id: id })).rejects.toThrow();
    await expect(t.publisher.versionPreviewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: "../x" })).rejects.toThrow(/invalid deploy id/);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, status: "deleted" });
    await expect(t.publisher.versionPreviewUrl({ tenant_id: TENANT, site_id: SITE_A, deploy_id: id })).rejects.toThrow(/deleted/);
  });

  it("hasDeploy reads only this site's prefix", async () => {
    const t = setup();
    const [a, b, other] = [newSiteDeployId(NOW), newSiteDeployId(NOW + 1000), newSiteDeployId(NOW + 2000)];
    for (const f of ["index.html", "assets/app.js"]) {
      t.cf.r2.set(`sites/${HOST_A}/${a}/${f}`, { body: Buffer.from("x"), contentType: "", seq: 0 });
      t.cf.r2.set(`sites/${HOST_A}/${b}/${f}`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    }
    t.cf.r2.set(`sites/${HOST_B}/${other}/index.html`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    expect(await t.publisher.hasDeploy({ tenant_id: TENANT, site_id: SITE_A, deploy_id: b })).toBe(true);
    expect(await t.publisher.hasDeploy({ tenant_id: TENANT, site_id: SITE_A, deploy_id: a })).toBe(true);
    expect(await t.publisher.hasDeploy({ tenant_id: TENANT, site_id: SITE_A, deploy_id: other })).toBe(false);
    expect(await t.publisher.hasDeploy({ tenant_id: TENANT, site_id: SITE_A, deploy_id: "../x" })).toBe(false);
  });
});

describe("activationState", () => {
  const staged = { deploy_id: newSiteDeployId(NOW), sha: SHA1, preview_url: "" };
  it("reads live / superseded / pending from the site row", () => {
    expect(activationState(siteRow(SITE_A, HOST_A, { live_deploy_id: staged.deploy_id }), staged)).toBe("live");
    expect(activationState(siteRow(SITE_A, HOST_A, { desired_sha: SHA2 }), staged)).toBe("superseded");
    expect(activationState(siteRow(SITE_A, HOST_A, { live_deploy_id: newSiteDeployId(NOW + 5) }), staged)).toBe("superseded");
    expect(activationState(siteRow(SITE_A, HOST_A), staged)).toBe("pending");
  });
});

describe("retention", () => {
  it("keeps the live deploy + 20 previous for version history, never deletes a newer (staged) deploy, never other hosts", async () => {
    const t = setup();
    const ids = Array.from({ length: 25 }, (_, i) => newSiteDeployId(NOW + i * 1000));
    for (const id of ids) t.cf.r2.set(`sites/${HOST_A}/${id}/index.html`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    t.cf.r2.set(`sites/${HOST_B}/${ids[0]}/index.html`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    const live = ids[23];
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, live_deploy_id: live });
    const res = await t.publisher.prune({ tenant_id: TENANT, site_id: SITE_A });
    expect(SITE_RETAIN_PREVIOUS).toBe(20);
    expect(res.deleted.sort()).toEqual([ids[0], ids[1], ids[2]]);
    const left = [...t.cf.r2.keys()].filter((k) => k.startsWith(`sites/${HOST_A}/`)).map((k) => k.split("/")[2]).sort();
    expect(left).toEqual(ids.slice(3));
    expect(t.cf.r2.has(`sites/${HOST_B}/${ids[0]}/index.html`)).toBe(true);
  });

  it("does nothing without a live deploy", async () => {
    const t = setup();
    t.cf.r2.set(`sites/${HOST_A}/${newSiteDeployId(NOW)}/index.html`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    expect(await t.publisher.prune({ tenant_id: TENANT, site_id: SITE_A })).toEqual({ deleted: [] });
    expect(t.cf.r2.size).toBe(1);
  });
});

describe("verify and teardown", () => {
  it("verify is true for a 200 HTML response from the hostname", async () => {
    const t = setup();
    expect(await t.publisher.verify(HOST_A)).toBe(true);
    t.cf.site = () => ({ status: 404, headers: { get: () => "text/plain" }, text: async () => "" });
    expect(await t.publisher.verify(HOST_A)).toBe(false);
    expect(await t.publisher.verify("not a host")).toBe(false);
  });

  it("teardown removes the KV keys, the R2 prefix, the route and the DNS record of that site only", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.cf.kv.set(`paused:${HOST_A}`, "1");
    t.cf.kv.set(`lastseen:${HOST_A}`, "x");
    t.cf.kv.set(`host:${HOST_B}`, "B");
    t.cf.r2.set(`sites/${HOST_B}/x/index.html`, { body: Buffer.from("x"), contentType: "", seq: 0 });
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, status: "deleting" });
    await t.publisher.teardown({ tenant_id: TENANT, site_id: SITE_A });
    expect([...t.cf.kv.keys()]).toEqual([`host:${HOST_B}`]);
    expect([...t.cf.r2.keys()]).toEqual([`sites/${HOST_B}/x/index.html`]);
    expect(t.cf.routes).toEqual([]);
    expect(t.cf.dns).toEqual([]);
    expect(t.store.providers.get(`${SITE_A}:cloudflare_host`)?.state).toBe("deleted");
    expect(t.store.providers.get(`${SITE_A}:r2_prefix`)?.state).toBe("deleted");
  });
});

function failHostWrites(t: ReturnType<typeof setup>, failing: () => boolean, onPut?: () => void) {
  const base = t.cf.fetch;
  const wrapped: StaticFetch = async (url, init = {}) => {
    const isHostPut = (init.method ?? "GET").toUpperCase() === "PUT" && decodeURIComponent(url).includes("/values/host:");
    if (isHostPut) {
      onPut?.();
      if (failing()) return { status: 500, headers: { get: () => null }, text: async () => "boom" };
    }
    return base(url, init);
  };
  t.deps.fetchFn = wrapped;
  return createSitePublisher(t.deps);
}

describe("KV pointer projection (DB is the desired state, KV a projection)", () => {
  it("a KV failure after the DB write is repaired by the reconciler (and logged as drift)", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    let fail = true;
    const pub = failHostWrites(t, () => fail);
    await expect(pub.activate({ tenant_id: TENANT, site_id: SITE_A, staged })).rejects.toThrow(/KV pointer reconcile failed/);
    expect((await t.store.get(TENANT, SITE_A))?.live_deploy_id).toBe(staged.deploy_id);
    expect(hostRecord(t.cf, HOST_A)).toBeNull();
    expect(await t.store.ledger.driftBatch("2100-01-01T00:00:00Z", 10)).toEqual([{ tenant_id: TENANT, site_id: SITE_A }]);
    expect(t.logs.at(-1)).toMatchObject({ evt: "site_pointer", level: "error", site_id: SITE_A, drift_count: 1 });

    fail = false;
    const r = await pub.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" });
    expect(r.outcome).toBe("repaired");
    expect(hostRecord(t.cf, HOST_A)).toMatchObject({ deploy_id: staged.deploy_id, sha: SHA1, spa: true });
    expect(confirmed(await t.store.get(TENANT, SITE_A))).toBe(true);
    expect(await t.store.ledger.driftBatch("2100-01-01T00:00:00Z", 10)).toEqual([]);
    expect(t.logs.at(-1)).toMatchObject({ level: "warn", msg: "KV pointer drift repaired", db_deploy_id: staged.deploy_id, kv_deploy_id: null });
  });

  it("a retried activation that lost the CAS still projects the row's live deploy into KV", async () => {
    const t = setup();
    const { staged: a } = await stageOne(t, SITE_A, SHA1);
    let fail = true;
    const pub = failHostWrites(t, () => fail);
    await expect(pub.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a })).rejects.toThrow();
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, desired_sha: SHA2 });
    fail = false;
    expect(await pub.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a })).toEqual({ superseded: true });
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(a.deploy_id);
    expect(confirmed(await t.store.get(TENANT, SITE_A))).toBe(true);
  });

  it("concurrent activations of one commit: the older deploy never overwrites the newer, in DB or KV", async () => {
    const t = setup();
    const { staged: older } = await stageOne(t, SITE_A, SHA1);
    const { staged: newer } = await stageOne(t, SITE_A, SHA1);
    let release: () => void = () => undefined;
    t.store.beforeCas = async (id) => {
      if (id !== older.deploy_id) return;
      t.store.beforeCas = null;
      await new Promise<void>((r) => (release = r));
    };
    const pOlder = t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: older });
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: newer })).toEqual({ url: `https://${HOST_A}` });
    release();
    expect(await pOlder).toEqual({ superseded: true });
    const row = await t.store.get(TENANT, SITE_A);
    expect(row?.live_deploy_id).toBe(newer.deploy_id);
    expect(confirmed(row)).toBe(true);
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(newer.deploy_id);
    expect(t.log.filter((l) => l === `cas:${older.deploy_id}`)).toEqual([]);
  });

  it("an older activation retry after a KV outage still repairs KV to the newer live deploy", async () => {
    const t = setup();
    const { staged: a } = await stageOne(t, SITE_A, SHA1);
    const { staged: b } = await stageOne(t, SITE_A, SHA1);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a });
    let fail = true;
    const pub = failHostWrites(t, () => fail);
    await expect(pub.activate({ tenant_id: TENANT, site_id: SITE_A, staged: b })).rejects.toThrow();
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(a.deploy_id);
    fail = false;
    expect(await pub.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a })).toEqual({ superseded: true });
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(b.deploy_id);
    expect((await t.store.get(TENANT, SITE_A))?.live_deploy_id).toBe(b.deploy_id);
  });

  it("a reconciler holding a stale snapshot never leaves KV behind the row", async () => {
    const t = setup();
    const { staged: a } = await stageOne(t, SITE_A, SHA1);
    const { staged: b } = await stageOne(t, SITE_A, SHA2);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a });
    let raced = false;
    const pub = failHostWrites(t, () => false, () => {
      if (raced) return;
      raced = true;
      t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, desired_sha: SHA2, live_sha: SHA2, live_deploy_id: b.deploy_id });
      t.cf.kv.set(`host:${HOST_A}`, JSON.stringify({ deploy_id: b.deploy_id, sha: SHA2 }));
    });
    t.cf.kv.delete(`host:${HOST_A}`);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, kv_host_version: -1 });
    await pub.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" });
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(b.deploy_id);
    expect(confirmed(await t.store.get(TENANT, SITE_A))).toBe(true);
  });

  it("the reconciler is idempotent: a second run on a repaired site writes nothing", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.cf.kv.delete(`host:${HOST_A}`);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, kv_host_version: -1 });
    expect((await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).outcome).toBe("repaired");
    const writes = t.log.length;
    for (let i = 0; i < 3; i++) {
      expect((await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).outcome).toBe("in_sync");
    }
    expect(t.log.slice(writes)).toEqual([]);
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(staged.deploy_id);
    expect((await t.store.get(TENANT, SITE_A))?.kv_drift_count).toBe(1);
  });

  it("a KV record that already matches only records it, without writing KV or counting drift", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, kv_host_version: -1 });
    const before = t.log.length;
    expect((await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).outcome).toBe("in_sync");
    expect(t.log.slice(before)).toEqual([`mark:${staged.deploy_id}:false`]);
  });

  it.each(["deleting", "deleted", "fell_back_old"] as const)("a %s site is never resurrected: its record is removed, never written", async (status) => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, status });
    const r = await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" });
    expect(r.outcome).toBe("removed");
    expect(t.cf.kv.has(`host:${HOST_A}`)).toBe(false);
    expect(confirmed(await t.store.get(TENANT, SITE_A))).toBe(true);
    const before = t.log.length;
    expect((await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).outcome).toBe("in_sync");
    const { staged: again } = await stageOne(t).catch(() => ({ staged: { ...staged, deploy_id: newSiteDeployId(NOW + 99_000) } }));
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged: again })).toEqual({ superseded: true });
    expect(t.cf.kv.has(`host:${HOST_A}`)).toBe(false);
    expect(t.log.slice(before).filter((l) => l.startsWith("cf:PUT:") && l.includes("storage/kv"))).toEqual([]);
  });

  it("a site deleted while the reconciler writes its record ends with no record", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.cf.kv.delete(`host:${HOST_A}`);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, kv_host_version: -1 });
    const pub = failHostWrites(t, () => false, () => {
      t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, status: "deleting" });
      t.cf.kv.delete(`host:${HOST_A}`);
    });
    const r = await pub.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" });
    expect(r.outcome).toBe("removed");
    expect(t.cf.kv.has(`host:${HOST_A}`)).toBe(false);
  });

  it("repeated drift raises an ALERT log line", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.cf.kv.delete(`host:${HOST_A}`);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, kv_host_version: -1 });
    const pub = failHostWrites(t, () => true);
    for (let i = 1; i <= 3; i++) {
      await expect(pub.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).rejects.toThrow(/kv write failed \(500\)/);
      expect(t.logs.at(-1)).toMatchObject({ evt: "site_pointer", drift_count: i, level: i >= 3 ? "alert" : "error" });
    }
    expect(String(t.logs.at(-1)?.msg)).toMatch(/^ALERT repeated KV pointer drift/);
  });
});

describe("ONE projection: activation, pooled binding change and reconcile share the renderer, the version and the writer", () => {
  const BINDING = { shard_id: "abcdefghijklmnopqrst", shard_url: "https://abcdefghijklmnopqrst.supabase.co", status: "active" as const, manifest_hash: "mh" };
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("INTERLEAVING x200: activation + binding change + sweep reconcile end at render(newest row), no field lost, newest version wins", async () => {
    for (let trial = 0; trial < 200; trial++) {
      const t = setup();
      const { staged: a } = await stageOne(t, SITE_A, SHA1);
      const rnd = (n: number) => Math.floor(Math.random() * n);
      const delay = async () => {
        for (let i = rnd(4); i > 0; i--) await tick();
      };
      const base = t.cf.fetch;
      t.deps.fetchFn = (async (url, init) => {
        if (url.includes("/storage/kv/")) await delay();
        return base(url, init);
      }) as StaticFetch;
      const pub = createSitePublisher(t.deps);
      const kv: KvStore = {
        get: async (k) => (await delay(), t.cf.kv.get(k) ?? null),
        put: async (k, v) => void (await delay(), t.cf.kv.set(k, v)),
        delete: async (k) => void (await delay(), t.cf.kv.delete(k)),
      };
      const verified: number[] = [];
      const pooled = {
        kv,
        get: (tid: string, sid: string) => t.store.get(tid, sid),
        bump: async (_t: string, sid: string, binding?: GatewayBindingRow | null) => {
          await delay();
          const r = t.store.sites.get(sid)!;
          t.store.sites.set(sid, { ...r, host_version: (r.host_version ?? 0) + 1, ...(binding !== undefined ? { gateway_binding: binding } : {}) });
          return { ...t.store.sites.get(sid)! };
        },
        requestVerify: async (_t: string, _s: string, v: number) => void verified.push(v),
      };
      const versionsSeen: number[] = [];
      const watch = setInterval(() => {
        const raw = t.cf.kv.get(`host:${HOST_A}`);
        if (raw) versionsSeen.push(Number(JSON.parse(raw).rv));
      }, 0);
      await Promise.all([
        (async () => (await delay(), pub.activate({ tenant_id: TENANT, site_id: SITE_A, staged: a })))(),
        (async () => (await delay(), syncHostRecord(pooled, { tenant_id: TENANT, site_id: SITE_A, binding: BINDING })))(),
        (async () => (await delay(), pub.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })))(),
      ]);
      clearInterval(watch);
      const row = (await t.store.get(TENANT, SITE_A))!;
      const got = hostRecord(t.cf, HOST_A)!;
      expect(got).toEqual(renderHostRecord(row)!.value);
      expect(got).toMatchObject({ deploy_id: a.deploy_id, sha: SHA1, spa: true, site_id: SITE_A, ...BINDING, rv: row.host_version, binding_version: row.host_version });
      expect(row.host_version).toBe(2);
      if (confirmed(row)) expect(got.rv).toBe(row.host_version);
      expect(verified.at(-1)).toBeGreaterThanOrEqual(1);
      expect((await pub.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "verify" })).outcome).toBe("in_sync");
      expect(confirmed(await t.store.get(TENANT, SITE_A))).toBe(true);
      expect(Math.max(...versionsSeen, 0)).toBeLessThanOrEqual(row.host_version ?? 0);
    }
  });

  it("an activation re-renders the binding; a binding change keeps the live deploy (no lost update either way)", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { gateway_binding: BINDING, host_version: 3 })]);
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    expect(hostRecord(t.cf, HOST_A)).toMatchObject({ deploy_id: staged.deploy_id, ...BINDING, rv: 4 });
    const kv: KvStore = { get: async (k) => t.cf.kv.get(k) ?? null, put: async (k, v) => void t.cf.kv.set(k, v) };
    await syncHostRecord(
      {
        kv,
        get: (a, b) => t.store.get(a, b),
        bump: async (_a, s, binding) => {
          const r = t.store.sites.get(s)!;
          t.store.sites.set(s, { ...r, host_version: (r.host_version ?? 0) + 1, ...(binding !== undefined ? { gateway_binding: binding } : {}) });
          return { ...t.store.sites.get(s)! };
        },
      },
      { tenant_id: TENANT, site_id: SITE_A, binding: { ...BINDING, manifest_hash: "mh2" } },
    );
    expect(hostRecord(t.cf, HOST_A)).toMatchObject({ deploy_id: staged.deploy_id, manifest_hash: "mh2", rv: 5 });
    expect(await t.store.ledger.driftBatch("2100-01-01T00:00:00Z", 10)).toEqual([{ tenant_id: TENANT, site_id: SITE_A }]);
    expect((await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).outcome).toBe("in_sync");
    expect(await t.store.ledger.driftBatch("2100-01-01T00:00:00Z", 10)).toEqual([]);
  });

  it("teardown keeps a pooled site's quarantine tombstone (TTL), never a live binding or deploy", async () => {
    const t = setup([siteRow(SITE_A, HOST_A, { gateway_binding: BINDING, host_version: 3 })]);
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, status: "deleting" });
    await t.publisher.teardown({ tenant_id: TENANT, site_id: SITE_A });
    const rec = hostRecord(t.cf, HOST_A)!;
    expect(rec).toMatchObject({ site_id: SITE_A, status: "tombstoned" });
    expect(rec).not.toHaveProperty("deploy_id");
    expect(t.cf.calls.some((c) => c.method === "PUT" && c.url.includes(`host%3A${HOST_A}`) && c.url.includes("expiration_ttl="))).toBe(true);
    expect(await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged })).toEqual({ superseded: true });
    expect(hostRecord(t.cf, HOST_A)).not.toHaveProperty("deploy_id");
  });

  it("teardown of a row that is not deleting leaves the host record alone and fails (cleanup stays pending)", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    await t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged });
    await expect(t.publisher.teardown({ tenant_id: TENANT, site_id: SITE_A })).rejects.toThrow(/not deleting/);
    expect(hostRecord(t.cf, HOST_A)?.deploy_id).toBe(staged.deploy_id);
  });

  it("never overwrites or removes another site's record at the hostname (cross-tenant)", async () => {
    const t = setup();
    const { staged } = await stageOne(t);
    const other = JSON.stringify({ v: 1, site_id: SITE_B, status: "tombstoned", rv: 99 });
    t.cf.kv.set(`host:${HOST_A}`, other);
    await expect(t.publisher.activate({ tenant_id: TENANT, site_id: SITE_A, staged })).rejects.toThrow(/another site's record/);
    expect(t.cf.kv.get(`host:${HOST_A}`)).toBe(other);
    t.store.sites.set(SITE_A, { ...t.store.sites.get(SITE_A)!, status: "deleted" });
    expect((await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" })).outcome).toBe("in_sync");
    expect(t.cf.kv.get(`host:${HOST_A}`)).toBe(other);
    t.cf.kv.set(`host:${HOST_A}`, JSON.stringify({ deploy_id: "dX", sha: SHA2, tenant_id: "22222222-2222-4222-8222-222222222222" }));
    await t.publisher.reconcile({ tenant_id: TENANT, site_id: SITE_A, source: "sweep" });
    expect(hostRecord(t.cf, HOST_A)?.tenant_id).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("version previews reuse the sandbox's saved install (install-cache.ts)", () => {
  const KEY = "0123456789abcdef01234567";
  const GOOD = "a".repeat(64);
  class CachingSandbox extends FakeSiteSandbox {
    saved = false;
    restoredDigest = GOOD;
    async run(cmd: string, opts: { cwd?: string; env?: Record<string, string>; redact?: string[]; user?: "root" | "user" } = {}) {
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (cmd.includes("zavi-install-cache-v3")) {
        this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
        return ok(`${KEY}\n`);
      }
      if (cmd.includes("find node_modules -type l")) {
        this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
        const restored = this.runs.some((r) => r.cmd.includes("cp -a /home/user/.zavi-install-cache/"));
        return ok(`${restored ? this.restoredDigest : GOOD}\n`);
      }
      if (cmd.includes(`test -f /home/user/.zavi-install-cache/${KEY}/.done`)) {
        this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
        return this.saved ? ok() : { exitCode: 1, stdout: "", stderr: "" };
      }
      return super.run(cmd, opts);
    }
  }

  async function stageWith(sb: CachingSandbox, reuseInstall: boolean) {
    const t = setup();
    sb.seedDist();
    await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb, reuseInstall });
    return sb.runs.map((r) => r.cmd);
  }

  beforeEach(() => __resetInstallDigests());

  it("a miss installs with npm ci, digests the fresh tree and saves it BEFORE the build runs; the next version restores it", async () => {
    const cmds = await stageWith(new CachingSandbox(), true);
    const ci = cmds.findIndex((c) => c.startsWith("npm ci"));
    const digest = cmds.findIndex((c) => c.includes("find node_modules -type l"));
    const save = cmds.findIndex((c) => c.includes("mv -T /home/user/.zavi-install-cache/.tmp-"));
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(digest).toBeGreaterThan(ci);
    expect(save).toBeGreaterThan(digest);
    expect(cmds.findIndex((c) => c.includes("npm run build"))).toBeGreaterThan(save);

    const next = new CachingSandbox();
    next.saved = true;
    const again = await stageWith(next, true);
    expect(again.some((c) => c.includes("cp -a /home/user/.zavi-install-cache/"))).toBe(true);
    expect(again.some((c) => c.startsWith("npm ci"))).toBe(false);
  });

  it("a saved tree that changed since it was saved is never used: dropped, and npm ci runs", async () => {
    await stageWith(new CachingSandbox(), true);
    const tampered = new CachingSandbox();
    tampered.saved = true;
    tampered.restoredDigest = "b".repeat(64);
    const cmds = await stageWith(tampered, true);
    const drop = cmds.findIndex((c) => /^rm -rf \/tmp\/site-[^ ]+\/node_modules \/home\/user\/\.zavi-install-cache\/0123456789abcdef01234567$/.test(c));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(cmds.findIndex((c) => c.startsWith("npm ci"))).toBeGreaterThan(drop);
  });

  it("an entry the backend has no digest for (another process saved it, or a restart) is never restored", async () => {
    const sb = new CachingSandbox();
    sb.saved = true;
    const cmds = await stageWith(sb, true);
    expect(cmds.some((c) => c.includes("cp -a /home/user/.zavi-install-cache/"))).toBe(false);
    expect(cmds.some((c) => c.startsWith("npm ci"))).toBe(true);
  });

  it("no cache step ever runs as root", async () => {
    const sb = new CachingSandbox();
    await stageWith(sb, true);
    const next = new CachingSandbox();
    next.saved = true;
    await stageWith(next, true);
    for (const r of [...sb.runs, ...next.runs]) expect(r.user).toBeUndefined();
  });

  it("a publish never touches the cache", async () => {
    const sb = new CachingSandbox();
    sb.saved = true;
    const cmds = await stageWith(sb, false);
    expect(cmds.some((c) => c.includes("zavi-install-cache"))).toBe(false);
    expect(cmds.some((c) => c.startsWith("npm ci"))).toBe(true);
  });
});

describe("a prewarm version build gives way to the founder's work on the site (shouldYield)", () => {
  it("does not start when the site is already busy, and leaves no build dir", async () => {
    const t = setup();
    const sb = new FakeSiteSandbox();
    sb.seedDist();
    await expect(
      t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb, reuseInstall: true, shouldYield: async () => true }),
    ).rejects.toBeInstanceOf(StageYielded);
    const cmds = sb.runs.map((r) => r.cmd);
    expect(cmds.some((c) => c.startsWith("npm ci") || c.includes("npm run build"))).toBe(false);
    expect(cmds.at(-1)).toMatch(/^rm -rf \/tmp\/site-/);
    expect(t.cf.r2.size).toBe(0);
  });

  it("stops a running build (kills the processes in its dir) when the site gets busy, and uploads nothing", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      let release!: () => void;
      class SlowBuild extends FakeSiteSandbox {
        async run(cmd: string, opts: { cwd?: string; env?: Record<string, string>; redact?: string[]; user?: "root" | "user" } = {}) {
          if (cmd.includes("npm run build")) {
            this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
            await new Promise<void>((r) => (release = r));
            return { exitCode: 137, stdout: "", stderr: "Killed" };
          }
          if (cmd.includes("/proc/[0-9]*")) {
            this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
            release();
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return super.run(cmd, opts);
        }
      }
      const sb = new SlowBuild();
      sb.seedDist();
      let busy = false;
      const staged = t.publisher
        .stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb, reuseInstall: true, shouldYield: async () => busy })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(STAGE_YIELD_POLL_MS * 2);
      expect(sb.runs.some((r) => r.cmd.includes("npm run build"))).toBe(true);
      busy = true;
      await vi.advanceTimersByTimeAsync(STAGE_YIELD_POLL_MS);
      expect(await staged).toBeInstanceOf(StageYielded);
      const kill = sb.runs.find((r) => r.cmd.includes("/proc/[0-9]*"))!;
      expect(kill.user).toBeUndefined();
      expect(kill.cmd).toMatch(/case "\$c" in \/tmp\/site-[^|]+\|\/tmp\/site-[^)]+\/\*\) kill -KILL/);
      expect(t.cf.r2.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow cache restore gives way too, and no install or build starts after it", async () => {
    try {
      __resetInstallDigests();
      const KEY = "0123456789abcdef01234567";
      const GOOD = "a".repeat(64);
      let release!: () => void;
      class SlowRestore extends FakeSiteSandbox {
        restoring = false;
        async run(cmd: string, opts: { cwd?: string; env?: Record<string, string>; redact?: string[]; user?: "root" | "user" } = {}) {
          const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
          if (cmd.includes("zavi-install-cache-v3")) return ok(`${KEY}\n`);
          if (cmd.includes("find node_modules -type l")) return ok(`${GOOD}\n`);
          if (this.restoring && cmd.includes(`test -f /home/user/.zavi-install-cache/${KEY}/.done`)) {
            this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
            await new Promise<void>((r) => (release = r));
            return { exitCode: 137, stdout: "", stderr: "Killed" };
          }
          if (cmd.includes("/proc/[0-9]*")) {
            this.runs.push({ cmd, cwd: opts.cwd, user: opts.user });
            release?.();
            return ok();
          }
          return super.run(cmd, opts);
        }
      }
      const t = setup();
      const first = new SlowRestore();
      first.seedDist();
      await t.publisher.stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: first, reuseInstall: true });
      vi.useFakeTimers();
      const sb = new SlowRestore();
      sb.restoring = true;
      sb.seedDist();
      let busy = false;
      const staged = t.publisher
        .stage({ tenant_id: TENANT, site_id: SITE_A, sha: SHA1, sandbox: sb, reuseInstall: true, shouldYield: async () => busy })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(STAGE_YIELD_POLL_MS);
      expect(sb.runs.some((r) => r.cmd.includes("cp -a /home/user/.zavi-install-cache/"))).toBe(true);
      busy = true;
      await vi.advanceTimersByTimeAsync(STAGE_YIELD_POLL_MS * 2);
      expect(await staged).toBeInstanceOf(StageYielded);
      const cmds = sb.runs.map((r) => r.cmd);
      expect(cmds.some((c) => c.includes("/proc/[0-9]*"))).toBe(true);
      expect(cmds.some((c) => c.startsWith("npm ci") || c.includes("npm run build"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the kill script only ever names a stage dir", () => {
    expect(() => stageKillScript("/home/user/repo")).toThrow();
    expect(() => stageKillScript("/tmp/site-x; rm -rf /")).toThrow();
  });
});
