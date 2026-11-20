
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const exec = vi.fn();
vi.mock("@/services/sandbox/e2b-client", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/e2b-client")>()),
  execCommand: (...a: unknown[]) => exec(...a),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { sandboxTemplateForRun, resetSiteRepo } from "../lifecycle";
import { STAMP_BAKED_DEPS_CMD } from "@/services/sites/sandbox-ready";
import { E2B_VITE_TEMPLATE_ALIAS, E2B_ZAVI_TEMPLATE_ALIAS } from "@/services/sites/contract";
import { SiteBackendUnresolved } from "@/services/sites/site-backend";

describe("sandboxTemplateForRun", () => {
  const prev = process.env.E2B_ENGINEER_TEMPLATE;
  beforeEach(() => {
    delete process.env.E2B_ENGINEER_TEMPLATE;
  });

  it("uses a site image only when the payload carries a site_id", () => {
    expect(sandboxTemplateForRun("engineer", { site_id: "s1", site_backend: "dedicated", stage: "build" })).toBe(E2B_VITE_TEMPLATE_ALIAS);
    expect(sandboxTemplateForRun("engineer", { stage: "build" })).toBe("praxis-xl");
    expect(sandboxTemplateForRun("engineer", { site_id: "" })).toBe("praxis-xl");
    expect(sandboxTemplateForRun("engineer", { site_id: 42 })).toBe("praxis-xl");
    expect(sandboxTemplateForRun("engineer", null)).toBe("praxis-xl");
    expect(sandboxTemplateForRun("qa", {})).toBeUndefined();
    expect(sandboxTemplateForRun("qa", { site_id: "s1", site_backend: "dedicated" })).toBe(E2B_VITE_TEMPLATE_ALIAS);
  });

  it("a pooled site gets the Zavi-SDK image, never the Supabase one; a dedicated site the Vite image", () => {
    expect(sandboxTemplateForRun("engineer", { site_id: "s1", site_backend: "pooled" })).toBe(E2B_ZAVI_TEMPLATE_ALIAS);
    expect(sandboxTemplateForRun("qa", { site_id: "s1", site_backend: "pooled" })).toBe(E2B_ZAVI_TEMPLATE_ALIAS);
    expect(sandboxTemplateForRun("engineer", { site_id: "s1", site_backend: "dedicated" })).toBe(E2B_VITE_TEMPLATE_ALIAS);
    expect(sandboxTemplateForRun("engineer", { site_backend: "pooled" })).toBe("praxis-xl");
  });

  it("a pooled site's refine / fix / edit payload stays on the Zavi image", () => {
    for (const extra of [{ refine_mode: true }, { refine_mode: true, fast_edit: true }, { repair_mode: true, failure_signal: "x" }]) {
      expect(sandboxTemplateForRun("engineer", { site_id: "s1", site_backend: "pooled", stage: "build", ...extra })).toBe(E2B_ZAVI_TEMPLATE_ALIAS);
    }
  });

  it("a site payload with no resolved backend throws a typed retryable error, never the dedicated image", () => {
    for (const p of [{ site_id: "s1" }, { site_id: "s1", site_backend: "static" }, { site_id: "s1", site_backend: null }]) {
      expect(() => sandboxTemplateForRun("engineer", p)).toThrow(SiteBackendUnresolved);
    }
    try {
      sandboxTemplateForRun("engineer", { site_id: "s1", refine_mode: true });
    } catch (e) {
      expect((e as SiteBackendUnresolved).retryable).toBe(true);
      expect((e as SiteBackendUnresolved).code).toBe("site_backend_unresolved");
    }
  });

  it("keeps the engineer env override for non-site runs", () => {
    process.env.E2B_ENGINEER_TEMPLATE = "praxis-large";
    expect(sandboxTemplateForRun("engineer", {})).toBe("praxis-large");
    expect(sandboxTemplateForRun("engineer", { site_id: "s1", site_backend: "dedicated" })).toBe(E2B_VITE_TEMPLATE_ALIAS);
    if (prev === undefined) delete process.env.E2B_ENGINEER_TEMPLATE;
    else process.env.E2B_ENGINEER_TEMPLATE = prev;
  });
});

const REMOTE = "https://github.com/Praxis-build/acme-1a2b3c4d-abcdef.git";
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("resetSiteRepo", () => {
  beforeEach(() => {
    exec.mockReset();
  });

  it("rewires the baked tree to the site remote, resets to origin/main, and verifies", async () => {
    exec.mockResolvedValue({ exit_code: 0, stdout: `__origin=${REMOTE}\n__head=${SHA}\n`, stderr: "", ms: 1 });
    await resetSiteRepo("sbx", REMOTE, SHA);
    const cmd = String(exec.mock.calls[0][1]);
    expect(cmd).toContain("/home/user/repo");
    expect(cmd).toContain('"https://x-access-token:$GITHUB_TOKEN@github.com/Praxis-build/acme-1a2b3c4d-abcdef.git"');
    expect(cmd).toMatch(/git fetch -q origin main/);
    expect(cmd).toMatch(/git checkout -q -f -B main origin\/main/);
    expect(cmd).toMatch(/git reset -q --hard origin\/main/);
    expect(cmd).toContain("sed -E 's#https://[^@]*@#https://#'");
  });

  it("checks out origin/main over the dirty tree a build leaves behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "site-reset-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString();
    try {
      const origin = join(root, "origin.git");
      const box = join(root, "box");
      const author = join(root, "author");
      git(root, "init", "-q", "--bare", origin);
      git(root, "clone", "-q", origin, author);
      writeFileSync(join(author, "Home.tsx"), "starter\n");
      git(author, "add", ".");
      git(author, "commit", "-q", "-m", "starter");
      git(author, "push", "-q", "origin", "HEAD:main");
      git(root, "clone", "-q", "-b", "main", origin, box);
      writeFileSync(join(box, "Home.tsx"), "built\n");
      mkdirSync(join(box, "public"));
      writeFileSync(join(box, "public", "hero.webp"), "img");
      writeFileSync(join(author, "Home.tsx"), "built\n");
      mkdirSync(join(author, "public"));
      writeFileSync(join(author, "public", "hero.webp"), "img");
      git(author, "add", ".");
      git(author, "commit", "-q", "-m", "build");
      git(author, "push", "-q", "origin", "HEAD:main");
      git(box, "fetch", "-q", "origin", "main");
      expect(() => git(box, "checkout", "-q", "-B", "main", "origin/main")).toThrow();
      exec.mockResolvedValue({ exit_code: 0, stdout: `__origin=${REMOTE}\n__head=${SHA}\n`, stderr: "", ms: 1 });
      await resetSiteRepo("sbx", REMOTE, SHA);
      const cmd = String(exec.mock.calls[0][1]);
      const steps = cmd.split(" && ").filter((s) => /^git (checkout|reset|clean) /.test(s));
      expect(steps).toHaveLength(3);
      for (const s of steps) git(box, ...s.replace(/^git /, "").split(" "));
      expect(readFileSync(join(box, "Home.tsx"), "utf8")).toBe("built\n");
      expect(git(box, "status", "--porcelain")).toBe("");
      expect(git(box, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "HEAD"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the origin does not match the site remote", async () => {
    exec.mockResolvedValue({ exit_code: 0, stdout: `__origin=https://github.com/other/repo.git\n__head=${SHA}\n`, stderr: "", ms: 1 });
    await expect(resetSiteRepo("sbx", REMOTE, SHA)).rejects.toThrow(/origin mismatch/);
  });

  it("throws when HEAD is not the expected sha", async () => {
    exec.mockResolvedValue({ exit_code: 0, stdout: `__origin=${REMOTE}\n__head=ffffffffffffffffffffffffffffffffffffffff\n`, stderr: "", ms: 1 });
    await expect(resetSiteRepo("sbx", REMOTE, SHA)).rejects.toThrow(/HEAD mismatch/);
  });

  it("accepts a short sha prefix", async () => {
    exec.mockResolvedValue({ exit_code: 0, stdout: `__origin=${REMOTE}\n__head=${SHA}\n`, stderr: "", ms: 1 });
    await expect(resetSiteRepo("sbx", REMOTE, SHA.slice(0, 12))).resolves.toBeUndefined();
  });

  it("throws on a failed command", async () => {
    exec.mockResolvedValue({ exit_code: 128, stdout: "", stderr: "fatal: could not read", ms: 1 });
    await expect(resetSiteRepo("sbx", REMOTE, SHA)).rejects.toThrow(/exit 128/);
  });

  it("refuses a malformed remote or sha before touching the sandbox", async () => {
    for (const bad of [
      "https://evil.example/a/b.git",
      "https://github.com/a/b.git;echo",
      "git@github.com:a/b.git",
      "https://tok@github.com/a/b.git",
    ]) {
      await expect(resetSiteRepo("sbx", bad, SHA), bad).rejects.toThrow(/invalid site remote/);
    }
    await expect(resetSiteRepo("sbx", REMOTE, "main;echo")).rejects.toThrow(/invalid sha/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("with a token it authenticates from the command's own env, never from the shared sandbox env file", async () => {
    exec.mockResolvedValue({ exit_code: 0, stdout: `__origin=${REMOTE}\n__head=${SHA}\n`, stderr: "", ms: 1 });
    await resetSiteRepo("sbx", REMOTE, SHA, "ghp_site_token_value");
    const [, cmd, , opts] = exec.mock.calls[0] as [string, string, number, { env?: Record<string, string>; redact?: string[] }];
    expect(cmd).toContain('"https://x-access-token:$SITE_GIT_TOKEN@github.com/Praxis-build/acme-1a2b3c4d-abcdef.git"');
    expect(cmd).not.toContain("$GITHUB_TOKEN");
    expect(cmd).not.toContain("ghp_site_token_value");
    expect(opts).toEqual({ env: { SITE_GIT_TOKEN: "ghp_site_token_value" }, redact: ["ghp_site_token_value"] });
  });

  it("a concurrent run that already revoked the shared token cannot leave git with an empty credential", async () => {
    const work = mkdtempSync(join(tmpdir(), "site-reset-"));
    try {
      const bin = join(work, "bin");
      const repoDir = join(work, "repo");
      const envFile = join(work, "praxis-env");
      const seen = join(work, "remote-url");
      mkdirSync(bin);
      writeFileSync(envFile, "NODE_OPTIONS=--max-old-space-size=4096\n");
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/bash",
          `case "$1 $2" in`,
          `  "remote get-url") [ -f "${seen}" ] && cat "${seen}" || exit 2 ;;`,
          `  "remote add"|"remote set-url") printf '%s' "$4" > "${seen}"; printf '%s\\n' "$4" >> "${seen}.log" ;;`,
          `  "rev-parse HEAD") echo ${SHA} ;;`,
          "esac",
          "exit 0",
        ].join("\n"),
      );
      chmodSync(join(bin, "git"), 0o755);
      const runLikeE2b = (cmd: string, env: Record<string, string>) =>
        execFileSync("/bin/bash", ["-c", `set -e; [ -f ${envFile} ] && set -a && . ${envFile} && set +a; (\n${cmd.split("/home/user/repo").join(repoDir)}\n)`], {
          env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
        }).toString();
      exec.mockImplementation(async (_id: string, cmd: string, _t: number, opts?: { env?: Record<string, string> }) => ({
        exit_code: 0,
        stdout: runLikeE2b(cmd, opts?.env ?? {}),
        stderr: "",
        ms: 1,
      }));
      await resetSiteRepo("sbx", REMOTE, SHA, "ghp_site_token_value");
      expect(readFileSync(`${seen}.log`, "utf8").split("\n")[0]).toBe(
        "https://x-access-token:ghp_site_token_value@github.com/Praxis-build/acme-1a2b3c4d-abcdef.git",
      );
      expect(readFileSync(seen, "utf8")).toBe(REMOTE);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("puts the credential-free origin back even when the fetch fails (real git, offline)", async () => {
    const work = mkdtempSync(join(tmpdir(), "site-reset-fail-"));
    try {
      const repoDir = join(work, "repo");
      mkdirSync(repoDir);
      let cmd = "";
      exec.mockImplementation(async (_id: string, c: string) => {
        cmd = c;
        return { exit_code: 1, stdout: "", stderr: "fatal", ms: 1 };
      });
      await expect(resetSiteRepo("sbx", REMOTE, SHA, "ghp_fail_token")).rejects.toThrow(/exit 1/);
      let failed = false;
      try {
        execFileSync("/bin/bash", ["-c", `set -e; (\n${cmd.split("/home/user/repo").join(repoDir)}\n)`], {
          env: {
            PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            HOME: work,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            SITE_GIT_TOKEN: "ghp_fail_token",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `url.${join(work, "missing.git")}.insteadOf`,
            GIT_CONFIG_VALUE_0: "https://x-access-token:ghp_fail_token@github.com/Praxis-build/acme-1a2b3c4d-abcdef.git",
          },
          stdio: "pipe",
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoDir }).toString().trim();
      expect(origin).toBe(REMOTE);
      expect(readFileSync(join(repoDir, ".git", "config"), "utf8")).not.toContain("ghp_fail_token");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  describe("the baked-deps stamp riding the reset's own exec", () => {
    function fakeTree(opts: { wired?: boolean } = {}) {
      const work = mkdtempSync(join(tmpdir(), "site-stamp-"));
      const bin = join(work, "bin");
      const repoDir = join(work, "repo");
      const seen = join(work, "remote-url");
      mkdirSync(bin);
      mkdirSync(join(repoDir, "node_modules"), { recursive: true });
      writeFileSync(join(repoDir, "package-lock.json"), '{"lockfileVersion":3}\n');
      if (opts.wired) writeFileSync(seen, "https://github.com/someone/else.git");
      writeFileSync(
        join(bin, "git"),
        [
          "#!/bin/bash",
          `case "$1 $2" in`,
          `  "remote get-url") [ -f "${seen}" ] && cat "${seen}" || exit 2 ;;`,
          `  "remote add"|"remote set-url") printf '%s' "$4" | sed -E 's#https://[^@]*@#https://#' > "${seen}" ;;`,
          `  "rev-parse HEAD") echo ${SHA} ;;`,
          "esac",
          "exit 0",
        ].join("\n"),
      );
      chmodSync(join(bin, "git"), 0o755);
      exec.mockImplementation(async (_id: string, cmd: string, _t: number, o?: { env?: Record<string, string> }) => ({
        exit_code: 0,
        stdout: execFileSync("/bin/bash", ["-c", `set -e; (\n${cmd.split("/home/user/repo").join(repoDir)}\n)`], {
          env: { PATH: `${bin}:/usr/bin:/bin`, ...(o?.env ?? {}) },
        }).toString(),
        stderr: "",
        ms: 1,
      }));
      return { work, repoDir, seen };
    }

    it("stamps the untouched baked tree BEFORE origin is added, in the same exec as the reset", async () => {
      const t = fakeTree();
      try {
        await resetSiteRepo("sbx", REMOTE, SHA, null, { before: STAMP_BAKED_DEPS_CMD });
        expect(exec).toHaveBeenCalledTimes(1);
        const lock = readFileSync(join(t.repoDir, "node_modules", ".zavi-lock"), "utf8").trim();
        const want = execFileSync("/bin/bash", ["-c", `(sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40`], { cwd: t.repoDir }).toString().trim();
        expect(lock).toBe(want);
        expect(readFileSync(t.seen, "utf8")).toBe(REMOTE);
      } finally {
        rmSync(t.work, { recursive: true, force: true });
      }
    });

    it("never stamps a tree that already has an origin", async () => {
      const t = fakeTree({ wired: true });
      try {
        await resetSiteRepo("sbx", REMOTE, SHA, null, { before: STAMP_BAKED_DEPS_CMD });
        expect(() => readFileSync(join(t.repoDir, "node_modules", ".zavi-lock"))).toThrow();
      } finally {
        rmSync(t.work, { recursive: true, force: true });
      }
    });

    it("a failing stamp (under set -e) never fails or skips the reset", async () => {
      const t = fakeTree();
      try {
        await expect(resetSiteRepo("sbx", REMOTE, SHA, null, { before: "echo noisy; exit 7" })).resolves.toBeUndefined();
        expect(readFileSync(t.seen, "utf8")).toBe(REMOTE);
        const out = await exec.mock.results[0].value as { stdout: string };
        expect(out.stdout).not.toContain("noisy");
      } finally {
        rmSync(t.work, { recursive: true, force: true });
      }
    });
  });
});
