
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pristineProbeCommand } from "../tool-registry";
import { STAMP_BAKED_DEPS_CMD } from "@/services/sites/sandbox-ready";
import { buildFirstBuildInstallScript } from "@/services/build/first-build-preview";

let dir: string;

function sh(cmd: string): string {
  return execFileSync("bash", ["-c", cmd], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
}
function probe(rel: string): string {
  return sh(pristineProbeCommand(dir, `${dir}/${rel}`));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fast-build-shell-"));
  mkdirSync(join(dir, "src/pages"), { recursive: true });
  writeFileSync(join(dir, "src/pages/Home.tsx"), "export default function Home() { return null }\n");
  writeFileSync(join(dir, "src/App.tsx"), "app\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "starter");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pristineProbeCommand (create over a starter file)", () => {
  it("a tracked file with no change is pristine", () => {
    expect(probe("src/pages/Home.tsx")).toBe("pristine");
  });

  it("a file this run already changed, staged or not, is NOT pristine", () => {
    writeFileSync(join(dir, "src/App.tsx"), "app v2\n");
    expect(probe("src/App.tsx")).toBe("exists");
    git("add", "src/App.tsx");
    expect(probe("src/App.tsx")).toBe("exists");
  });

  it("an untracked file (one this run created) is NOT pristine", () => {
    writeFileSync(join(dir, "src/new.ts"), "x\n");
    expect(probe("src/new.ts")).toBe("exists");
  });

  it("a directory or a symlink is NOT pristine; an absent path is missing", () => {
    expect(probe("src/pages")).toBe("exists");
    symlinkSync(join(dir, "src/App.tsx"), join(dir, "src/link.tsx"));
    expect(probe("src/link.tsx")).toBe("exists");
    expect(probe("src/nope.tsx")).toBe("missing");
  });

  it("outside a git repo nothing is pristine (a git error refuses the write)", () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(probe("src/pages/Home.tsx")).toBe("exists");
  });

  it("a path with quotes and shell characters stays inert", () => {
    const evil = "src/a'$(touch pwned)'.ts";
    expect(probe(evil)).toBe("missing");
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });
});

describe("STAMP_BAKED_DEPS_CMD + the deps step", () => {
  const stamp = () => sh(`${STAMP_BAKED_DEPS_CMD.replace("cd /home/user/repo", `cd '${dir}'`)}; true`);
  const install = () => sh(buildFirstBuildInstallScript(dir, 5, true));

  beforeEach(() => {
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules/baked.txt"), "baked\n");
  });

  it("on the untouched baked tree, the marker lets the deps step keep node_modules (no reinstall)", () => {
    stamp();
    expect(existsSync(join(dir, "node_modules/.zavi-lock"))).toBe(true);
    expect(install()).toContain("__FBP__OK");
    expect(readFileSync(join(dir, "node_modules/baked.txt"), "utf8")).toBe("baked\n");
  });

  it("a site repo whose lock differs is still reinstalled", () => {
    stamp();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"x":{}}}\n');
    install();
    expect(existsSync(join(dir, "node_modules/baked.txt"))).toBe(false);
  });

  it("never stamps once the tree points at a site repo (origin set) or has changes", () => {
    git("remote", "add", "origin", "https://github.com/o/r.git");
    stamp();
    expect(existsSync(join(dir, "node_modules/.zavi-lock"))).toBe(false);
    git("remote", "remove", "origin");
    writeFileSync(join(dir, "src/App.tsx"), "dirty\n");
    stamp();
    expect(existsSync(join(dir, "node_modules/.zavi-lock"))).toBe(false);
  });

  it("never overwrites an existing marker", () => {
    writeFileSync(join(dir, "node_modules/.zavi-lock"), "old\n");
    stamp();
    expect(readFileSync(join(dir, "node_modules/.zavi-lock"), "utf8")).toBe("old\n");
  });
});
