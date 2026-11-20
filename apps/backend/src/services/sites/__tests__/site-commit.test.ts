import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteSandbox } from "../contract";
import { SITE_REPO_DIR } from "../contract";
import { ensureSiteCommit, rootFetchCmd, siteFetchStagingDir, userImportCmd } from "../site-commit";

type Call = { cmd: string; opts: Parameters<SiteSandbox["run"]>[1] };

function fakeSandbox(present: boolean, exits: number[] = []): { sb: SiteSandbox; calls: Call[] } {
  const calls: Call[] = [];
  const sb: SiteSandbox = {
    async run(cmd, opts) {
      calls.push({ cmd, opts });
      if (cmd.startsWith("git cat-file -e")) return { exitCode: present ? 0 : 1, stdout: "", stderr: "" };
      const code = exits.shift() ?? 0;
      return { exitCode: code, stdout: "", stderr: code ? "fatal: nope" : "" };
    },
    async readFile() {
      return "";
    },
    async listFiles() {
      return [];
    },
  };
  return { sb, calls };
}

const REPO = "Zavi-Latest-Build/yoga-studio";
const TOKEN = "ghp_SECRETTOKEN123";
const NONCE = "0123456789abcdef";

describe("ensureSiteCommit hardening", () => {
  it("refuses a sha that is not hex before running anything", async () => {
    const { sb, calls } = fakeSandbox(false);
    await expect(ensureSiteCommit(sb, REPO, "abc1234; curl evil", TOKEN)).rejects.toThrow(/invalid sha/);
    expect(calls).toHaveLength(0);
  });

  it("each fetch stages in its own unguessable dir, created with no git templates and no hooks", async () => {
    const sha = "6fd3d2d0aaaabbbbccccddddeeeeffff00001111";
    const a = fakeSandbox(false);
    const b = fakeSandbox(false);
    await ensureSiteCommit(a.sb, REPO, sha, TOKEN);
    await ensureSiteCommit(b.sb, REPO, sha, TOKEN);
    const dirOf = (cmd: string) => cmd.match(/\/tmp\/zavi-fetch-[0-9a-f]{12}-[0-9a-f]{16}/)?.[0];
    const da = dirOf(a.calls[1]!.cmd);
    const db = dirOf(b.calls[1]!.cmd);
    expect(da).toBeTruthy();
    expect(da).not.toBe(db);
    expect(dirOf(a.calls[2]!.cmd)).toBe(da);
    expect(a.calls[1]!.cmd).toContain("git init --bare -q --template= ");
    expect(a.calls[1]!.cmd).not.toContain("rm -rf '/tmp/zavi-fetch-6fd3d2d0aaaa' &&");
    expect(a.calls[1]!.opts?.env).toMatchObject({ GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null" });
  });

  it("an import that never ran removes the staging repo and rethrows", async () => {
    const sha = "6fd3d2d0aaaabbbbccccddddeeeeffff00001111";
    const calls: string[] = [];
    const sb: SiteSandbox = {
      async run(cmd) {
        calls.push(cmd);
        if (cmd.startsWith("git cat-file -e")) return { exitCode: 1, stdout: "", stderr: "" };
        if (cmd.includes("git fetch --quiet --no-tags '/tmp/zavi-fetch-")) throw new Error("sandbox gone");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async readFile() {
        return "";
      },
      async listFiles() {
        return [];
      },
    };
    await expect(ensureSiteCommit(sb, REPO, sha, TOKEN)).rejects.toThrow("sandbox gone");
    const dir = calls[1]!.match(/\/tmp\/zavi-fetch-[0-9a-f]{12}-[0-9a-f]{16}/)![0];
    expect(calls[3]).toBe(`rm -rf '${dir}'`);
  });

  it("the command builders refuse a bad sha, repo or staging dir", () => {
    expect(() => rootFetchCmd("a/b; rm -rf /", "6fd3d2d", "/tmp/x")).toThrow(/invalid repo/);
    expect(() => rootFetchCmd(REPO, "zzz", "/tmp/x")).toThrow(/invalid sha/);
    expect(() => userImportCmd("6fd3d2d$(id)", "/tmp/x")).toThrow(/invalid sha/);
    expect(() => siteFetchStagingDir("6fd3d2d", "../../etc")).toThrow(/invalid staging dir/);
  });
});

describe("ensureSiteCommit with a token", () => {
  it("fetches as root into its own bare repo, never inside the tenant's repo, then imports as user with no token", async () => {
    const sha = "6fd3d2d0aaaabbbbccccddddeeeeffff00001111";
    const { sb, calls } = fakeSandbox(false);
    await ensureSiteCommit(sb, REPO, sha, TOKEN);
    expect(calls).toHaveLength(3);
    const [, root, user] = calls;
    expect(root!.opts?.user).toBe("root");
    expect(root!.opts?.cwd).toBe("/");
    expect(root!.cmd).not.toContain(SITE_REPO_DIR);
    expect(root!.cmd).not.toContain(TOKEN);
    expect(root!.opts?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/root" });
    expect(root!.opts?.env?.GIT_CONFIG_VALUE_0).toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(root!.opts?.redact).toEqual(expect.arrayContaining([TOKEN]));
    expect(user!.opts?.user).toBeUndefined();
    expect(user!.opts?.env).toBeUndefined();
    expect(user!.opts?.cwd).toBe(SITE_REPO_DIR);
    expect(user!.cmd).not.toContain("github.com");
  });

  it("a commit already present is never fetched, so no token is used at all", async () => {
    const { sb, calls } = fakeSandbox(true);
    await ensureSiteCommit(sb, REPO, "6fd3d2d0aaaabbbbccccddddeeeeffff00001111", TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts?.env).toBeUndefined();
  });

  it("a failed root fetch throws without the token and never runs the import", async () => {
    const { sb, calls } = fakeSandbox(false, [128]);
    const err = await ensureSiteCommit(sb, REPO, "6fd3d2d0aaaabbbbccccddddeeeeffff00001111", TOKEN).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not fetch commit 6fd3d2d: fatal: nope/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(calls).toHaveLength(2);
  });

  it("without a token the fetch runs once, as user, in the site repo", async () => {
    const { sb, calls } = fakeSandbox(false);
    await ensureSiteCommit(sb, REPO, "6fd3d2d0aaaabbbbccccddddeeeeffff00001111", null);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.opts?.user).toBeUndefined();
    expect(calls[1]!.opts?.cwd).toBe(SITE_REPO_DIR);
  });
});

describe("the fetch commands, run for real with git", () => {
  let root: string;
  let origin: string;
  let site: string;
  let sha: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const sh = (cmd: string, cwd: string) => spawnSync("bash", ["-c", `(set -e; ${cmd}\n)`], { cwd, encoding: "utf8" });
  const local = (cmd: string) =>
    cmd
      .split(`https://github.com/${REPO}.git`)
      .join(origin)
      .split("chown -R user:user")
      .join("true")
      .split(siteFetchStagingDir(sha, NONCE))
      .join(join(root, "staging"));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "site-commit-"));
    origin = join(root, "origin");
    site = join(root, "site");
    execFileSync("git", ["init", "-q", origin]);
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    execFileSync("git", ["clone", "-q", origin, site]);
    git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "the version history opens");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    sha = git(origin, "rev-parse", "HEAD");
    writeFileSync(join(site, ".git", "config"), `${execFileSync("cat", [join(site, ".git", "config")], { encoding: "utf8" })}[http]\n\tproxy = http://127.0.0.1:9\n[core]\n\tfsmonitor = touch ${join(root, "pwned")}\n`);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("the root step never reads the tenant repo's poisoned config, and the user import brings the commit in", () => {
    const fetched = sh(local(rootFetchCmd(REPO, sha, siteFetchStagingDir(sha, NONCE))), "/");
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(existsSync(join(root, "pwned"))).toBe(false);
    expect(spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: site }).status).not.toBe(0);
    const imported = sh(local(userImportCmd(sha, siteFetchStagingDir(sha, NONCE))), site);
    expect(imported.status, imported.stderr).toBe(0);
    expect(spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: site }).status).toBe(0);
    expect(existsSync(join(root, "staging"))).toBe(false);
  });

  it("a failing root fetch under set -e still cleans its staging repo and exits non-zero", () => {
    const missing = "0".repeat(40);
    const cmd = local(rootFetchCmd(REPO, sha, siteFetchStagingDir(sha, NONCE))).split(sha).join(missing);
    const r = sh(cmd, "/");
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, "staging"))).toBe(false);
  });
});
