
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execCommand = vi.hoisted(() => vi.fn());
vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand }));

import {
  buildSharedRootInstallSnippet,
  buildWorktreeDepsScript,
  ensureRunWorktreeDeps,
  parseWorktreeDepsOutput,
} from "../shared-install";

function repoWithWorktree(opts: { lockfile?: string }) {
  const base = mkdtempSync(join(tmpdir(), "wtdeps-"));
  const shared = join(base, "repo");
  const wt = join(base, "wt-1");
  mkdirSync(shared);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: shared, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(shared, "package.json"), "{}");
  writeFileSync(join(shared, opts.lockfile ?? "package-lock.json"), "{}");
  writeFileSync(join(shared, ".gitignore"), "node_modules/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  mkdirSync(join(shared, "node_modules", "left-pad"), { recursive: true });
  git("worktree", "add", "-q", wt);
  const run = () =>
    execFileSync("bash", ["-c", buildWorktreeDepsScript({ worktree_path: wt, shared_repo: shared })], {
      encoding: "utf8",
    });
  const wtGit = (...a: string[]) => execFileSync("git", a, { cwd: wt, encoding: "utf8" });
  return { shared, wt, run, wtGit };
}

describe("buildSharedRootInstallSnippet", () => {
  it("installs only when node_modules is missing: npm ci with a lockfile, else npm install", () => {
    const s = buildSharedRootInstallSnippet({ shared_repo: "/home/user/repo", install_timeout_s: 600 });
    expect(s).toContain("if [ ! -e '/home/user/repo'/node_modules ] && [ -f '/home/user/repo'/package.json ]; then");
    expect(s).toContain("timeout 600 npm ci --prefer-offline --no-audit --no-fund");
    expect(s).toContain("timeout 600 npm install --prefer-offline --no-audit --no-fund");
  });
});

describe("buildWorktreeDepsScript (real bash + git)", () => {
  it("links node_modules, hides it from git status, and survives git clean -fd", () => {
    const { wt, run, wtGit } = repoWithWorktree({});
    expect(parseWorktreeDepsOutput(run()).outcome).toBe("ok");
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(wtGit("status", "--porcelain", "--untracked-files=all")).toBe("");
    wtGit("clean", "-fd");
    expect(existsSync(join(wt, "node_modules", "left-pad"))).toBe(true);
  });

  it("is idempotent: a second run adds no second exclude line", () => {
    const { shared, run } = repoWithWorktree({});
    run();
    expect(parseWorktreeDepsOutput(run()).outcome).toBe("ok");
    const lines = readFileSync(join(shared, ".git", "info", "exclude"), "utf8")
      .split("\n")
      .filter((l) => l === "node_modules");
    expect(lines).toHaveLength(1);
  });

  it.each(["pnpm-lock.yaml", "yarn.lock"])("skips a %s repo and links nothing", (lockfile) => {
    const { wt, run } = repoWithWorktree({ lockfile });
    expect(parseWorktreeDepsOutput(run()).outcome).toBe("skip_not_npm");
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
  });
});

describe("install lock", () => {
  it("a lock wait that times out skips the step (non-fatal), linking nothing", () => {
    const { shared, wt } = repoWithWorktree({});
    const bin = mkdtempSync(join(tmpdir(), "flockstub-"));
    writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const out = execFileSync(
      "bash",
      ["-c", buildWorktreeDepsScript({ worktree_path: wt, shared_repo: shared, lock_file: join(bin, "lock") })],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    expect(parseWorktreeDepsOutput(out)).toEqual({ outcome: "failed", code: "lock_timeout" });
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
  });
});

describe("ensureRunWorktreeDeps", () => {
  it("never throws: a sandbox error is `failed` and the run goes on", async () => {
    execCommand.mockRejectedValueOnce(new Error("sandbox gone"));
    await expect(ensureRunWorktreeDeps({ sandbox_id: "sb", worktree_path: "/home/user/wt-1" })).resolves.toEqual({
      outcome: "failed",
    });
  });

  it("reads the outcome marker, with a 660s budget", async () => {
    execCommand.mockResolvedValueOnce({ stdout: "__WTDEPS__NOINSTALL:ERESOLVE\n", stderr: "", exit_code: 0, ms: 9 });
    const r = await ensureRunWorktreeDeps({ sandbox_id: "sb", worktree_path: "/home/user/wt-1" });
    expect(r).toEqual({ outcome: "no_install", code: "ERESOLVE", ms: 9 });
    expect(execCommand.mock.calls.at(-1)?.[2]).toBe(660_000);
  });
});
