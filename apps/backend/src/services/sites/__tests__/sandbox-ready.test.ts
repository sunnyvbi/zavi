
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrepareSiteTreeCmd, buildStopDevServerCmd, buildSyncSiteDepsCmd, onSiteSandboxReady, PORT_HOLDER_SCRIPT, PREVIEW_CONFIG_WRITE_TIMEOUT_MS, PREVIEW_READY_CONFIRM_GAP_MS, PREPARE_SITE_TREE_TIMEOUT_MS, REMOVE_ENV_LOCAL_CMD, SITE_DEPS_SYNC_TIMEOUT_MS, SITE_DEV_START_CMD, STAMP_BAKED_DEPS_CMD, STOP_DEV_SERVER_TIMEOUT_MS, STOP_TEMPLATE_DEV_SERVER_CMD, SYNC_SITE_DEPS_CMD, WRITE_ENV_LOCAL_CMD, type SandboxReadyDeps } from "../sandbox-ready";
import { installSiteDeps } from "@/services/build/deps-install-script";
import { writeSitePreviewConfigCmd } from "../preview-picker";
import { FIRST_DRAFT_DIR, FIRST_DRAFT_HOME_ABS } from "../first-draft";
import { zaviStarterProvider } from "@/services/provisioning/templates/vite-react-zavi";
import { fakeStore, type FakeStore } from "./site-fakes";
import { SitePublishPlatformError } from "../contract";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const ANON = "anon-key-abcdefghijklmnop";

let store: FakeStore;
let order: string[];
let cmds: Array<{ cmd: string; env?: Record<string, string>; t?: number }>;
let scheduled: Array<Promise<unknown>>;

type Part = "stop" | "env" | "rm-env" | "picker" | "deps";
const PARTS: Array<[string, Part]> = [
  [STOP_TEMPLATE_DEV_SERVER_CMD, "stop"],
  [WRITE_ENV_LOCAL_CMD, "env"],
  [REMOVE_ENV_LOCAL_CMD, "rm-env"],
  [writeSitePreviewConfigCmd(), "picker"],
  [SYNC_SITE_DEPS_CMD, "deps"],
];

function runPrepared(cmd: string, env: Record<string, string> | undefined, fail: Partial<Record<Part, number>>, stopOut = "") {
  const dir = mkdtempSync(join(tmpdir(), "zprep-"));
  const log = join(dir, "log");
  const out = join(dir, "stop-out");
  writeFileSync(out, stopOut);
  let script = cmd;
  for (const [text, name] of PARTS) {
    const guard = name === "env" ? `{ [ -n "$VITE_SUPABASE_ANON_KEY" ] && [ -n "$VITE_SUPABASE_URL" ]; } || exit 97; ` : "";
    const print = name === "stop" ? `cat '${out}'; ` : "";
    script = script.split(text).join(`echo ${name} >> '${log}'; ${guard}${print}exit ${fail[name] ?? 0}`);
  }
  const r = spawnSync("bash", ["-c", `(set -e; ${script}\n)`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...(env ?? {}) } });
  const ran = existsSync(log) ? (readFileSync(log, "utf8").split("\n").filter(Boolean) as Part[]) : [];
  return { stdout: r.stdout, exit_code: r.status ?? 1, ran };
}

function shellExec(fail: Partial<Record<Part, number>> = {}, o: { stopOut?: string; timedOut?: boolean; rejects?: number; drops?: number } = {}) {
  let rejects = o.rejects ?? 0;
  let drops = o.drops ?? 0;
  return vi.fn(async (_id: string, cmd: string, t: number, opts?: { env?: Record<string, string> }) => {
    cmds.push({ cmd, env: opts?.env, t });
    if (rejects > 0) {
      rejects -= 1;
      throw new Error("sandbox glitch");
    }
    if (drops > 0) {
      drops -= 1;
      return { stdout: "", stderr: "", exit_code: 1 };
    }
    const r = runPrepared(cmd, opts?.env, fail, o.stopOut);
    order.push(...r.ran);
    return { stdout: r.stdout, stderr: "", exit_code: r.exit_code, ...(o.timedOut ? { timed_out: true } : {}) };
  });
}

async function site(tenant: string, run: string) {
  const s = await store.getOrCreateForRun({ tenant_id: tenant, root_conductor_run_id: run, company_name: "Shop", started_by_user_id: null });
  return store.update(tenant, s.id, { github_full_name: `praxis-built/${s.label}`, supabase_url: `https://ref-${s.label}.supabase.co`, desired_sha: "seed1" });
}

function deps(over: Partial<SandboxReadyDeps> = {}): SandboxReadyDeps {
  return {
    store,
    headOf: vi.fn(async () => "head1"),
    resetRepo: vi.fn(async (_id: string, remote: string, sha: string, opts?: { before?: string }) => {
      if (opts?.before === STAMP_BAKED_DEPS_CMD) order.push("stamp");
      order.push(`reset:${remote}@${sha}`);
    }),
    readAnonKey: vi.fn(async () => ANON),
    exec: shellExec(),
    startPreview: vi.fn(async (_id, port) => { order.push("preview"); return { url: "https://5173-sbx.e2b.app", port }; }),
    recordPreview: vi.fn(async (i) => { order.push(`record:${i.status}`); return true; }),
    probeReady: vi.fn(async () => true),
    sleep: async () => {},
    schedule: (p) => { scheduled.push(p); },
    ...over,
  };
}

beforeEach(() => {
  store = fakeStore();
  order = [];
  cmds = [];
  scheduled = [];
});

describe("onSiteSandboxReady", () => {
  it("boots a reseeded restart without resetting the repo or restoring its scrubbed credential", async () => {
    const s = await site(T1, "r1");
    const d = deps();
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d, { repoAlreadyReset: true });
    await Promise.all(scheduled);
    expect(d.headOf).not.toHaveBeenCalled();
    expect(d.resetRepo).not.toHaveBeenCalled();
    expect(d.startPreview).toHaveBeenCalled();
  });

  it("resets the repo to main's HEAD before writing env and starting the preview", async () => {
    const s = await site(T1, "r1");
    const d = deps();
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    expect(order).toEqual([
      "stamp",
      `reset:https://github.com/${s.github_full_name}.git@head1`,
      "stop",
      "env",
      "picker",
      "record:starting",
      "preview",
      "record:starting",
      "record:live",
    ]);
    expect(d.startPreview).toHaveBeenCalledWith("sbx", 5173, expect.objectContaining({ repo_dir: "/home/user/repo", start_cmd: SITE_DEV_START_CMD, sanitize_secret_env: true }));
    expect(d.recordPreview).toHaveBeenLastCalledWith({ tenant_id: T1, repo_full_name: s.github_full_name, url: "https://5173-sbx.e2b.app", port: 5173, status: "live" });
  });

  it("a picker config that cannot be written never stops the preview; the boot falls back to the repo's own config", async () => {
    const s = await site(T1, "r1");
    for (const fail of [1, 2] as const) {
      order = [];
      const d = deps({ exec: shellExec({ picker: fail }) });
      await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
      await Promise.all(scheduled);
      expect(order).toContain("picker");
      expect(d.startPreview).toHaveBeenCalledTimes(1);
      expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "live" }));
    }
  });

  it("the anon key and URL go through the process env, never the command string", async () => {
    const s = await site(T1, "r1");
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, deps());
    const envCmd = cmds.find((c) => c.cmd.includes(WRITE_ENV_LOCAL_CMD))!;
    expect(envCmd.env).toEqual({ VITE_SUPABASE_URL: s.supabase_url, VITE_SUPABASE_ANON_KEY: ANON });
    for (const c of cmds) expect(c.cmd).not.toContain(ANON);
    expect(WRITE_ENV_LOCAL_CMD).toContain(".git/info/exclude");
  });

  it("a POOLED site whose row carries a supabase_url (graduation in flight) never gets the project's keys in its preview", async () => {
    const s = await site(T1, "r1");
    store.sites.get(s.id)!.backend_mode = "pooled";
    const d = deps();
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    expect(d.readAnonKey).not.toHaveBeenCalled();
    expect(cmds.some((c) => c.cmd.includes(WRITE_ENV_LOCAL_CMD) || c.env !== undefined)).toBe(false);
    const rm = order.indexOf("rm-env");
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(order.indexOf("preview"));
  });

  it("a KERNEL site (dedicated, served by its own kernel shard) never gets its project's keys either: it uses the gateway", async () => {
    const s = await site(T1, "r1");
    const row = store.sites.get(s.id)! as typeof s & { kernel_shard_id?: string | null };
    row.backend_mode = "dedicated";
    row.kernel_shard_id = "55555555-5555-4555-8555-555555555555";
    const d = deps();
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    expect(d.readAnonKey).not.toHaveBeenCalled();
    expect(cmds.some((c) => c.cmd.includes(WRITE_ENV_LOCAL_CMD) || c.env !== undefined)).toBe(false);
    expect(order).toContain("rm-env");
  });

  it("a pooled site whose stale .env.local cannot be removed: the old preview is stopped FIRST, then the run fails closed", async () => {
    const s = await site(T1, "r1");
    store.sites.get(s.id)!.backend_mode = "pooled";
    const d = deps({ exec: shellExec({ "rm-env": 1 }) });
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
    ).rejects.toBeInstanceOf(SitePublishPlatformError);
    expect(order.indexOf("stop")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("rm-env"));
    expect(order).not.toContain("picker");
    expect(d.startPreview).not.toHaveBeenCalled();
  });

  it("falls back to the site's desired_sha when HEAD cannot be read", async () => {
    const s = await site(T1, "r1");
    await onSiteSandboxReady(
      { tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" },
      deps({ headOf: async () => null }),
    );
    expect(order[1]).toContain("@seed1");
  });

  it("stamps the baked deps marker inside the reset's own exec, ahead of the reset", async () => {
    const s = await site(T1, "r1");
    const d = deps();
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    expect(d.resetRepo).toHaveBeenCalledWith("sbx", `https://github.com/${s.github_full_name}.git`, "head1", { before: STAMP_BAKED_DEPS_CMD });
    expect(cmds.some((c) => c.cmd.includes(STAMP_BAKED_DEPS_CMD))).toBe(false);
    expect(d.startPreview).toHaveBeenCalled();
  });

  it("the stamp only fires on the untouched baked tree and uses the deps step's own hash", () => {
    expect(STAMP_BAKED_DEPS_CMD).toContain("! git remote get-url origin");
    expect(STAMP_BAKED_DEPS_CMD).toContain('[ -z "$(git status --porcelain 2>/dev/null)" ]');
    expect(STAMP_BAKED_DEPS_CMD).toContain("[ ! -e node_modules/.zavi-lock ]");
    expect(STAMP_BAKED_DEPS_CMD).toContain("(sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40");
  });

  it("refuses a site of another tenant, and a sandbox repo that is not the site's (no reset)", async () => {
    const a = await site(T1, "r1");
    const b = await site(T1, "r2");
    const d = deps();
    await expect(
      onSiteSandboxReady({ tenant_id: T2, run_id: "run", site_id: a.id, repo_full_name: a.github_full_name!, e2b_sandbox_id: "sbx" }, d),
    ).rejects.toThrow(/does not belong/);
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: a.id, repo_full_name: b.github_full_name!, e2b_sandbox_id: "sbx" }, d),
    ).rejects.toThrow(/not this site's repo/);
    expect(d.resetRepo).not.toHaveBeenCalled();
  });

  it("a reset failure throws (never build on the wrong tree)", async () => {
    const s = await site(T1, "r1");
    await expect(
      onSiteSandboxReady(
        { tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" },
        deps({ resetRepo: async () => { throw new Error("origin mismatch"); } }),
      ),
    ).rejects.toThrow(/origin mismatch/);
  });

  it("a preview failure is logged, never thrown, marks the preview dead and says it failed", async () => {
    const s = await site(T1, "r1");
    const d = deps({ startPreview: async () => { throw new Error("boot timeout"); } });
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
    ).resolves.toBe("preview_failed");
    const statuses = (d.recordPreview as unknown as { mock: { calls: Array<[{ status: string }]> } }).mock.calls.map((c) => c[0].status);
    expect(statuses.at(-1)).toBe("dead");
  });

  it("a caller holding the site's lease through the boot (a wake) returns only once the preview went live", async () => {
    const s = await site(T1, "r1");
    const d = deps();
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d, {
      repoAlreadyReset: true,
      awaitReadiness: true,
    });
    expect(scheduled).toHaveLength(0);
    expect(order[order.length - 1]).toBe("record:live");
  });

  it("a preview that booted says it is starting", async () => {
    const s = await site(T1, "r1");
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, deps()),
    ).resolves.toBe("preview_starting");
  });

  it("the stop command cannot match its own shell (pkill pattern)", () => {
    expect(STOP_TEMPLATE_DEV_SERVER_CMD).toContain("pkill -f '[v]ite'");
  });
});

describe("onSiteSandboxReady — a dedicated site's env fails closed", () => {
  const ctxOf = (s: { id: string; github_full_name: string | null }) => ({
    tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx",
  });

  it("stops the running preview BEFORE writing the fresh .env.local", async () => {
    const s = await site(T1, "r1");
    await onSiteSandboxReady(ctxOf(s), deps());
    expect(order.indexOf("stop")).toBeGreaterThan(-1);
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("env"));
    expect(order.indexOf("env")).toBeLessThan(order.indexOf("preview"));
  });

  for (const [label, exec] of [
    ["the write exits non-zero", () => shellExec({ env: 1 })],
    ["the exec is rejected once, then the write exits non-zero", () => shellExec({ env: 1 }, { rejects: 1 })],
  ] as const) {
    it(`${label}: the stale file is removed, the preview is marked dead and never started, the build goes on`, async () => {
      const s = await site(T1, "r1");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const d = deps({ exec: exec() });
      await expect(onSiteSandboxReady(ctxOf(s), d)).resolves.toBe("preview_failed");
      expect(d.startPreview).not.toHaveBeenCalled();
      expect(order).toEqual(["stamp", expect.stringContaining("reset:"), "stop", "env", "rm-env", "record:dead"]);
      expect(d.recordPreview).toHaveBeenCalledWith({ tenant_id: T1, repo_full_name: s.github_full_name, url: null, port: 5173, status: "dead" });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("preview not started"))).toBe(true);
      for (const c of warn.mock.calls) expect(String(c[0])).not.toContain(ANON);
      warn.mockRestore();
    });
  }

  it("a connection that drops before the combined command runs is retried once and the preview starts", async () => {
    const s = await site(T1, "r-drop");
    const exec = shellExec({}, { drops: 1 });
    const d = deps({ exec });
    await expect(onSiteSandboxReady(ctxOf(s), d)).resolves.not.toBe("preview_failed");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(order).toContain("stop");
    expect(d.startPreview).toHaveBeenCalledTimes(1);
  });

  it("a real non-zero exit from the combined command is not re-run", async () => {
    const s = await site(T1, "r-exit");
    const exec = shellExec({ env: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await onSiteSandboxReady(ctxOf(s), deps({ exec }));
    expect(exec).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a missing or unreadable anon key is the same: no write, stale file removed, no preview", async () => {
    for (const readAnonKey of [async () => null, async () => { throw new Error("vault down"); }]) {
      order = [];
      cmds = [];
      const s = await site(T1, `r-${Math.random()}`);
      const d = deps({ readAnonKey: vi.fn(readAnonKey) });
      await onSiteSandboxReady(ctxOf(s), d);
      expect(cmds.some((c) => c.cmd.includes(WRITE_ENV_LOCAL_CMD) || c.env !== undefined)).toBe(false);
      expect(order.slice(-2)).toEqual(["rm-env", "record:dead"]);
      expect(order).not.toContain("picker");
      expect(d.startPreview).not.toHaveBeenCalled();
    }
  });

  it("a failed write whose stale file also cannot be removed (non-zero exit OR an exec rejected twice) fails the run closed", async () => {
    for (const [label, exec] of [["exit", () => shellExec({ env: 1, "rm-env": 1 })], ["rejected", () => shellExec({}, { rejects: 2 })]] as const) {
      const s = await site(T1, `r-${label}`);
      const d = deps({ exec: exec() });
      await expect(onSiteSandboxReady(ctxOf(s), d)).rejects.toBeInstanceOf(SitePublishPlatformError);
      expect(d.startPreview).not.toHaveBeenCalled();
    }
  });

  it("an old preview that cannot be stopped (non-zero exit OR an exec rejected twice) fails the run before any env is touched, in every mode", async () => {
    for (const [mode, stop] of [["dedicated", 1], ["dedicated", "throw"], ["pooled", 1]] as const) {
      order = [];
      const s = await site(T1, `r-${mode}-${stop}`);
      store.sites.get(s.id)!.backend_mode = mode;
      const d = deps({ exec: stop === "throw" ? shellExec({}, { rejects: 2 }) : shellExec({ stop }) });
      await expect(onSiteSandboxReady(ctxOf(s), d)).rejects.toBeInstanceOf(SitePublishPlatformError);
      expect(order).not.toContain("env");
      expect(order).not.toContain("rm-env");
      expect(d.startPreview).not.toHaveBeenCalled();
    }
  });

  it("the stop command proves the port is free and exits 1 when it never frees", () => {
    expect(STOP_TEMPLATE_DEV_SERVER_CMD).toContain("connect(5173,'127.0.0.1')");
    expect(STOP_TEMPLATE_DEV_SERVER_CMD).toMatch(/exit 1$/);
    expect(STOP_TEMPLATE_DEV_SERVER_CMD).not.toMatch(/; true$/);
  });

  const STUBS = `ss() { :; }; netstat() { :; }; sleep() { :; };`;
  const run = (prelude: string) => spawnSync("bash", ["-c", `set -e; ${STUBS} ${prelude} ${STOP_TEMPLATE_DEV_SERVER_CMD}`], { encoding: "utf8" });

  it("under execCommand's `set -e`, nothing left to kill is not a failure: the probe alone decides", () => {
    const r = run(`fuser() { return 1; }; pkill() { return 1; }; sudo() { return 1; }; node() { return 0; };`);
    expect(r.status).toBe(0);
    const stuck = run(`fuser() { return 1; }; pkill() { return 1; }; sudo() { return 1; }; node() { return 1; };`);
    expect(stuck.status).toBe(1);
  });

  it("a sandbox with nothing on the port is 'nothing to stop': exit 0 without killing anything", () => {
    const r = run(`fuser() { echo KILLED; }; pkill() { echo KILLED; }; sudo() { echo KILLED; }; node() { return 0; };`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__stop=nothing_running");
    expect(r.stdout).not.toContain("KILLED");
  });

  it("a dev server the sandbox user cannot signal is stopped through sudo -n", () => {
    const r = run(
      `__f=$(mktemp); fuser() { return 1; }; pkill() { return 1; };` +
        ` sudo() { [ "$1" = "-n" ] || return 1; shift; [ "$1" = "true" ] && return 0; [ "$1" = "pkill" ] && echo freed > "$__f"; return 0; };` +
        ` node() { [ -s "$__f" ]; };`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__stop=stopped_as_root");
  });

  it("a port that never frees fails with who still holds it", async () => {
    const r = spawnSync(
      "bash",
      ["-c", `set -e; sleep() { :; }; netstat() { :; }; ss() { echo 'LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=42,fd=19))'; }; fuser() { return 1; }; pkill() { return 1; }; sudo() { return 1; }; node() { return 1; }; ${STOP_TEMPLATE_DEV_SERVER_CMD}`],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('__stop_diag=LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=42,fd=19))');
    const s = await site(T1, "r-diag");
    const d = deps({ exec: shellExec({ stop: 1 }, { stopOut: r.stdout }) });
    await expect(onSiteSandboxReady(ctxOf(s), d)).rejects.toThrow(/could not be stopped \(exit 1; still listening: LISTEN .*pid=42/);
  });

  it("a port that never frees reports its holder inside the exec budget onSiteSandboxReady gives the stop", async () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `set -e; __clock=$(mktemp); netstat() { :; };` +
          ` ss() { echo 'LISTEN 0 511 *:5173 *:* users:(("node",pid=7,fd=33))'; };` +
          ` sleep() { echo "$1" >> "$__clock"; }; node() { echo 1 >> "$__clock"; return 1; };` +
          ` fuser() { return 1; }; pkill() { return 1; }; sudo() { return 0; };` +
          ` trap 'echo "__elapsed=$(awk "{s+=\\$1} END {print s}" "$__clock")"' EXIT; ${STOP_TEMPLATE_DEV_SERVER_CMD}`,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("__stop_diag=LISTEN");
    const worstCaseMs = Number(/__elapsed=([\d.]+)/.exec(r.stdout)?.[1]) * 1000;
    expect(worstCaseMs).toBeGreaterThan(15_000);

    const s = await site(T1, "r-budget");
    let budgetMs = 0;
    const d = deps({
      exec: vi.fn(async (_id: string, cmd: string, t: number) => {
        budgetMs = t;
        return t >= worstCaseMs + 40_000
          ? { stdout: r.stdout, stderr: "", exit_code: 1 }
          : { stdout: "", stderr: "timed out", exit_code: 1, timed_out: true };
      }),
    });
    await expect(onSiteSandboxReady(ctxOf(s), d)).rejects.toThrow(/still listening: LISTEN .*pid=7/);
    expect(budgetMs).toBeGreaterThanOrEqual(worstCaseMs + 40_000);
  });

  it("a stop that runs out of time says so instead of a bare exit 1", async () => {
    const s = await site(T1, "r-timeout");
    const d = deps({ exec: shellExec({ stop: 1 }, { timedOut: true }) });
    await expect(onSiteSandboxReady(ctxOf(s), d)).rejects.toThrow(/could not be stopped \(timed out after \d+ms\)/);
  });

  it("without node on PATH the probe falls back to bash /dev/tcp instead of reading 'busy'", () => {
    const cmd = buildStopDevServerCmd(1);
    const r = spawnSync("bash", ["-c", `set -e; ${STUBS} PATH=/nonexistent; fuser() { echo KILLED; }; pkill() { echo KILLED; }; ${cmd}`], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__stop=nothing_running");
  });

  it("a dedicated site with no project yet gets no .env.local (a stale one is removed) and still gets a preview", async () => {
    const s = await site(T1, "r1");
    store.sites.get(s.id)!.supabase_url = null;
    const d = deps();
    await onSiteSandboxReady(ctxOf(s), d);
    expect(d.readAnonKey).not.toHaveBeenCalled();
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("rm-env"));
    expect(order.indexOf("rm-env")).toBeLessThan(order.indexOf("preview"));
    expect(d.startPreview).toHaveBeenCalled();
  });
});

describe("onSiteSandboxReady — the preview goes live only when it really serves", () => {
  it("keeps 'starting' (with the url) while the probe says no, then publishes 'live'; the build is never blocked", async () => {
    const s = await site(T1, "r1");
    let answers = [false, false, true];
    const sleeps: number[] = [];
    const d = deps({
      probeReady: vi.fn(async () => answers.shift() ?? true),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    expect(order.filter((o) => o === "record:live")).toHaveLength(0);
    expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ url: "https://5173-sbx.e2b.app", status: "starting" }));
    await Promise.all(scheduled);
    expect(d.probeReady).toHaveBeenCalledTimes(4);
    expect(d.probeReady).toHaveBeenCalledWith("https://5173-sbx.e2b.app");
    expect(order[order.length - 1]).toBe("record:live");
    expect(sleeps).toEqual([1_000, 1_000, PREVIEW_READY_CONFIRM_GAP_MS]);
  });

  it("one pass between misses is not 'live': a server that answers once and drops (a restart) keeps 'starting'", async () => {
    const s = await site(T1, "r-flap");
    const answers = [true, false, true, false, true, true];
    const d = deps({ probeReady: vi.fn(async () => answers.shift() ?? false) });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    expect(d.probeReady).toHaveBeenCalledTimes(6);
    expect(order.filter((o) => o === "record:live")).toHaveLength(1);
    expect(order[order.length - 1]).toBe("record:live");
  });

  it("a 'live' write that fails is retried, and nothing else happens until it lands", async () => {
    const s = await site(T1, "r-live-write");
    let liveWrites = 0;
    const d = deps({
      recordPreview: vi.fn(async (i) => {
        order.push(`record:${i.status}`);
        if (i.status !== "live") return true;
        liveWrites += 1;
        if (liveWrites === 1) return false;
        if (liveWrites === 2) throw new Error("rpc down");
        return true;
      }),
    });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    expect(liveWrites).toBe(3);
    expect(order[order.length - 1]).toBe("record:live");
  });

  it("a probe that flaps forever is still a bounded wait", async () => {
    const s = await site(T1, "r-flap-forever");
    let n = 0;
    const d = deps({ probeReady: vi.fn(async () => n++ % 2 === 0) });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    expect(order).not.toContain("record:live");
    expect((d.probeReady as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(2 * 23);
  });

  it("never publishes 'live' for a preview that never serves (bounded wait)", async () => {
    const s = await site(T1, "r1");
    const d = deps({ probeReady: vi.fn(async () => false) });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    expect(order).not.toContain("record:live");
    expect((d.probeReady as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(23);
    expect(d.startPreview).toHaveBeenCalledTimes(1);
  });
});

describe("onSiteSandboxReady — dependencies are installed while no dev server runs", () => {
  it("installs after the running preview is stopped and before the new one boots", async () => {
    const s = await site(T1, "r1");
    const d = deps({ installDeps: vi.fn(async () => { order.push("install"); return { ok: true, reason: "ok", stale: true }; }) });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("install"));
    expect(order.indexOf("install")).toBeLessThan(order.indexOf("preview"));
    expect(d.installDeps).toHaveBeenCalledWith({ tenant_id: T1, site_id: s.id, sandbox_id: "sbx" });
  });

  it("a reinstall writes the preview config again after the install and before the boot", async () => {
    const s = await site(T1, "r-cfg");
    const d = deps({ installDeps: vi.fn(async () => { order.push("install"); return { ok: true, reason: "ok", stale: true }; }) });
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d);
    await Promise.all(scheduled);
    const pickers = order.map((o, i) => (o === "picker" ? i : -1)).filter((i) => i >= 0);
    expect(pickers).toHaveLength(2);
    expect(pickers[1]).toBeGreaterThan(order.indexOf("install"));
    expect(pickers[1]).toBeLessThan(order.indexOf("preview"));
    const rewrite = cmds.find((c) => c.cmd === writeSitePreviewConfigCmd());
    expect(rewrite?.t).toBe(PREVIEW_CONFIG_WRITE_TIMEOUT_MS);
  });

  it("every install outcome that boots rewrites the config (a no-op install, an unknown one)", async () => {
    for (const installDeps of [
      vi.fn(async () => { order.push("install"); return { ok: true, reason: "ok" }; }),
      vi.fn(async () => { order.push("install"); throw new Error("exec down"); }),
    ]) {
      order = [];
      const s = await site(T1, `r-cfg-${order.length}-${Math.random()}`);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const d = deps({ installDeps });
      await expect(
        onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
      ).resolves.toBe("preview_starting");
      warn.mockRestore();
      expect(order.filter((o) => o === "picker")).toHaveLength(2);
      expect(order.lastIndexOf("picker")).toBeLessThan(order.indexOf("preview"));
    }
  });

  it("a config that cannot be rewritten fails the preview closed: never a bare dev server", async () => {
    const s = await site(T1, "r-cfg-fail");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = shellExec();
    const exec = vi.fn(async (id: string, cmd: string, t: number, opts?: { env?: Record<string, string> }) =>
      cmd === writeSitePreviewConfigCmd() ? { stdout: "", stderr: "", exit_code: 1 } : base(id, cmd, t, opts),
    );
    const d = deps({ exec, installDeps: vi.fn(async () => ({ ok: true, reason: "ok", stale: true })) });
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
    ).resolves.toBe("preview_failed");
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(order[order.length - 1]).toBe("record:dead");
    warn.mockRestore();
  });

  it("an install that left no dependencies never boots a dev server; the preview is marked dead at once", async () => {
    const s = await site(T1, "r1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const reason of ["nomodules", "notnpm", "nolock", "norepo"]) {
      order = [];
      const d = deps({ installDeps: vi.fn(async () => ({ ok: false, reason })) });
      await expect(
        onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
      ).resolves.toBe("preview_failed");
      expect(d.startPreview, reason).not.toHaveBeenCalled();
      expect(order[order.length - 1]).toBe("record:dead");
    }
    warn.mockRestore();
  });

  it("any other install failure (or a throwing install) still boots; the readiness wait decides what is shown", async () => {
    const s = await site(T1, "r1");
    for (const installDeps of [vi.fn(async () => ({ ok: false, reason: "unknown" })), vi.fn(async () => { throw new Error("exec down"); })]) {
      order = [];
      scheduled = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const d = deps({ installDeps });
      await expect(
        onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
      ).resolves.toBe("preview_starting");
      await Promise.all(scheduled);
      warn.mockRestore();
      expect(d.startPreview).toHaveBeenCalledTimes(1);
    }
  });
});

describe("stopping the template's dev server without procps / psmisc / iproute2", () => {
  function fakeProc(holderPid: number, opts: { state?: string; port?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "zproc-"));
    mkdirSync(join(root, "net"));
    const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    writeFileSync(
      join(root, "net", "tcp6"),
      `${head}   0: 00000000000000000000000000000000:${opts.port ?? "1435"} 00000000000000000000000000000000:0000 ${opts.state ?? "0A"} 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0\n`,
    );
    writeFileSync(join(root, "net", "tcp"), head);
    mkdirSync(join(root, String(holderPid), "fd"), { recursive: true });
    symlinkSync("socket:[4242]", join(root, String(holderPid), "fd", "19"));
    symlinkSync("/dev/null", join(root, String(holderPid), "fd", "0"));
    writeFileSync(join(root, String(holderPid), "comm"), "node\n");
    mkdirSync(join(root, "1", "fd"), { recursive: true });
    symlinkSync("socket:[999]", join(root, "1", "fd", "3"));
    return root;
  }
  const holder = (args: string[]) => spawnSync(process.execPath, ["-", ...args], { input: PORT_HOLDER_SCRIPT, encoding: "utf8" });

  it("report names the holder and the listener's uid", () => {
    const child = spawn("sleep", ["30"]);
    try {
      const r = holder(["5173", "report", fakeProc(child.pid!)]);
      expect(r.stdout.trim()).toBe(`listeners=1 uid=1000 holders=node(${child.pid})`);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("kill SIGKILLs exactly the pid holding the LISTEN socket", async () => {
    const child = spawn("sleep", ["30"]);
    const exited = new Promise<NodeJS.Signals | null>((res) => child.on("exit", (_c, sig) => res(sig)));
    const r = holder(["5173", "kill", fakeProc(child.pid!)]);
    expect(r.stdout.trim()).toBe(`killed=${child.pid}`);
    expect(await exited).toBe("SIGKILL");
  });

  it("a non-LISTEN socket or another port is not a holder", () => {
    const child = spawn("sleep", ["30"]);
    try {
      expect(holder(["5173", "kill", fakeProc(child.pid!, { state: "01" })]).stdout.trim()).toBe("killed=");
      expect(holder(["5173", "kill", fakeProc(child.pid!, { port: "1436" })]).stdout.trim()).toBe("killed=");
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("the command ships exactly this script (base64, so no shell quoting can bend it) and runs it as the user, then via sudo -n", () => {
    const b64 = Buffer.from(PORT_HOLDER_SCRIPT, "utf8").toString("base64");
    expect(STOP_TEMPLATE_DEV_SERVER_CMD).toContain(`printf %s '${b64}' | base64 -d | "$(command -v node)" - 5173 kill`);
    expect(STOP_TEMPLATE_DEV_SERVER_CMD).toContain(`printf %s '${b64}' | base64 -d | sudo -n "$(command -v node)" - 5173 kill`);
  });

  it("with fuser / pkill / ss all absent, the node kill alone frees the port", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `set -e; sleep() { :; }; __f=$(mktemp); ` +
          `node() { if [ "$1" = "-" ]; then grep -q "SIGKILL" && [ "$3" = "kill" ] && echo freed > "$__f"; return 0; fi; [ -s "$__f" ]; }; ` +
          `PATH=/usr/bin:/bin; command -v fuser >/dev/null && fuser() { return 127; }; command -v pkill >/dev/null && pkill() { return 127; }; ` +
          STOP_TEMPLATE_DEV_SERVER_CMD,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__stop=stopped");
  });

  it("a stop that runs out of its exec budget says so (not a bare exit 1)", async () => {
    const s = await site(T1, "r-timeout");
    const d = deps({ exec: shellExec({ stop: 1 }, { timedOut: true }) });
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d),
    ).rejects.toThrow(new RegExp(`could not be stopped \\(timed out after ${PREPARE_SITE_TREE_TIMEOUT_MS}ms\\)`));
    expect(cmds.find((c) => c.cmd.includes(STOP_TEMPLATE_DEV_SERVER_CMD))?.t).toBe(PREPARE_SITE_TREE_TIMEOUT_MS);
    expect(PREPARE_SITE_TREE_TIMEOUT_MS).toBeGreaterThanOrEqual(STOP_DEV_SERVER_TIMEOUT_MS + 40_000);
  });
});

describe("onSiteSandboxReady — one sandbox round trip after the reset", () => {
  const ctxOf = (s: { id: string; github_full_name: string | null }) => ({
    tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx",
  });

  it("stop, env and the picker config ride ONE exec in every mode, and the stamp rides the reset", async () => {
    for (const mode of ["dedicated", "dedicated-no-project", "pooled", "anon-missing"] as const) {
      order = [];
      cmds = [];
      const s = await site(T1, `one-${mode}`);
      if (mode === "pooled") store.sites.get(s.id)!.backend_mode = "pooled";
      if (mode === "dedicated-no-project") store.sites.get(s.id)!.supabase_url = null;
      const d = deps(mode === "anon-missing" ? { readAnonKey: vi.fn(async () => null) } : {});
      await onSiteSandboxReady(ctxOf(s), d);
      expect(d.exec, mode).toHaveBeenCalledTimes(1);
      expect(d.resetRepo, mode).toHaveBeenCalledTimes(1);
      expect(order.indexOf("stop"), mode).toBeGreaterThan(order.findIndex((o) => o.startsWith("reset:")));
    }
  });

  it("a reseeded restart (no reset) is a single exec too", async () => {
    const s = await site(T1, "one-restart");
    const d = deps();
    await onSiteSandboxReady(ctxOf(s), d, { repoAlreadyReset: true });
    expect(d.exec).toHaveBeenCalledTimes(1);
    expect(d.resetRepo).not.toHaveBeenCalled();
  });

  it("reads the repo HEAD while the site row read is still in flight", async () => {
    const s = await site(T1, "par-head");
    let releaseGet!: () => void;
    const gate = new Promise<void>((r) => { releaseGet = r; });
    const realGet = store.get.bind(store);
    const headOf = vi.fn(async () => "head1");
    const d = deps({ headOf, store: { ...store, get: async (t: string, id: string) => { await gate; return realGet(t, id); } } as typeof store });
    const run = onSiteSandboxReady(ctxOf(s), d);
    await new Promise((r) => setTimeout(r, 5));
    expect(headOf).toHaveBeenCalledTimes(1);
    releaseGet();
    await run;
    expect(d.resetRepo).toHaveBeenCalledWith("sbx", expect.any(String), "head1", { before: STAMP_BAKED_DEPS_CMD });
  });

  it("a site of another tenant is refused even though its HEAD read already started, and nothing touches the sandbox", async () => {
    const s = await site(T1, "par-foreign");
    const d = deps();
    await expect(onSiteSandboxReady({ ...ctxOf(s), tenant_id: T2 }, d)).rejects.toThrow(/does not belong/);
    expect(d.resetRepo).not.toHaveBeenCalled();
    expect(d.exec).not.toHaveBeenCalled();
    expect(d.readAnonKey).not.toHaveBeenCalled();
  });

  it("reads the dedicated project's anon key while the repo reset runs", async () => {
    const s = await site(T1, "par-anon");
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((r) => { releaseReset = r; });
    const readAnonKey = vi.fn(async () => ANON);
    const d = deps({ readAnonKey, resetRepo: vi.fn(async () => { await resetGate; }) });
    const run = onSiteSandboxReady(ctxOf(s), d);
    await new Promise((r) => setTimeout(r, 5));
    expect(d.resetRepo).toHaveBeenCalledTimes(1);
    expect(readAnonKey).toHaveBeenCalledTimes(1);
    releaseReset();
    await expect(run).resolves.toBe("preview_starting");
  });

  it("the first 'starting' write overlaps the boot, but always lands before the write that carries the url", async () => {
    const s = await site(T1, "par-record");
    const landed: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let calls = 0;
    const recordPreview = vi.fn(async (i: { url: string | null; status: string }) => {
      calls += 1;
      if (calls === 1) await firstGate;
      landed.push(`${i.status}:${i.url ?? "-"}`);
      return true;
    });
    const startPreview = vi.fn(async (_id: string, port: number) => {
      setTimeout(releaseFirst, 5);
      return { url: "https://5173-sbx.e2b.app", port };
    });
    const d = deps({ recordPreview, startPreview, probeReady: vi.fn(async () => false), schedule: () => {} });
    await expect(onSiteSandboxReady(ctxOf(s), d)).resolves.toBe("preview_starting");
    expect(startPreview).toHaveBeenCalledTimes(1);
    expect(landed).toEqual(["starting:-", "starting:https://5173-sbx.e2b.app"]);
  });

  it("a boot that fails while the first 'starting' write is still in flight marks the preview dead only after it lands", async () => {
    const s = await site(T1, "par-dead");
    const landed: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let calls = 0;
    const recordPreview = vi.fn(async (i: { status: string }) => {
      calls += 1;
      if (calls === 1) await firstGate;
      landed.push(i.status);
      return true;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const d = deps({
        recordPreview,
        startPreview: vi.fn(async () => { setTimeout(releaseFirst, 10); throw new Error("boot timeout"); }),
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(onSiteSandboxReady(ctxOf(s), d)).resolves.toBe("preview_failed");
      warn.mockRestore();
      await new Promise((r) => setTimeout(r, 20));
      expect(landed).toEqual(["starting", "dead"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("buildPrepareSiteTreeCmd — the real stop, env and picker commands in one shell", () => {
  function tree() {
    const dir = mkdtempSync(join(tmpdir(), "zsite-"));
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    return dir;
  }
  const at = (dir: string, cmd: string) => cmd.split("/home/user/repo").join(dir);
  const parts = (dir: string) => ({
    stop: buildStopDevServerCmd(1),
    remove: at(dir, REMOVE_ENV_LOCAL_CMD),
    write: at(dir, WRITE_ENV_LOCAL_CMD),
    config: at(dir, writeSitePreviewConfigCmd("export default {};\n")),
  });
  const sh = (cmd: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", `(set -e; ${cmd}\n)`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  const ENV = { VITE_SUPABASE_URL: "https://ref.supabase.co", VITE_SUPABASE_ANON_KEY: ANON };

  it("write mode: stops, writes .env.local from the process env, git-excludes it, then writes the picker config", () => {
    const dir = tree();
    writeFileSync(join(dir, ".env.production.local"), "STALE=1\n");
    const r = sh(buildPrepareSiteTreeCmd("write", parts(dir)), ENV);
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("__step="))).toEqual(["__step=stopped", "__step=env_written", "__step=config_written"]);
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(`VITE_SUPABASE_URL=${ENV.VITE_SUPABASE_URL}\nVITE_SUPABASE_ANON_KEY=${ANON}\n`);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".env.local");
    expect(readFileSync(join(dir, "node_modules", ".zavi", "preview.vite.config.mjs"), "utf8")).toBe("export default {};\n");
    expect(buildPrepareSiteTreeCmd("write", parts(dir))).not.toContain(ANON);
  });

  it("a write that half-ran (file written, exclude failed) removes the stale file and writes no picker config", () => {
    const dir = tree();
    rmSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info"), "not a dir");
    const r = sh(buildPrepareSiteTreeCmd("write", parts(dir)), ENV);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__step=env_write_failed");
    expect(r.stdout).toContain("__step=env_removed");
    expect(r.stdout).not.toContain("__step=config");
    expect(existsSync(join(dir, ".env.local"))).toBe(false);
    expect(existsSync(join(dir, "node_modules", ".zavi"))).toBe(false);
  });

  it("a write that fails AND a stale file that cannot be removed exits 1 with nothing past it", () => {
    const dir = tree();
    mkdirSync(join(dir, ".env.local"));
    const r = sh(buildPrepareSiteTreeCmd("write", parts(dir)), ENV);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("__step=env_remove_failed");
    expect(r.stdout).not.toContain("__step=config");
  });

  it("remove mode under set -e: a stale .env.local is removed and the picker still written; a failed picker never fails the exec", () => {
    const dir = tree();
    writeFileSync(join(dir, ".env.local"), "VITE_SUPABASE_ANON_KEY=old\n");
    const r = sh(buildPrepareSiteTreeCmd("remove", { ...parts(dir), config: "false" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__step=env_removed");
    expect(r.stdout).toContain("__step=config_failed");
    expect(existsSync(join(dir, ".env.local"))).toBe(false);
  });

  it("a stop that cannot free the port exits 1 before the env is touched, keeping the stop's diagnostic", () => {
    const dir = tree();
    writeFileSync(join(dir, ".env.local"), "OLD=1\n");
    const r = sh(buildPrepareSiteTreeCmd("remove", { ...parts(dir), stop: "echo __stop_diag=holder; exit 1" }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("__stop_diag=holder");
    expect(r.stdout).toContain("__step=stop_failed");
    expect(r.stdout).not.toContain("__step=env");
    expect(existsSync(join(dir, ".env.local"))).toBe(true);
  });

  it("remove_after_unwritable never writes the picker config (no preview will start)", () => {
    const dir = tree();
    const r = sh(buildPrepareSiteTreeCmd("remove_after_unwritable", parts(dir)));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__step=env_removed");
    expect(existsSync(join(dir, "node_modules", ".zavi"))).toBe(false);
  });
});

describe("onSiteSandboxReady — first draft retired", () => {
  const firstBuild = (site_id: string) => ({
    stage: "build",
    fast_single_pass: true,
    site_id,
    target: { github_full_name: "praxis-built/x" },
    company_name: "Crumb & Co",
    idea: "an online order form for my bakery's custom cakes",
  });

  function homeFile(text: string | null): string {
    const at = join(mkdtempSync(join(tmpdir(), "zdraft-home-")), "Home.tsx");
    if (text !== null) writeFileSync(at, text);
    return at;
  }
  const PLACEHOLDER = zaviStarterProvider.starterFiles().files["src/pages/Home.tsx"]!;

  function draftDeps(dir: string, home: string = homeFile(PLACEHOLDER)) {
    const inner = shellExec();
    const marks: string[] = [];
    const d = deps({
      exec: vi.fn(async (id: string, cmd: string, t: number, opts?: { env?: Record<string, string> }) =>
        inner(id, cmd.split(FIRST_DRAFT_DIR).join(dir).split(FIRST_DRAFT_HOME_ABS).join(home), t, opts),
      ),
      markFirstView: vi.fn(async (i: { mark: string }) => {
        marks.push(i.mark);
      }),
    });
    return { d, marks };
  }

  it("a first build writes no draft over the placeholder, clears one left behind, and stamps only the preview", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "zdraft-ready-")), "d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "first-draft.json"), "{}");
    const s = await site(T1, "r1");
    const { d, marks } = draftDeps(dir);
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d, { payload: firstBuild(s.id) });
    await Promise.all(scheduled);
    expect(existsSync(join(dir, "first-draft.json"))).toBe(false);
    expect(marks).toEqual(["preview"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("nothing is stamped while the preview does not serve; a home page written meanwhile is stamped when it does", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "zdraft-ready-")), "d");
    const s = await site(T1, "r1");
    const { d, marks } = draftDeps(dir);
    let probes = 0;
    const homeChanged = vi.fn(async () => true);
    const d2 = { ...d, probeReady: vi.fn(async () => ++probes > 3), homeChanged };
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d2, { payload: firstBuild(s.id) });
    expect(marks).toEqual([]);
    await Promise.all(scheduled);
    expect(marks).toEqual(["preview", "content"]);
    expect(homeChanged).toHaveBeenCalledWith("sbx");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a refine never stamps content (only the first build measures it)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "zdraft-ready-")), "d");
    const s = await site(T1, "r1");
    const { d, marks } = draftDeps(dir);
    const homeChanged = vi.fn(async () => true);
    await onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, { ...d, homeChanged }, { payload: { ...firstBuild(s.id), refine_mode: true } });
    await Promise.all(scheduled);
    expect(marks).toEqual(["preview"]);
    expect(homeChanged).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a draft that cannot be written never stops the preview, and is not stamped", async () => {
    const s = await site(T1, "r1");
    const { d, marks } = draftDeps("/dev/null/nope");
    await expect(
      onSiteSandboxReady({ tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx" }, d, { payload: firstBuild(s.id) }),
    ).resolves.toBe("preview_starting");
    await Promise.all(scheduled);
    expect(marks).toEqual(["preview"]);
  });

  it("the draft step runs after the stop and the env, and its failure cannot fail the step", () => {
    const cmd = buildPrepareSiteTreeCmd("remove", undefined, "exit 7");
    expect(cmd.indexOf("exit 7")).toBeGreaterThan(cmd.indexOf("__step=stopped"));
    const r = spawnSync("bash", ["-c", buildPrepareSiteTreeCmd("remove", { stop: "true", remove: "true", write: "true", config: "true" }, "exit 7")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("__step=env_removed");
  });
});

describe("onSiteSandboxReady — Vite never boots on node_modules installed from another lockfile", () => {
  const BAKED_LOCK = '{"packages":{"node_modules/react":{}}}';
  const SITE_LOCK = '{"packages":{"node_modules/react":{},"node_modules/lucide-react":{},"node_modules/clsx":{}}}';
  const sha1 = (text: string) => createHash("sha1").update(text, "utf8").digest("hex");

  function bakedTree() {
    const dir = mkdtempSync(join(tmpdir(), "zdeps-"));
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".zavi-lock"), `${sha1(BAKED_LOCK)}\n`);
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0","clsx":"2.1.1"}}');
    writeFileSync(join(dir, "package-lock.json"), SITE_LOCK);
    return dir;
  }

  function stubNpm(exitCode = 0) {
    const bin = mkdtempSync(join(tmpdir(), "zdeps-bin-"));
    const log = join(bin, "calls.log");
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\necho "$@" >> '${log}'\nmkdir -p node_modules/react node_modules/lucide-react node_modules/clsx\nexit ${exitCode}\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    return { bin, calls };
  }

  function sandboxAt(dir: string, bin: string) {
    return vi.fn(async (_id: string, cmd: string, _t: number) => {
      const local = cmd.split(STOP_TEMPLATE_DEV_SERVER_CMD).join("true").split("/home/user/repo").join(dir);
      const r = spawnSync("bash", ["-c", `(set -e; ${local}\n)`], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
      return { stdout: r.stdout, stderr: r.stderr, exit_code: r.status ?? 1 };
    });
  }

  function realInstall(exec: ReturnType<typeof sandboxAt>) {
    return vi.fn((input: { sandbox_id: string }) => installSiteDeps(input.sandbox_id, exec));
  }

  const installRuns = (exec: ReturnType<typeof sandboxAt>) => exec.mock.calls.filter((c) => c[1] === SYNC_SITE_DEPS_CMD).length;

  const ctxOf = (s: { id: string; github_full_name: string | null }) => ({
    tenant_id: T1, run_id: "run", site_id: s.id, repo_full_name: s.github_full_name!, e2b_sandbox_id: "sbx",
  });

  for (const [label, opts] of [
    ["a build that resets the baked tree to the site repo", {}],
    ["a recreated sandbox restarted on an already-reset tree", { repoAlreadyReset: true }],
  ] as const) {
    it(`${label}: the site lock's packages are installed once, stamped, before the dev server starts`, async () => {
      const dir = bakedTree();
      const npm = stubNpm();
      const s = await site(T1, `deps-${label.length}`);
      store.sites.get(s.id)!.backend_mode = "pooled";
      const atBoot: Array<{ lucide: boolean; clsx: boolean; stamp: string; picker: boolean }> = [];
      const exec = sandboxAt(dir, npm.bin);
      const d = deps({
        exec,
        installDeps: realInstall(exec),
        startPreview: vi.fn(async (_id: string, port: number) => {
          atBoot.push({
            lucide: existsSync(join(dir, "node_modules", "lucide-react")),
            clsx: existsSync(join(dir, "node_modules", "clsx")),
            stamp: readFileSync(join(dir, "node_modules", ".zavi-lock"), "utf8").trim(),
            picker: existsSync(join(dir, "node_modules", ".zavi", "preview.vite.config.mjs")),
          });
          return { url: "https://5173-sbx.e2b.app", port };
        }),
      });
      await expect(onSiteSandboxReady(ctxOf(s), d, opts)).resolves.toBe("preview_starting");
      expect(atBoot).toEqual([{ lucide: true, clsx: true, stamp: sha1(SITE_LOCK), picker: true }]);
      expect(npm.calls()).toHaveLength(1);
      expect(npm.calls()[0]).toMatch(/^ci\b/);
      expect(installRuns(exec)).toBe(1);
      expect(exec.mock.calls.filter((c) => /npm (ci|install)/.test(c[1]))).toHaveLength(1);
      expect(exec.mock.calls.find((c) => c[1] === SYNC_SITE_DEPS_CMD)![2]).toBe(SITE_DEPS_SYNC_TIMEOUT_MS);

      await onSiteSandboxReady(ctxOf(s), d, { repoAlreadyReset: true });
      expect(npm.calls()).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it("the tree step never installs: the one install runs after it stopped the old dev server", () => {
    for (const env of ["remove", "write", "remove_after_unwritable"] as const) {
      expect(buildPrepareSiteTreeCmd(env)).not.toMatch(/npm (ci|install)/);
    }
  });

  for (const [label, setup] of [
    ["npm ci fails", (dir: string) => dir],
    ["the site also has a yarn lock", (dir: string) => { writeFileSync(join(dir, "yarn.lock"), ""); return dir; }],
    ["the repo is missing", (dir: string) => join(dir, "missing")],
  ] as const) {
    it(`a failed install (${label}) keeps the preview offline and never boots Vite`, async () => {
      const dir = bakedTree();
      const npm = stubNpm(1);
      const s = await site(T1, `deps-fail-${label.length}`);
      store.sites.get(s.id)!.backend_mode = "pooled";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const treeExec = sandboxAt(dir, npm.bin);
      const installExec = sandboxAt(setup(dir), npm.bin);
      const d = deps({ exec: treeExec, installDeps: realInstall(installExec) });
      await expect(onSiteSandboxReady(ctxOf(s), d)).resolves.toBe("preview_failed");
      expect(d.startPreview).not.toHaveBeenCalled();
      expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "dead", url: null }));
      if (label === "npm ci fails") expect(existsSync(join(dir, "node_modules"))).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("dependencies not installed"))).toBe(true);
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it("the install's exec budget covers its own npm timeout", () => {
    const installS = Number(/timeout (\d+) npm ci/.exec(buildSyncSiteDepsCmd())![1]);
    expect(SITE_DEPS_SYNC_TIMEOUT_MS).toBeGreaterThan(installS * 1000);
  });
});
