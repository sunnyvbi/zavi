import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const chain = vi.hoisted(() => [] as Array<[string, unknown[]]>);
vi.mock("e2b", () => {
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, name: string) => (...args: unknown[]) => {
        chain.push([name, args]);
        return builder;
      },
    },
  );
  return {
    Template: (...args: unknown[]) => {
      chain.push(["Template", args]);
      return builder;
    },
  };
});

import { buildFirstBuildInstallScript } from "@/services/build/first-build-preview";
import { buildSharedRootInstallSnippet } from "@/services/sandbox/shared-install";
import {
  SEED_NPM_CACHE_DIRS,
  SEED_TEMPLATE_DIR,
  seedNpmCacheCommands,
  template,
} from "../../../../../../scripts/build-e2b-qa-template";

function stubNpm() {
  const bin = mkdtempSync(join(tmpdir(), "npmstub-"));
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${log}'\nmkdir -p node_modules\n`, { mode: 0o755 });
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { bin, calls };
}

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "seedrepo-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

function runBash(script: string, bin: string) {
  return execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

describe("install scripts prefer the npm cache the template seeds", () => {
  it.each([
    ["package-lock.json", "ci"],
    [null, "install"],
  ])("first-build install with lockfile=%s runs npm %s --prefer-offline", (lock, verb) => {
    const npm = stubNpm();
    const dir = repo({ "package.json": "{}", ...(lock ? { [lock]: "{}" } : {}) });
    expect(runBash(buildFirstBuildInstallScript(dir, 5), npm.bin)).toContain("__FBP__OK");
    expect(npm.calls()).toEqual([`${verb} --prefer-offline --no-audit --no-fund --silent`]);
  });

  it.each([
    ["package-lock.json", "ci"],
    [null, "install"],
  ])("shared root install with lockfile=%s runs npm %s --prefer-offline", (lock, verb) => {
    const npm = stubNpm();
    const dir = repo({ "package.json": "{}", ...(lock ? { [lock]: "{}" } : {}) });
    runBash(buildSharedRootInstallSnippet({ shared_repo: dir, install_timeout_s: 5 }), npm.bin);
    expect(npm.calls()).toEqual([`${verb} --prefer-offline --no-audit --no-fund`]);
    expect(existsSync(join(dir, "node_modules"))).toBe(true);
  });

  it("a build-run install never runs npm without a package-lock, so it cannot add one to the diff", () => {
    const npm = stubNpm();
    const dir = repo({ "package.json": "{}" });
    expect(runBash(buildFirstBuildInstallScript(dir, 5, true), npm.bin)).toContain("__FBP__NOLOCK");
    expect(npm.calls()).toEqual([]);
    expect(existsSync(join(dir, "package-lock.json"))).toBe(false);
  });

  it.each(["pnpm-lock.yaml", "yarn.lock"])("never runs npm in a %s repo", (lock) => {
    const npm = stubNpm();
    const dir = repo({ "package.json": "{}", [lock]: "" });
    expect(runBash(buildFirstBuildInstallScript(dir, 5), npm.bin)).toContain("__FBP__NOTNPM");
    expect(npm.calls()).toEqual([]);
  });

  it("an existing node_modules installed from the same lockfile skips npm entirely", () => {
    const npm = stubNpm();
    const dir = repo({ "package.json": "{}", "package-lock.json": "{}" });
    mkdirSync(join(dir, "node_modules"));
    runBash(`cd '${dir}' && (sha1sum package-lock.json 2>/dev/null || shasum package-lock.json) | cut -c1-40 > node_modules/.zavi-lock`, npm.bin);
    expect(runBash(buildFirstBuildInstallScript(dir, 5, true), npm.bin)).toContain("__FBP__OK");
    expect(npm.calls()).toEqual([]);
  });
});

describe("e2b template seeds the npm cache from the real seed lockfiles", () => {
  it("covers the base seed and every variant that ships its own lockfile", () => {
    const variants = readdirSync(join(SEED_TEMPLATE_DIR, "variants")).filter((v) =>
      existsSync(join(SEED_TEMPLATE_DIR, "variants", v, "package-lock.json")),
    );
    expect(Object.keys(SEED_NPM_CACHE_DIRS).sort()).toEqual(["files", ...variants.map((v) => `variants/${v}`)].sort());
    for (const src of Object.keys(SEED_NPM_CACHE_DIRS)) {
      const pkg = JSON.parse(readFileSync(join(SEED_TEMPLATE_DIR, src, "package.json"), "utf8"));
      const lock = JSON.parse(readFileSync(join(SEED_TEMPLATE_DIR, src, "package-lock.json"), "utf8"));
      expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    }
    expect(JSON.parse(readFileSync(join(SEED_TEMPLATE_DIR, "files", "package.json"), "utf8")).dependencies.next).toBe(
      "14.2.35",
    );
  });

  it("installs each seed with scripts off, then proves the cache alone can reinstall it offline", () => {
    const cmds = seedNpmCacheCommands();
    expect(cmds).toHaveLength(Object.keys(SEED_NPM_CACHE_DIRS).length);
    for (const [i, dest] of Object.values(SEED_NPM_CACHE_DIRS).entries()) {
      expect(cmds[i]).toMatch(new RegExp(`^cd ${dest} && npm ci --ignore-scripts .*&& rm -rf node_modules && npm ci --offline --ignore-scripts .*&& rm -rf node_modules$`));
    }
  });

  it("the template copies both files of each seed pair from the real seed dir, then runs the cache step", () => {
    expect(template).toBeDefined();
    expect(chain[0]).toEqual(["Template", [{ fileContextPath: SEED_TEMPLATE_DIR }]]);
    const names = chain.map(([n]) => n);
    const copyAt = names.indexOf("copyItems");
    const items = chain[copyAt][1][0] as Array<{ src: string; dest: string; user: string }>;
    const expected = Object.entries(SEED_NPM_CACHE_DIRS).flatMap(([from, dest]) =>
      ["package.json", "package-lock.json"].map((f) => ({ src: `${from}/${f}`, dest, user: "user" })),
    );
    expect(items).toEqual(expected);
    for (const it of items) expect(existsSync(join(SEED_TEMPLATE_DIR, it.src))).toBe(true);
    const cacheAt = chain.findIndex(([n, a]) => n === "runCmd" && JSON.stringify(a[0]) === JSON.stringify(seedNpmCacheCommands()));
    expect(cacheAt).toBeGreaterThan(copyAt);
  });
});
