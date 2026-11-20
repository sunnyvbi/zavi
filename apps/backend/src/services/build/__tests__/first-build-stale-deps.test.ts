import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildFirstBuildInstallScript, installSiteRepoDeps } from "@/services/build/first-build-preview";

function stubNpm() {
  const bin = mkdtempSync(join(tmpdir(), "npmstub-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${log}'\nmkdir -p node_modules\ntouch node_modules/fresh\n`, { mode: 0o755 });
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { bin, calls };
}

function run(script: string, bin: string) {
  return execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}

function oldApp() {
  const dir = mkdtempSync(join(tmpdir(), "oldapp-"));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "package-lock.json"), '{"old":true}');
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "stale"), "old app dep");
  mkdirSync(join(dir, ".next"));
  writeFileSync(join(dir, ".next", "routes"), "/laptops");
  return dir;
}

describe("a replaced app never runs on the previous app's dependencies or build cache", () => {
  it("reinstalls when the lockfile no longer matches what was installed", () => {
    const npm = stubNpm();
    const dir = oldApp();
    run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    expect(npm.calls()).toHaveLength(1);
    expect(existsSync(join(dir, "node_modules", "stale"))).toBe(false);
    writeFileSync(join(dir, "package-lock.json"), '{"new":true}');
    run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    expect(npm.calls()).toHaveLength(2);
  });

  it("does not reinstall when the lockfile is unchanged", () => {
    const npm = stubNpm();
    const dir = oldApp();
    run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    expect(npm.calls()).toHaveLength(1);
  });

  it("a fresh-app scaffold clears the old Next build cache; other runs keep it", () => {
    const npm = stubNpm();
    const kept = oldApp();
    run(buildFirstBuildInstallScript(kept, 5), npm.bin);
    expect(existsSync(join(kept, ".next", "routes"))).toBe(true);
    const cleared = oldApp();
    run(buildFirstBuildInstallScript(cleared, 5, false, true), npm.bin);
    expect(existsSync(join(cleared, ".next"))).toBe(false);
  });
});

describe("a failed install never gets blessed", () => {
  it("removes partial modules, reports no modules, and writes no stamp", () => {
    const bin = mkdtempSync(join(tmpdir(), "npmfail-"));
    writeFileSync(join(bin, "npm"), `#!/bin/sh\nmkdir -p node_modules\ntouch node_modules/partial\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
    const dir = mkdtempSync(join(tmpdir(), "failapp-"));
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const out = run(buildFirstBuildInstallScript(dir, 5), bin);
    expect(out).toContain("__FBP__NOMODULES");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });
});

describe("a reinstall never runs under a live dev server", () => {
  it.skipIf(!existsSync("/proc/self"))("stops a server running from the tree before deleting its modules; a tree with the right modules is left alone", async () => {
    const { spawn } = await import("node:child_process");
    const npm = stubNpm();
    const dir = oldApp();
    const server = spawn("sleep", ["30"], { cwd: dir, detached: true, stdio: "ignore" });
    const exited = new Promise<void>((r) => server.on("exit", () => r()));
    run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    await exited;
    expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
    const kept = spawn("sleep", ["30"], { cwd: dir, detached: true, stdio: "ignore" });
    run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    expect(kept.exitCode).toBeNull();
    expect(kept.signalCode).toBeNull();
    kept.kill("SIGKILL");
  });
});

describe("a reinstall says which lockfile it was for (template stale vs the site's own change)", () => {
  it("reports the lock's sha1 only when the installed modules were another lock's", async () => {
    const npm = stubNpm();
    const dir = oldApp();
    const out = run(buildFirstBuildInstallScript(dir, 5), npm.bin);
    const sha = createHash("sha1").update(readFileSync(join(dir, "package-lock.json"))).digest("hex");
    expect(out).toContain(`__ZAVI_DEPS_STALE=${sha}`);
    expect(run(buildFirstBuildInstallScript(dir, 5), npm.bin)).not.toContain("__ZAVI_DEPS_STALE");
    const exec = (async () => ({ stdout: out, stderr: "", exit_code: 0 })) as unknown as Parameters<typeof installSiteRepoDeps>[1];
    expect(await installSiteRepoDeps("sb1", exec)).toEqual({ ok: true, reason: "ok", stale: true, lock_sha1: sha });
  });
});
