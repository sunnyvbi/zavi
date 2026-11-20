import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rpc = vi.fn(async () => ({ error: null }));
let row: Record<string, unknown> | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
    }),
    rpc,
  }),
}));

const execCommand = vi.fn();
vi.mock("@/services/sandbox/e2b-client", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/e2b-client")>()),
  execCommand: (...a: unknown[]) => execCommand(...a),
  getSandboxHost: async (_id: string, port: number) => `https://${port}-sb-1.e2b.app`,
}));

const startPreviewServer = vi.fn();
vi.mock("@/services/sandbox/preview", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/preview")>()),
  startPreviewServer: (...a: unknown[]) => startPreviewServer(...a),
}));

import { __resetPreviewConfigRefreshes, kickPreviewReadiness, kickSandboxPreview } from "@/services/agents/conductor-driver";

kickPreviewReadiness.probeReady = async () => true;
kickPreviewReadiness.sleep = async () => {};
import type { ConductorNode } from "@/services/agents/conductor";
import { SITE_DEPS_STALE_CMD, SITE_DEPS_SYNC_TIMEOUT_MS, STOP_DEV_SERVER_TIMEOUT_MS, STOP_TEMPLATE_DEV_SERVER_CMD, SYNC_SITE_DEPS_CMD } from "@/services/sites/sandbox-ready";
import { refreshSitePreviewConfigCmd, writeSitePreviewConfigCmd } from "@/services/sites/preview-picker";
import { PREVIEW_BOOT_TIMEOUT_DEFAULT_S, PREVIEW_EXEC_HEADROOM_S } from "@/services/sandbox/preview";
import { PREVIEW_READINESS_BUDGET_S, SITE_LEASE_TTL_S } from "@/services/sites/site-preview-lease";
import { PREVIEW_READY_CONFIRM_GAP_MS, PREVIEW_READY_DELAYS_MS, PREVIEW_READY_STREAK } from "@/services/sites/sandbox-ready";
import { SANDBOX_PROBE_TIMEOUT_MS } from "@/services/sandbox/preview-ready-probe";

const node = { payload: { target: { github_full_name: "Zavi-Latest-Build/brightsmile" } } } as unknown as ConductorNode;
const OLD_LOCK = '{"packages":{"node_modules/react":{}}}';
const SITE_LOCK = '{"packages":{"node_modules/react":{},"node_modules/lucide-react":{},"node_modules/clsx":{}}}';
const sha1 = (t: string) => createHash("sha1").update(t, "utf8").digest("hex");

let dir: string;
let bin: string;
let npmLog: string;
let atBoot: Array<{ lucide: boolean; clsx: boolean }>;
let config: "unchanged" | "rewritten";
let stopExit: number;

function npmCalls(): string[] {
  return existsSync(npmLog) ? readFileSync(npmLog, "utf8").split("\n").filter(Boolean) : [];
}

function staleTree(stamp: string | null) {
  mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
  if (stamp !== null) writeFileSync(join(dir, "node_modules", ".zavi-lock"), `${stamp}\n`);
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0","clsx":"2.1.1"}}');
  writeFileSync(join(dir, "package-lock.json"), SITE_LOCK);
}

function runInTree(cmd: string) {
  const local = cmd.split("/home/user/repo").join(dir);
  const r = spawnSync("bash", ["-c", `(set -e; ${local}\n)`], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return { stdout: r.stdout, stderr: r.stderr, exit_code: r.status ?? 1 };
}

beforeEach(() => {
  __resetPreviewConfigRefreshes();
  rpc.mockClear();
  dir = mkdtempSync(join(tmpdir(), "zkick-"));
  bin = mkdtempSync(join(tmpdir(), "zkick-bin-"));
  npmLog = join(bin, "calls.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$@" >> '${npmLog}'\nmkdir -p node_modules/react node_modules/lucide-react node_modules/clsx\nexit $(cat '${join(bin, "exit")}' 2>/dev/null || echo 0)\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
  atBoot = [];
  config = "unchanged";
  stopExit = 0;
  execCommand.mockReset().mockImplementation(async (_id: string, cmd: string) => {
    if (cmd.startsWith("curl ")) return { stdout: "200", stderr: "", exit_code: 0 };
    if (cmd === refreshSitePreviewConfigCmd()) return { stdout: `__config=${config}\n`, stderr: "", exit_code: 0 };
    if (cmd === STOP_TEMPLATE_DEV_SERVER_CMD) return { stdout: "__stop=stopped\n", stderr: "", exit_code: stopExit };
    if (cmd === SITE_DEPS_STALE_CMD || cmd === SYNC_SITE_DEPS_CMD) return runInTree(cmd);
    return { stdout: "", stderr: "", exit_code: 0 };
  });
  startPreviewServer.mockReset().mockImplementation(async (_id: string, port: number) => {
    atBoot.push({
      lucide: existsSync(join(dir, "node_modules", "lucide-react")),
      clsx: existsSync(join(dir, "node_modules", "clsx")),
    });
    return { url: `https://${port}-sb-1.e2b.app`, port };
  });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.mocked(console.info).mockRestore();
  vi.mocked(console.warn).mockRestore();
  rmSync(dir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const cmds = () => execCommand.mock.calls.map((c) => c[1] as string);

describe("kickSandboxPreview never (re)starts a site's Vite on node_modules from another lockfile", () => {
  it("a mid-build config drift on packages from another lockfile defers the restart: nothing is stopped, wiped or booted", async () => {
    staleTree(sha1(OLD_LOCK));
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    config = "rewritten";
    await kickSandboxPreview({ tenant_id: "t1", node, site: true, onlyIfAnswering: true });
    expect(cmds()).toContain(SITE_DEPS_STALE_CMD);
    expect(cmds()).not.toContain(refreshSitePreviewConfigCmd());
    expect(cmds()).not.toContain(STOP_TEMPLATE_DEV_SERVER_CMD);
    expect(cmds()).not.toContain(SYNC_SITE_DEPS_CMD);
    expect(startPreviewServer).not.toHaveBeenCalled();
    expect(npmCalls()).toHaveLength(0);
    expect(readFileSync(join(dir, "node_modules", ".zavi-lock"), "utf8").trim()).toBe(sha1(OLD_LOCK));
  });

  it("a mid-build config drift on the lockfile's own packages restarts without running the install", async () => {
    staleTree(sha1(SITE_LOCK));
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    config = "rewritten";
    await kickSandboxPreview({ tenant_id: "t1", node, site: true, onlyIfAnswering: true });
    expect(startPreviewServer).toHaveBeenCalledTimes(1);
    expect(cmds()).not.toContain(SYNC_SITE_DEPS_CMD);
    expect(npmCalls()).toHaveLength(0);
  });

  it("a wake on a still-answering server with stale packages stops it, installs, writes the picker config, and boots once", async () => {
    staleTree(null);
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    await kickSandboxPreview({ tenant_id: "t1", node, site: true });
    expect(startPreviewServer).toHaveBeenCalledTimes(1);
    expect(atBoot).toEqual([{ lucide: true, clsx: true }]);
    expect(cmds().filter((c) => c === STOP_TEMPLATE_DEV_SERVER_CMD)).toHaveLength(1);
    expect(cmds().filter((c) => c === SYNC_SITE_DEPS_CMD)).toHaveLength(1);
    expect(execCommand.mock.calls.find((c) => c[1] === SYNC_SITE_DEPS_CMD)![2]).toBe(SITE_DEPS_SYNC_TIMEOUT_MS);
    expect(cmds().indexOf(writeSitePreviewConfigCmd())).toBeGreaterThan(cmds().indexOf(SYNC_SITE_DEPS_CMD));
    expect(npmCalls()).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" }));
  });

  it("a server that will not stop is left alone: no install under a live Vite, no second server", async () => {
    staleTree(sha1(OLD_LOCK));
    stopExit = 1;
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(cmds()).toContain(STOP_TEMPLATE_DEV_SERVER_CMD));
    await new Promise((r) => setTimeout(r, 20));
    expect(startPreviewServer).not.toHaveBeenCalled();
    expect(npmCalls()).toHaveLength(0);
    expect(existsSync(join(dir, "node_modules", "react"))).toBe(true);
  });

  it("a wake whose packages already match the lock does not restart the running server", async () => {
    staleTree(sha1(SITE_LOCK));
    mkdirSync(join(dir, "node_modules", "lucide-react"), { recursive: true });
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(cmds()).toContain(SITE_DEPS_STALE_CMD));
    await new Promise((r) => setTimeout(r, 20));
    expect(cmds()).not.toContain(STOP_TEMPLATE_DEV_SERVER_CMD);
    expect(startPreviewServer).not.toHaveBeenCalled();
    expect(npmCalls()).toHaveLength(0);
  });

  it("a mid-build config check never stops a running server for its packages", async () => {
    staleTree(sha1(OLD_LOCK));
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "live", preview_port: 5173 };
    kickSandboxPreview({ tenant_id: "t1", node, site: true, onlyIfAnswering: true });
    await vi.waitFor(() => expect(cmds()).toContain(SITE_DEPS_STALE_CMD));
    await new Promise((r) => setTimeout(r, 20));
    expect(cmds()).not.toContain(STOP_TEMPLATE_DEV_SERVER_CMD);
    expect(cmds()).not.toContain(SYNC_SITE_DEPS_CMD);
    expect(startPreviewServer).not.toHaveBeenCalled();
    expect(npmCalls()).toHaveLength(0);
  });

  it("a cold boot (nothing answering) installs before Vite starts", async () => {
    staleTree(sha1(OLD_LOCK));
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) => {
      if (cmd.startsWith("curl ")) return { stdout: "000", stderr: "", exit_code: 7 };
      if (cmd === SITE_DEPS_STALE_CMD || cmd === SYNC_SITE_DEPS_CMD) return runInTree(cmd);
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    kickSandboxPreview({ tenant_id: "t1", node, site: true });
    await vi.waitFor(() => expect(startPreviewServer).toHaveBeenCalledTimes(1));
    expect(atBoot).toEqual([{ lucide: true, clsx: true }]);
    expect(npmCalls()).toHaveLength(1);
  });

  for (const [label, setup] of [
    ["npm ci fails", () => { staleTree(sha1(OLD_LOCK)); writeFileSync(join(bin, "exit"), "1"); }],
    ["the site also has a yarn lock", () => { staleTree(sha1(OLD_LOCK)); writeFileSync(join(dir, "yarn.lock"), ""); }],
    ["the site has no lockfile and no packages", () => { writeFileSync(join(dir, "package.json"), "{}"); }],
    ["the repo is missing", () => { rmSync(dir, { recursive: true, force: true }); }],
  ] as const) {
    it(`a failed install (${label}) keeps the preview offline instead of booting Vite on a tree with no packages`, async () => {
      setup();
      row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: 5173 };
      execCommand.mockImplementation(async (_id: string, cmd: string) => {
        if (cmd.startsWith("curl ")) return { stdout: "000", stderr: "", exit_code: 7 };
        if (cmd === SYNC_SITE_DEPS_CMD) return runInTree(cmd);
        return { stdout: "", stderr: "", exit_code: 0 };
      });
      await kickSandboxPreview({ tenant_id: "t1", node, site: true });
      expect(cmds()).toContain(SYNC_SITE_DEPS_CMD);
      expect(rpc).toHaveBeenCalledWith("clear_sandbox_preview", { p_id: "row-1", p_final_status: "dead" });
      expect(startPreviewServer).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" }));
    });
  }

  it("the returned promise settles only once the install and the boot are done, so a lease held across it covers both", async () => {
    staleTree(sha1(OLD_LOCK));
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: 5173 };
    execCommand.mockImplementation(async (_id: string, cmd: string) => {
      if (cmd.startsWith("curl ")) return { stdout: "000", stderr: "", exit_code: 7 };
      if (cmd === SYNC_SITE_DEPS_CMD) {
        await new Promise((r) => setTimeout(r, 30));
        return runInTree(cmd);
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    startPreviewServer.mockImplementation(async (_id: string, port: number) => {
      await new Promise((r) => setTimeout(r, 30));
      return { url: `https://${port}-sb-1.e2b.app`, port };
    });
    await kickSandboxPreview({ tenant_id: "t1", node, site: true });
    expect(npmCalls()).toHaveLength(1);
    expect(startPreviewServer).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith("set_sandbox_preview", expect.objectContaining({ p_status: "live" }));
  });

  it("the readiness budget covers the whole backoff with every probe and confirmation timing out", () => {
    const probes = PREVIEW_READY_DELAYS_MS.length + 1 + PREVIEW_READY_STREAK;
    const worstMs =
      PREVIEW_READY_DELAYS_MS.reduce((a, b) => a + b, 0) + PREVIEW_READY_STREAK * PREVIEW_READY_CONFIRM_GAP_MS + probes * SANDBOX_PROBE_TIMEOUT_MS;
    expect(PREVIEW_READINESS_BUDGET_S * 1000).toBeGreaterThanOrEqual(worstMs);
  });

  it("the wake lease outlives the longest wake: every exec budget of a stale-package restart end to end, then the readiness wait", () => {
    const wakeMs =
      15_000 + 10_000 + 20_000 + 20_000 + STOP_DEV_SERVER_TIMEOUT_MS + SITE_DEPS_SYNC_TIMEOUT_MS + 20_000 + (PREVIEW_BOOT_TIMEOUT_DEFAULT_S + PREVIEW_EXEC_HEADROOM_S) * 1000 +
      PREVIEW_READINESS_BUDGET_S * 1000;
    expect(SITE_LEASE_TTL_S.wake * 1000).toBeGreaterThanOrEqual(wakeMs);
  });

  it("the restart lease outlives a fast-fix restart: stop, install, boot and the readiness wait", () => {
    const restartMs =
      STOP_DEV_SERVER_TIMEOUT_MS + SITE_DEPS_SYNC_TIMEOUT_MS + (PREVIEW_BOOT_TIMEOUT_DEFAULT_S + PREVIEW_EXEC_HEADROOM_S) * 1000 + PREVIEW_READINESS_BUDGET_S * 1000;
    expect(SITE_LEASE_TTL_S.restart * 1000).toBeGreaterThanOrEqual(restartMs);
  });

  it("an app that is not a site never runs the site install", async () => {
    row = { id: "row-1", e2b_sandbox_id: "sb-1", preview_status: "dead", preview_port: null };
    execCommand.mockResolvedValue({ stdout: "000", stderr: "", exit_code: 7 });
    kickSandboxPreview({ tenant_id: "t1", node });
    await vi.waitFor(() => expect(startPreviewServer).toHaveBeenCalled());
    expect(cmds()).not.toContain(SYNC_SITE_DEPS_CMD);
    expect(cmds()).not.toContain(SITE_DEPS_STALE_CMD);
  });
});
