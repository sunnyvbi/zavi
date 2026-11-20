import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshOriginUrlStep, stripOriginTokenStep } from "../e2b-client";

const CLASSIC = "ghs_" + "A".repeat(36);
const REFRESH_TOKEN = "ghr_" + "b".repeat(40);
const PAT = "github_pat_" + "C".repeat(30);
const STATELESS = `ghs_123456_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYiLCJleHAiOjE3MDB9.${"x-_Y".repeat(30)}`;

let root: string;
let home: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: baseEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    ...extra,
  };
}

function runStrip(repoDir: string, extraEnv: Record<string, string> = {}) {
  const cmd = stripOriginTokenStep().split("/home/user/repo").join(repoDir);
  return spawnSync("bash", ["-c", `(set -e; ${cmd}\n)`], { encoding: "utf8", env: baseEnv(extraEnv) });
}

function runRefresh(repoDir: string, token: string) {
  const cmd = `cd ${repoDir} && ${refreshOriginUrlStep()}echo REFRESHED`;
  return spawnSync("bash", ["-c", `(set -e; ${cmd}\n)`], {
    encoding: "utf8",
    env: baseEnv(token ? { GITHUB_TOKEN: token } : {}),
  });
}

function newRepo(name = "repo"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scrub-real-"));
  home = join(root, "home");
  mkdirSync(home);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stripOriginTokenStep — checkout detection", () => {
  it("no checkout at all and clean global config: exit 0", () => {
    expect(runStrip(join(root, "missing")).status).toBe(0);
  });

  it("a directory that is not a git repo: exit 0", () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    expect(runStrip(dir).status).toBe(0);
  });

  it("a .git that git cannot read fails closed", () => {
    const dir = join(root, "broken");
    mkdirSync(dir);
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/path\n");
    const r = runStrip(dir);
    expect(r.status).toBe(5);
  });

  it("no checkout still fails on a token in the global config", () => {
    writeFileSync(join(home, ".gitconfig"), `[url "https://x-access-token:${CLASSIC}@github.com/"]\n\tinsteadOf = https://github.com/\n`);
    expect(runStrip(join(root, "missing")).status).toBe(3);
  });

  it("no checkout still fails on a token in ~/.git-credentials", () => {
    writeFileSync(join(home, ".git-credentials"), `https://x-access-token:${CLASSIC}@github.com\n`);
    expect(runStrip(join(root, "missing")).status).toBe(4);
  });
});

describe("stripOriginTokenStep — remote rewrite", () => {
  it("scrubs a tokened origin (url and pushurl, every value) to the placeholder", () => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", `https://x-access-token:${CLASSIC}@github.com/o/r.git`);
    git(dir, "config", "--add", "remote.origin.url", `https://x-access-token:${PAT}@github.com/o/r2.git`);
    git(dir, "config", "remote.origin.pushurl", `https://u:${STATELESS}@github.com/o/r.git`);
    const r = runStrip(dir);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(git(dir, "config", "--get-all", "remote.origin.url").split("\n")).toEqual([
      "https://x-access-token:REVOKED@github.com/o/r.git",
      "https://x-access-token:REVOKED@github.com/o/r2.git",
    ]);
    expect(git(dir, "config", "remote.origin.pushurl")).toBe("https://x-access-token:REVOKED@github.com/o/r.git");
  });

  it("handles odd but legal remote names (-evil, quotes, dots)", () => {
    const dir = newRepo();
    const names = ["-evil", 'we"ird', "a.b", "x$y"];
    for (const n of names) git(dir, "remote", "add", "--", n, `https://x-access-token:${CLASSIC}@github.com/o/${names.indexOf(n)}.git`);
    const r = runStrip(dir);
    expect(r.status).toBe(0);
    names.forEach((n, i) => {
      expect(git(dir, "config", "--get", `remote.${n}.url`)).toBe(`https://x-access-token:REVOKED@github.com/o/${i}.git`);
    });
  });

  it("leaves credential-free and ssh remotes alone", () => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
    git(dir, "remote", "add", "ssh", "git@github.com:o/r.git");
    expect(runStrip(dir).status).toBe(0);
    expect(git(dir, "remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
    expect(git(dir, "remote", "get-url", "ssh")).toBe("git@github.com:o/r.git");
  });

  it("a linked worktree (.git is a file) is scrubbed through the common dir", () => {
    const main = newRepo("main");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "remote", "add", "origin", `https://x-access-token:${CLASSIC}@github.com/o/r.git`);
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", wt);
    expect(existsSync(join(wt, ".git"))).toBe(true);
    const r = runStrip(wt);
    expect(r.status).toBe(0);
    expect(git(main, "remote", "get-url", "origin")).toBe("https://x-access-token:REVOKED@github.com/o/r.git");
  });
});

describe("stripOriginTokenStep — verification scans every config source", () => {
  it("a token in an included config file fails", () => {
    const dir = newRepo();
    const inc = join(root, "extra.gitconfig");
    writeFileSync(inc, `[http]\n\textraHeader = Authorization: Bearer ${CLASSIC}\n`);
    git(dir, "config", "include.path", inc);
    expect(runStrip(dir).status).toBe(3);
  });

  it("a token in a linked worktree's config.worktree fails (even when git would not read it)", () => {
    const main = newRepo("main");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(root, "wt");
    git(main, "worktree", "add", "-q", wt);
    const gitDir = git(wt, "rev-parse", "--git-dir");
    writeFileSync(join(gitDir, "config.worktree"), `[credential]\n\tusername = ${REFRESH_TOKEN}\n`);
    expect(runStrip(main).status).toBe(3);
  });

  it("a token injected through GIT_CONFIG_* env fails", () => {
    const dir = newRepo();
    const r = runStrip(dir, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: token ${STATELESS}`,
    });
    expect(r.status).toBe(3);
  });

  it("a non-placeholder x-access-token credential fails even if it is not token-shaped", () => {
    const dir = newRepo();
    git(dir, "config", "url.https://x-access-token:short@github.com/.insteadOf", "https://github.com/");
    expect(runStrip(dir).status).toBe(3);
  });

  it("an unreadable global config fails closed", () => {
    if (process.getuid?.() === 0) return;
    const cfg = join(home, ".gitconfig");
    writeFileSync(cfg, "[core]\n\tbare = false\n");
    chmodSync(cfg, 0o000);
    const r = runStrip(newRepo());
    chmodSync(cfg, 0o600);
    expect(r.status).toBe(7);
  });

  it("does not flag token-like text inside a longer word", () => {
    const dir = newRepo();
    git(dir, "config", "branch.laughs_and_more_words_here_ok.remote", "origin");
    expect(runStrip(dir).status).toBe(0);
  });
});

describe("stripOriginTokenStep — credential stores", () => {
  it.each([
    ["classic installation", CLASSIC],
    ["refresh (ghr_)", REFRESH_TOKEN],
    ["fine-grained PAT", PAT],
    ["stateless installation", STATELESS],
  ])("~/.git-credentials with a %s token fails", (_label, token) => {
    writeFileSync(join(home, ".git-credentials"), `https://x-access-token:${token}@github.com\n`);
    expect(runStrip(newRepo()).status).toBe(4);
  });

  it("the XDG credential store is checked", () => {
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "credentials"), `https://u:${STATELESS}@github.com\n`);
    expect(runStrip(newRepo(), { XDG_CONFIG_HOME: xdg }).status).toBe(4);
  });

  it("the default XDG path ($HOME/.config/git/credentials) is checked", () => {
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "credentials"), `https://u:${CLASSIC}@github.com\n`);
    expect(runStrip(newRepo()).status).toBe(4);
  });

  it.each([
    ["--file=<abs>", "creds.txt", (p: string) => `store --file=${p}`],
    ["--file <abs>", "creds.txt", (p: string) => `store --file ${p}`],
    ['--file "<abs with space>"', "creds store.txt", (p: string) => `store --file "${p}"`],
    ["--file '<abs with space>'", "creds store.txt", (p: string) => `store --file '${p}'`],
  ])("a store helper with %s is checked", (_label, name, helper) => {
    const store = join(root, name);
    writeFileSync(store, `https://x-access-token:${CLASSIC}@github.com\n`);
    const dir = newRepo();
    git(dir, "config", "credential.helper", helper(store));
    expect(runStrip(dir).status).toBe(4);
  });

  it("a store helper with a ~/ path is checked", () => {
    writeFileSync(join(home, "mycreds"), `https://x-access-token:${CLASSIC}@github.com\n`);
    const dir = newRepo();
    git(dir, "config", "credential.https://github.com.helper", "store --file=~/mycreds");
    expect(runStrip(dir).status).toBe(4);
  });

  it("an unreadable credential store fails closed", () => {
    if (process.getuid?.() === 0) return;
    const f = join(home, ".git-credentials");
    writeFileSync(f, "https://github.com\n");
    chmodSync(f, 0o000);
    const r = runStrip(newRepo());
    chmodSync(f, 0o600);
    expect(r.status).toBe(7);
  });

  it.each([
    ["a shell snippet", "!f() { cat >> /tmp/stolen; }; f"],
    ["an arbitrary program", "/tmp/evil-helper"],
    ["osxkeychain", "osxkeychain"],
    ["cache on a custom socket (its daemon survives)", "cache --socket=/tmp/other.sock"],
    ["store with a path git would expand", 'store --file="$HOME/creds"'],
    ["store with an escaped path", "store --file=/tmp/creds\\ file"],
    ["store with trailing junk", "store --file /tmp/a /tmp/b"],
    ["store with a shell command after the path", "store --file=/nonexistent;env>&2;#"],
    ["store with a quoted path then a command", 'store --file "/tmp/a"; env'],
    ["store whose value hides a second line", "store\n!env >&2"],
    ["cache whose value hides a second line", "cache --timeout=60\n!env >&2"],
  ])("a credential helper that is %s fails closed", (_label, helper) => {
    const dir = newRepo();
    git(dir, "config", "credential.helper", helper);
    expect(runStrip(dir).status).toBe(8);
  });

  it("store and cache helpers (and a reset to empty) are allowed", () => {
    const dir = newRepo();
    git(dir, "config", "--add", "credential.helper", "");
    git(dir, "config", "--add", "credential.helper", "cache --timeout=60");
    git(dir, "config", "--add", "credential.helper", "store");
    expect(runStrip(dir).status).toBe(0);
  });

  it("a token with a character glued in front is still found", () => {
    writeFileSync(join(home, ".git-credentials"), `https://u:x${CLASSIC}@github.com\n`);
    expect(runStrip(newRepo()).status).toBe(4);
  });

  it("a clean credential store passes", () => {
    writeFileSync(join(home, ".git-credentials"), "https://x-access-token:REVOKED@github.com\n");
    expect(runStrip(newRepo()).status).toBe(0);
  });
});

describe("refreshOriginUrlStep — real git", () => {
  const TOKEN = "ghs_" + "F".repeat(36);

  it.each([
    ["tokened https", `https://x-access-token:${CLASSIC}@github.com/o/r.git`],
    ["REVOKED placeholder", "https://x-access-token:REVOKED@github.com/o/r.git"],
    ["bare https", "https://github.com/o/r.git"],
    ["ssh:// url", "ssh://git@github.com/o/r.git"],
    ["scp-like ssh", "git@github.com:o/r.git"],
  ])("%s origin becomes a well-formed tokened https URL", (_label, url) => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", url);
    const r = runRefresh(dir, TOKEN);
    expect(r.stdout).toContain("REFRESHED");
    expect(git(dir, "remote", "get-url", "origin")).toBe(`https://x-access-token:${TOKEN}@github.com/o/r.git`);
  });

  it("a stateless token round-trips intact", () => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
    expect(runRefresh(dir, STATELESS).stdout).toContain("REFRESHED");
    expect(git(dir, "remote", "get-url", "origin")).toBe(`https://x-access-token:${STATELESS}@github.com/o/r.git`);
  });

  it.each([
    ["another https host", "https://evil.example.com/o/r.git"],
    ["a host that only starts with github.com", "https://github.com.evil.example/o/r.git"],
    ["credential pointing at another host", "https://x-access-token:REVOKED@evil.example/o/r.git"],
    ["ssh to another host", "git@evil.example:o/r.git"],
  ])("refuses %s and never writes the token", (_label, url) => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", url);
    const r = runRefresh(dir, TOKEN);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("REFRESHED");
    expect(git(dir, "remote", "get-url", "origin")).toBe(url);
  });

  it("refuses when GITHUB_TOKEN is empty", () => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
    const r = runRefresh(dir, "");
    expect(r.stdout).not.toContain("REFRESHED");
    expect(git(dir, "remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
  });

  it("keeps plain && semantics when a caller chains it after a failing command", () => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
    const cmd = `cd ${dir} && false && ${refreshOriginUrlStep()}echo FETCHED; echo "status=$?"`;
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: baseEnv({ GITHUB_TOKEN: TOKEN }) });
    expect(r.stdout).not.toContain("FETCHED");
    expect(r.stderr).not.toContain("refresh-origin");
    expect(git(dir, "remote", "get-url", "origin")).toBe("https://github.com/o/r.git");
  });

  it("strip then refresh round-trips (resume after a revoke)", () => {
    const dir = newRepo();
    git(dir, "remote", "add", "origin", `https://x-access-token:${CLASSIC}@github.com/o/r.git`);
    expect(runStrip(dir).status).toBe(0);
    expect(runRefresh(dir, TOKEN).stdout).toContain("REFRESHED");
    expect(git(dir, "remote", "get-url", "origin")).toBe(`https://x-access-token:${TOKEN}@github.com/o/r.git`);
  });
});
