import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCacheKey, installCacheKeyScript, restoreInstall, treeDigestScript } from "../install-cache";

const hasGnuFind = (() => {
  try {
    execFileSync("bash", ["-c", "find . -maxdepth 0 -printf '%m'"]);
    return true;
  } catch {
    return false;
  }
})();

const hasSha = (() => {
  try {
    execFileSync("bash", ["-c", "command -v sha256sum"]);
    return true;
  } catch {
    return false;
  }
})();

describe("install cache key", () => {
  it.skipIf(!hasSha)("changes with .npmrc and npm-shrinkwrap.json, not only package.json and the lockfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "zavi-key-"));
    try {
      const key = () => execFileSync("bash", ["-c", installCacheKeyScript()], { cwd: dir }).toString().trim();
      writeFileSync(join(dir, "package.json"), '{"name":"a"}');
      writeFileSync(join(dir, "package-lock.json"), "{}");
      const base = key();
      expect(base).toMatch(/^[0-9a-f]{24}$/);
      writeFileSync(join(dir, ".npmrc"), "omit=dev\n");
      const withRc = key();
      rmSync(join(dir, ".npmrc"));
      writeFileSync(join(dir, "npm-shrinkwrap.json"), "{}");
      const withShrink = key();
      rmSync(join(dir, "npm-shrinkwrap.json"));
      expect(new Set([base, withRc, withShrink]).size).toBe(3);
      expect(key()).toBe(base);
      writeFileSync(join(dir, "rc-a"), "omit=dev\n");
      writeFileSync(join(dir, "rc-b"), "legacy-peer-deps=true\n");
      symlinkSync(join(dir, "rc-a"), join(dir, ".npmrc"));
      const viaA = key();
      rmSync(join(dir, ".npmrc"));
      symlinkSync(join(dir, "rc-b"), join(dir, ".npmrc"));
      expect(key()).not.toBe(viaA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no lockfile, a bad answer or a dir outside /tmp/site-* means no cache", async () => {
    const run = async () => ({ exitCode: 0, stdout: "not-a-key\n", stderr: "" });
    expect(await installCacheKey(run as never, "/tmp/site-abc")).toBeNull();
    expect(await installCacheKey((async () => ({ exitCode: 1, stdout: "", stderr: "" })) as never, "/tmp/site-abc")).toBeNull();
    expect(await installCacheKey(run as never, "/home/user/repo")).toBeNull();
    expect(await restoreInstall(run as never, "/tmp/site-abc; rm -rf /", "0123456789abcdef01234567", "33333333-3333-4333-8333-333333333333")).toBe(false);
  });
});

describe("tree digest (what a restore must match)", () => {
  it.skipIf(!hasSha || !hasGnuFind)("changes with any file's content, mode or symlink target, and refuses a symlinked node_modules", () => {
    const base = mkdtempSync(join(tmpdir(), "zavi-tree-"));
    const other = mkdtempSync(join(tmpdir(), "zavi-elsewhere-"));
    try {
      const digest = () => execFileSync("bash", ["-c", treeDigestScript(base)]).toString().trim();
      mkdirSync(join(base, "node_modules/vite/bin"), { recursive: true });
      mkdirSync(join(base, "node_modules/.bin"), { recursive: true });
      writeFileSync(join(base, "node_modules/vite/bin/vite.js"), "console.log('vite')");
      symlinkSync("../vite/bin/vite.js", join(base, "node_modules/.bin/vite"));
      const clean = digest();
      expect(clean).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(base, "node_modules/vite/bin/vite.js"), "console.log('poisoned')");
      expect(digest()).not.toBe(clean);
      writeFileSync(join(base, "node_modules/vite/bin/vite.js"), "console.log('vite')");
      expect(digest()).toBe(clean);
      chmodSync(join(base, "node_modules/vite/bin/vite.js"), 0o600);
      expect(digest()).not.toBe(clean);
      chmodSync(join(base, "node_modules/vite/bin/vite.js"), 0o644);
      expect(digest()).toBe(clean);
      rmSync(join(base, "node_modules/.bin/vite"));
      symlinkSync("/etc/passwd", join(base, "node_modules/.bin/vite"));
      expect(digest()).not.toBe(clean);
      rmSync(join(base, "node_modules"), { recursive: true });
      mkdirSync(join(other, "node_modules"));
      symlinkSync(join(other, "node_modules"), join(base, "node_modules"));
      expect(() => digest()).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
