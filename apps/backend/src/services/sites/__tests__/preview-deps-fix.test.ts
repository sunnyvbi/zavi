import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeSitePreviewConfigCmd } from "../preview-picker";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_DEPS_FIX_REPEAT_WINDOW_MS,
  buildPreviewDepsRepairCmd,
  packagesInstallableFromLock,
  tryPreviewDepsFix,
  unresolvedPackageImports,
  type PreviewDepsFixDeps,
} from "../preview-deps-fix";
import { STOP_TEMPLATE_DEV_SERVER_CMD } from "../sandbox-ready";
import type { SiteRow } from "../contract";

type ExecResult = Awaited<ReturnType<PreviewDepsFixDeps["exec"]>>;
type StartPreviewOpts = Parameters<PreviewDepsFixDeps["startPreview"]>[2];

const T1 = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const REPO = "Zavi-Latest-Build/brightsmile-dental-b896bdf2-60fd89";
const OLD_LOCK = '{"packages":{"node_modules/react":{}}}';
const SITE_LOCK = '{"lockfileVersion":3,"packages":{"node_modules/react":{},"node_modules/lucide-react":{},"node_modules/clsx":{},"node_modules/@radix-ui/react-slot":{}}}';
const MANIFEST = '{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0","clsx":"2.1.1","@radix-ui/react-slot":"1.1.0"}}';
const sha1 = (t: string) => createHash("sha1").update(t, "utf8").digest("hex");

const BRIGHTSMILE_FIX = [
  "Fix these 2 errors in the preview:",
  "",
  '1. On /: [plugin:vite:import-analysis] Failed to resolve import "lucide-react" from "src/components/sections/Contact.tsx". Does the file exist?',
  "   at formatError (file:///home/user/repo/node_modules/vite/dist/node/chunks/dep.js:49830:46)",
  "",
  '2. On /: [plugin:vite:import-analysis] Failed to resolve import "lucide-react" from "src/pages/Home.tsx". Does the file exist?',
].join("\n");

describe("unresolvedPackageImports", () => {
  it("reads the packages out of the BrightSmile Fix error message", () => {
    expect(unresolvedPackageImports(BRIGHTSMILE_FIX)).toEqual(["lucide-react"]);
  });

  it("reduces subpaths and keeps scopes", () => {
    const msg = [
      "Fix these 2 errors in the preview:",
      "",
      '1. On /about: Failed to resolve import "lucide-react/dist/esm/icons/x" from "src/A.tsx". Does the file exist?',
      '2. On /: Failed to resolve import "@radix-ui/react-slot" from "src/B.tsx". Does the file exist?',
    ].join("\n");
    expect(unresolvedPackageImports(msg)).toEqual(["@radix-ui/react-slot", "lucide-react"]);
  });

  it("tolerates the dynamic-import failure that follows a missing package", () => {
    const msg = [
      "Fix these 2 errors in the preview:",
      "",
      '1. On /: Failed to resolve import "clsx" from "src/lib/utils.ts". Does the file exist?',
      "2. On /: TypeError: Failed to fetch dynamically imported module: https://5173-x.e2b.app/src/pages/Home.tsx",
    ].join("\n");
    expect(unresolvedPackageImports(msg)).toEqual(["clsx"]);
  });

  it.each([
    ["a local alias import", 'Fix this error in the preview:\n\nOn /: Failed to resolve import "@/components/Hero" from "src/App.tsx". Does the file exist?'],
    ["a relative import", 'Fix this error in the preview:\n\nOn /: Failed to resolve import "./Hero" from "src/App.tsx". Does the file exist?'],
    ["a code error", "Fix this error in the preview:\n\nOn /: TypeError: Cannot read properties of undefined (reading 'map')"],
    ["a missing package next to a code error", 'Fix these 2 errors in the preview:\n\n1. On /: Failed to resolve import "clsx" from "src/a.ts". Does the file exist?\n2. On /: ReferenceError: foo is not defined'],
    ["only a dynamic-import failure", "Fix this error in the preview:\n\nOn /: TypeError: Failed to fetch dynamically imported module: x"],
    ["a chat message that mentions the error", 'please fix: Failed to resolve import "lucide-react" from "src/App.tsx"'],
    ["a shell-looking package name", 'Fix this error in the preview:\n\nOn /: Failed to resolve import "a;rm -rf /" from "src/App.tsx". Does the file exist?'],
    ["an uppercase name npm never publishes", 'Fix this error in the preview:\n\nOn /: Failed to resolve import "Lucide" from "src/App.tsx". Does the file exist?'],
  ])("is null for %s", (_label, msg) => {
    expect(unresolvedPackageImports(msg)).toBeNull();
  });
});

describe("packagesInstallableFromLock", () => {
  it("needs the package in package.json AND in the lockfile npm ci installs from", () => {
    expect(packagesInstallableFromLock(MANIFEST, SITE_LOCK, ["lucide-react", "@radix-ui/react-slot"])).toBe(true);
    expect(packagesInstallableFromLock(MANIFEST, OLD_LOCK, ["lucide-react"])).toBe(false);
    expect(packagesInstallableFromLock('{"dependencies":{"react":"1"}}', SITE_LOCK, ["lucide-react"])).toBe(false);
    expect(packagesInstallableFromLock('{"devDependencies":{"clsx":"2"}}', '{"dependencies":{"clsx":{}}}', ["clsx"])).toBe(true);
    expect(packagesInstallableFromLock("not json", SITE_LOCK, ["clsx"])).toBe(false);
    expect(packagesInstallableFromLock('{"dependencies":{"constructor":"1"}}', '{"packages":{}}', ["constructor"])).toBe(false);
  });
});

describe("tryPreviewDepsFix: a declared package the sandbox never installed", () => {
  let dir: string;
  let bin: string;
  let npmLog: string;
  let atBoot: Array<{ lucide: boolean; stamp: string | null; stopped: boolean }>;
  let order: string[];
  let scheduled: Array<Promise<unknown>>;
  let released: string[];

  function tree(stamp: string | null, lock = SITE_LOCK, manifest = MANIFEST) {
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "react", "package.json"), "{}");
    if (stamp !== null) writeFileSync(join(dir, "node_modules", ".zavi-lock"), `${stamp}\n`);
    writeFileSync(join(dir, "package.json"), manifest);
    writeFileSync(join(dir, "package-lock.json"), lock);
  }

  function npmCalls() {
    return existsSync(npmLog) ? readFileSync(npmLog, "utf8").split("\n").filter(Boolean) : [];
  }

  const site = (over: Partial<SiteRow> = {}) =>
    ({ id: "site-1", tenant_id: T1, github_full_name: REPO, status: "building", ...over }) as SiteRow;

  function deps(over: Partial<PreviewDepsFixDeps> = {}) {
    let stopped = false;
    const base = {
      loadSite: vi.fn(async () => site()),
      siteRunActive: vi.fn(async () => false),
      loadSandbox: vi.fn(async () => ({ e2b_sandbox_id: "it9amvtt44lxln8ivjejc", status: "active" })),
      claimLease: vi.fn(async () => "lease-token"),
      releaseLease: vi.fn(async (_t: string, _s: string, token: string) => void released.push(token)),
      exec: vi.fn(async (_id: string, cmd: string, _timeoutMs: number): Promise<ExecResult> => {
        if (cmd === STOP_TEMPLATE_DEV_SERVER_CMD) {
          order.push("stop");
          stopped = true;
          return { stdout: "__stop=stopped\n", stderr: "", exit_code: 0 };
        }
        if (cmd.includes("__FBP__NOREPO")) order.push("install");
        const local = cmd.split("/home/user/repo").join(dir);
        const r = spawnSync("bash", ["-c", `(set -e; ${local}\n)`], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
        return { stdout: r.stdout, stderr: r.stderr, exit_code: r.status ?? 1 };
      }),
      startPreview: vi.fn(async (_id: string, port: number, _opts: StartPreviewOpts) => {
        order.push("boot");
        atBoot.push({
          lucide: existsSync(join(dir, "node_modules", "lucide-react", "package.json")),
          stamp: existsSync(join(dir, "node_modules", ".zavi-lock")) ? readFileSync(join(dir, "node_modules", ".zavi-lock"), "utf8").trim() : null,
          stopped,
        });
        return { url: `https://${port}-it9amvtt44lxln8ivjejc.e2b.app`, port };
      }),
      recordPreview: vi.fn<Parameters<PreviewDepsFixDeps["recordPreview"]>, ReturnType<PreviewDepsFixDeps["recordPreview"]>>(async () => true),
      hostFor: vi.fn(async (_id: string, port: number) => `https://${port}-host.e2b.app`),
      probeReady: vi.fn(async () => true),
      sleep: async () => undefined,
      schedule: (p: Promise<unknown>) => void scheduled.push(p),
      log: () => undefined,
    };
    return Object.assign(base, over);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zfix-"));
    bin = mkdtempSync(join(tmpdir(), "zfix-bin-"));
    npmLog = join(bin, "calls.log");
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\necho "$@" >> '${npmLog}'\nfor p in react lucide-react clsx @radix-ui/react-slot; do mkdir -p "node_modules/$p"; echo '{}' > "node_modules/$p/package.json"; done\nexit $(cat '${join(bin, "exit")}' 2>/dev/null || echo 0)\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
    atBoot = [];
    order = [];
    scheduled = [];
    released = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.mocked(console.warn).mockRestore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it("stops Vite, installs from the lock, restarts Vite on the installed tree, publishes live, and gives the lease back", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toEqual({
      handled: true,
      packages: ["lucide-react"],
    });
    await Promise.all(scheduled);
    expect(order).toEqual(["stop", "install", "boot"]);
    expect(atBoot).toEqual([{ lucide: true, stamp: sha1(SITE_LOCK), stopped: true }]);
    expect(npmCalls()).toHaveLength(1);
    expect(npmCalls()[0]).toMatch(/^ci\b/);
    expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "live", repo_full_name: REPO, port: 5173 }));
    expect(d.claimLease).toHaveBeenCalledWith(T1, "site-1");
    expect(released).toEqual(["lease-token"]);
  });

  it("the row says 'starting' before the server stops, and the preview config is rewritten after the install, before the boot", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    d.recordPreview.mockImplementation(async (input: { status: string }) => {
      order.push(`row:${input.status}`);
      return true;
    });
    const exec = d.exec.getMockImplementation()!;
    d.exec.mockImplementation(async (id: string, cmd: string, t: number) => {
      if (cmd === writeSitePreviewConfigCmd()) order.push("config");
      return exec(id, cmd, t);
    });
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    expect(order.slice(0, 5)).toEqual(["row:starting", "stop", "install", "config", "boot"]);
  });

  it("a row that cannot be marked starting leaves the running server alone", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    d.recordPreview.mockImplementation(async () => false);
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    expect(order).toEqual([]);
    expect(npmCalls()).toHaveLength(0);
    expect(released).toEqual(["lease-token"]);
  });

  it("a preview config that cannot be written after the install keeps the preview offline", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    const exec = d.exec.getMockImplementation()!;
    d.exec.mockImplementation(async (id: string, cmd: string, t: number) =>
      cmd === writeSitePreviewConfigCmd() ? { stdout: "", stderr: "disk full", exit_code: 1 } : exec(id, cmd, t),
    );
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "dead" }));
  });

  it("reinstalls even when the stamp already matches the lock but the package directory is missing", async () => {
    tree(sha1(SITE_LOCK));
    const d = deps();
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    expect(npmCalls()).toHaveLength(1);
    expect(atBoot).toEqual([{ lucide: true, stamp: sha1(SITE_LOCK), stopped: true }]);
  });

  it("an install that leaves a package missing keeps the preview offline and releases the lease", async () => {
    tree(sha1(OLD_LOCK));
    writeFileSync(join(bin, "exit"), "1");
    const d = deps();
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    expect(order).toEqual(["stop", "install"]);
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(d.recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "dead", url: null }));
    expect(released).toEqual(["lease-token"]);
  });

  it("a server that will not stop is never installed under, and the lease is released", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    d.exec.mockImplementation(async (_id: string, cmd: string) => {
      if (cmd === STOP_TEMPLATE_DEV_SERVER_CMD) return { stdout: "", stderr: "", exit_code: 1 };
      if (!cmd.includes("__FBP__NOREPO")) {
        const r = spawnSync("bash", ["-c", cmd.split("/home/user/repo").join(dir)], { encoding: "utf8" });
        return { stdout: r.stdout, stderr: "", exit_code: r.status ?? 1 };
      }
      order.push("install");
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    expect(order).toEqual([]);
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(released).toEqual(["lease-token"]);
    expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "live", url: "https://5173-host.e2b.app" }));
  });

  const notHandled: Array<[string, () => void, Partial<PreviewDepsFixDeps>, string]> = [
    ["a package the site never declared", () => tree(sha1(OLD_LOCK), OLD_LOCK, '{"dependencies":{"react":"18.3.1"}}'), {}, "undeclared_package"],
    ["a declared package the lock does not have (npm ci cannot install it)", () => tree(sha1(OLD_LOCK), OLD_LOCK), {}, "undeclared_package"],
    ["a site run in flight", () => tree(sha1(OLD_LOCK)), { siteRunActive: vi.fn(async () => true) }, "site_run_active"],
    ["an unreadable run state (fails closed)", () => tree(sha1(OLD_LOCK)), { siteRunActive: vi.fn(async () => { throw new Error("db"); }) }, "site_run_active"],
    ["the site lease held by a restart or edit", () => tree(sha1(OLD_LOCK)), { claimLease: vi.fn(async () => null) }, "lease_held"],
    ["no running sandbox", () => tree(sha1(OLD_LOCK)), { loadSandbox: vi.fn(async () => ({ e2b_sandbox_id: "x", status: "paused" })) }, "no_running_sandbox"],
    ["another tenant's site", () => tree(sha1(OLD_LOCK)), { loadSite: vi.fn(async () => site({ tenant_id: "other" })) }, "no_site"],
    ["an old-flow app", () => tree(sha1(OLD_LOCK)), { loadSite: vi.fn(async () => null) }, "no_site"],
  ];

  it.each(notHandled)("hands %s to the agent and touches nothing", async (_label, setup, over, reason) => {
    setup();
    const d = deps(over);
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toEqual({ handled: false, reason });
    expect(scheduled).toHaveLength(0);
    expect(order).toEqual([]);
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(npmCalls()).toHaveLength(0);
    if (reason !== "lease_held") expect(released).toEqual([]);
  });

  const SUBPATH_FIX = 'Fix this error in the preview:\n\nOn /: [plugin:vite:import-analysis] Failed to resolve import "lucide-react/icons/made-up" from "src/pages/Home.tsx". Does the file exist?';
  const installLucide = () => {
    mkdirSync(join(dir, "node_modules", "lucide-react"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "lucide-react", "package.json"), "{}");
  };

  it.each([
    ["the stamp matches the lock", () => sha1(SITE_LOCK)],
    ["the stamp is stale", () => sha1(OLD_LOCK)],
  ])("a subpath of an installed package goes to the agent when %s: no stop, no install, no lease", async (_label, stamp) => {
    tree(stamp());
    installLucide();
    const d = deps();
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: SUBPATH_FIX }, d)).resolves.toEqual({
      handled: false,
      reason: "packages_installed",
    });
    expect(scheduled).toHaveLength(0);
    expect(order).toEqual([]);
    expect(npmCalls()).toHaveLength(0);
    expect(d.claimLease).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".git", "zavi-preview-deps-fix"))).toBe(false);
  });

  it("a bare import of a package already installed on a current tree goes to the agent", async () => {
    tree(sha1(SITE_LOCK));
    installLucide();
    const d = deps();
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toEqual({
      handled: false,
      reason: "packages_installed",
    });
    expect(d.claimLease).not.toHaveBeenCalled();
    expect(npmCalls()).toHaveLength(0);
  });

  it("a bare import of an installed package on a stale tree still reinstalls", async () => {
    tree(sha1(OLD_LOCK));
    installLucide();
    const d = deps();
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toMatchObject({ handled: true });
    await Promise.all(scheduled);
    expect(npmCalls()).toHaveLength(1);
  });

  it("a subpath whose package is missing takes the fast path", async () => {
    tree(sha1(SITE_LOCK));
    const d = deps();
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: SUBPATH_FIX }, d)).resolves.toEqual({
      handled: true,
      packages: ["lucide-react"],
    });
    await Promise.all(scheduled);
    expect(order).toEqual(["stop", "install", "boot"]);
  });

  it("the same error back within the repeat window goes to the agent, and is fast again once the window has passed", async () => {
    let clock = 1_800_000_000_000;
    tree(sha1(OLD_LOCK));
    const d = deps({ now: () => clock });
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toMatchObject({ handled: true });
    await Promise.all(scheduled);
    expect(npmCalls()).toHaveLength(1);
    rmSync(join(dir, "node_modules", "lucide-react"), { recursive: true, force: true });

    clock += PREVIEW_DEPS_FIX_REPEAT_WINDOW_MS - 1_000;
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toEqual({
      handled: false,
      reason: "repeat_fast_fix",
    });
    expect(scheduled).toHaveLength(1);
    expect(d.claimLease).toHaveBeenCalledTimes(1);
    expect(npmCalls()).toHaveLength(1);

    clock += 2_000;
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toMatchObject({ handled: true });
    await Promise.all(scheduled);
    expect(npmCalls()).toHaveLength(2);
  });

  it("a different missing package inside the window is still fast", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d);
    await Promise.all(scheduled);
    rmSync(join(dir, "node_modules", "clsx"), { recursive: true, force: true });
    const clsx = 'Fix this error in the preview:\n\nOn /: Failed to resolve import "clsx" from "src/lib/utils.ts". Does the file exist?';
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: clsx }, d)).resolves.toEqual({ handled: true, packages: ["clsx"] });
  });

  it.each([
    ["throws", async () => { throw new Error("e2b 502"); }],
    ["exits non-zero", async () => ({ stdout: "", stderr: "boom", exit_code: 1 })],
    ["times out", async () => ({ stdout: "__missing=lucide-react\n__deps=stale\n", stderr: "", exit_code: 0, timed_out: true })],
    ["prints no state", async () => ({ stdout: "__missing=lucide-react\n", stderr: "", exit_code: 0 })],
  ])("an install check that %s goes to the agent without touching the sandbox", async (_label, check) => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    const real = d.exec.getMockImplementation()!;
    d.exec.mockImplementation(async (id: string, cmd: string, t: number) => (cmd.includes("__deps=") ? check() : real(id, cmd, t)));
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toEqual({
      handled: false,
      reason: "install_check_failed",
    });
    expect(d.claimLease).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(npmCalls()).toHaveLength(0);
  });

  it("a marker that cannot be written releases the lease and goes to the agent", async () => {
    tree(sha1(OLD_LOCK));
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const d = deps();
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX }, d)).resolves.toEqual({
      handled: false,
      reason: "marker_failed",
    });
    expect(released).toEqual(["lease-token"]);
    expect(order).toEqual([]);
  });

  it("a failed install hands the fix to the agent after the lease is back", async () => {
    tree(sha1(OLD_LOCK));
    writeFileSync(join(bin, "exit"), "1");
    const d = deps();
    const fellBack: Array<{ result: string; released: string[] }> = [];
    const onRepairFailed = vi.fn(async (result: string) => void fellBack.push({ result, released: [...released] }));
    await expect(tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX, onRepairFailed }, d)).resolves.toMatchObject({ handled: true });
    await Promise.all(scheduled);
    expect(fellBack).toEqual([{ result: "install_failed", released: ["lease-token"] }]);
  });

  it("a preview that will not boot after the install also hands the fix to the agent", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    d.startPreview.mockRejectedValue(new Error("port 5173 never opened"));
    const onRepairFailed = vi.fn(async () => undefined);
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX, onRepairFailed }, d);
    await Promise.all(scheduled);
    expect(onRepairFailed).toHaveBeenCalledWith("boot_failed");
    expect(released).toEqual(["lease-token"]);
  });

  it("a successful repair never starts the agent", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    const onRepairFailed = vi.fn(async () => undefined);
    await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: BRIGHTSMILE_FIX, onRepairFailed }, d);
    await Promise.all(scheduled);
    expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "live" }));
    expect(onRepairFailed).not.toHaveBeenCalled();
  });

  it("never claims the lease or reads the sandbox for an error that is not a missing package", async () => {
    tree(sha1(OLD_LOCK));
    const d = deps();
    const r = await tryPreviewDepsFix({ tenant_id: T1, conductor_run_id: RUN, message: "Fix this error in the preview:\n\nOn /: ReferenceError: x is not defined" }, d);
    expect(r).toEqual({ handled: false, reason: "not_unresolved_packages" });
    expect(d.loadSite).not.toHaveBeenCalled();
    expect(d.exec).not.toHaveBeenCalled();
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it("the repair command refuses a name that is not a package", () => {
    expect(() => buildPreviewDepsRepairCmd(["a';rm -rf ~;'"])).toThrow(/invalid package/);
    expect(() => buildPreviewDepsRepairCmd(["a/b"])).toThrow(/invalid package/);
    expect(buildPreviewDepsRepairCmd(["@radix-ui/react-slot", "lucide-react"])).toContain("'@radix-ui/react-slot' 'lucide-react'");
  });
});
