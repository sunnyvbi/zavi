
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_ENV = vi.hoisted(() => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
}));

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: async (_sandbox: string, cmd: string) => {
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: GIT_ENV });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exit_code: r.status ?? 1, ms: 1 };
  },
}));

import { attributeTestFailures } from "../engineer-test-baseline";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

let root: string;
let main: string;
let wt: string;

function makeBase(extra?: (dir: string) => void) {
  root = mkdtempSync(join(tmpdir(), "attr-"));
  main = join(root, "main");
  wt = join(root, "wt-run");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, ".gitignore"), "ignored/\n");
  writeFileSync(join(main, "a.txt"), "base a\n");
  writeFileSync(join(main, "b.txt"), "base b\n");
  writeFileSync(join(main, "d.txt"), "base d\n");
  writeFileSync(join(main, "tool.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(main, "tool.sh"), 0o644);
  symlinkSync("a.txt", join(main, "link"));
  extra?.(main);
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  git(main, "worktree", "add", "-q", "--detach", wt, "HEAD");
}

function agentWork() {
  writeFileSync(join(wt, "a.txt"), "agent a\n");
  rmSync(join(wt, "b.txt"));
  writeFileSync(join(wt, "c.txt"), "agent new file\n");
  writeFileSync(join(wt, "d.txt"), "agent d staged\n");
  git(wt, "add", "d.txt");
  chmodSync(join(wt, "tool.sh"), 0o755);
  rmSync(join(wt, "link"));
  symlinkSync("c.txt", join(wt, "link"));
  mkdirSync(join(wt, "ignored"));
  writeFileSync(join(wt, "ignored", "keep.txt"), "warm\n");
}

beforeEach(() => {
  makeBase();
  agentWork();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const BASE_RUN =
  "echo trampled >> a.txt; echo stray > stray.txt; echo 'FAILED a::1 - boom'; exit 1";

function expectAgentTreeBack() {
  expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("agent a\n");
  expect(existsSync(join(wt, "b.txt"))).toBe(false);
  expect(readFileSync(join(wt, "c.txt"), "utf8")).toBe("agent new file\n");
  expect(readFileSync(join(wt, "d.txt"), "utf8")).toBe("agent d staged\n");
  expect(existsSync(join(wt, "stray.txt"))).toBe(false);
  expect(statSync(join(wt, "tool.sh")).mode & 0o111).not.toBe(0);
  expect(lstatSync(join(wt, "link")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(wt, "link"))).toBe("c.txt");
  expect(readFileSync(join(wt, "ignored", "keep.txt"), "utf8")).toBe("warm\n");
  const status = git(wt, "status", "--porcelain").split("\n").filter(Boolean).sort();
  expect(status).toEqual([" D b.txt", " M a.txt", " M link", " M tool.sh", "?? c.txt", "M  d.txt"]);
}

const run = (command: string, head_failures: string[]) =>
  attributeTestFailures({
    sandbox_id: "local" as never,
    worktree_path: wt,
    command,
    head_failures,
    head_confidence: "high",
  });

describe("attributeTestFailures against a real linked worktree", () => {
  it("attributes correctly, puts the agent's whole tree back, and leaves no temp dir", async () => {
    const tempDirs = () =>
      spawnSync("bash", ["-c", "ls -d /tmp/zavi-attr-* 2>/dev/null | sort"], { encoding: "utf8" }).stdout;
    const before = tempDirs();
    const r = await run(BASE_RUN, ["a::1", "c::new"]);
    expect(r).toEqual({ kind: "attributed", new_failures: ["c::new"], pre_existing: ["a::1"] });
    expectAgentTreeBack();
    expect(tempDirs()).toBe(before);
  });

  it("a snapshot that fails part-way leaves no temp dir", async () => {
    const tempDirs = () =>
      spawnSync("bash", ["-c", "ls -d /tmp/zavi-attr-* 2>/dev/null | sort"], { encoding: "utf8" }).stdout;
    const before = tempDirs();
    chmodSync(join(main, ".git", "objects"), 0o555);
    try {
      const r = await run(BASE_RUN, ["a::1"]);
      expect(r.kind).toBe("unknown");
    } finally {
      chmodSync(join(main, ".git", "objects"), 0o755);
    }
    expect(tempDirs()).toBe(before);
    expect(readFileSync(join(wt, "c.txt"), "utf8")).toBe("agent new file\n");
  });

  it("the base run sees the BASE tree, not the agent's edits or new files", async () => {
    const probe = join(root, "probe.txt");
    const r = await run(`cat a.txt > ${probe}; ls c.txt >> ${probe} 2>&1; echo 'FAILED a::1 - x'; exit 1`, ["a::1"]);
    expect(r.kind).toBe("attributed");
    const seen = readFileSync(probe, "utf8");
    expect(seen).toContain("base a");
    expect(seen).toMatch(/No such file/);
    expectAgentTreeBack();
  });

  it("a base run that moves HEAD keeps the split and reports restore_failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await run("git commit -q --allow-empty -m moved; echo 'FAILED a::1 - x'; exit 1", ["a::1", "c::new"]);
    expect(r).toEqual({
      kind: "attributed",
      new_failures: ["c::new"],
      pre_existing: ["a::1"],
      restore_failed: true,
    });
  });

  it("a path that is not a git repo is refused before anything is reset", async () => {
    const notRepo = join(root, "plain");
    mkdirSync(notRepo);
    writeFileSync(join(notRepo, "keep.txt"), "keep\n");
    const r = await attributeTestFailures({
      sandbox_id: "local" as never,
      worktree_path: notRepo,
      command: "echo 'FAILED a::1 - x'; exit 1",
      head_failures: ["a::1"],
      head_confidence: "high",
    });
    expect(r.kind).toBe("unknown");
    expect(readFileSync(join(notRepo, "keep.txt"), "utf8")).toBe("keep\n");
  });
});

describe("attributeTestFailures refuses repos where a tree is not a faithful copy", () => {
  const refusesUntouched = async (why: RegExp) => {
    const before = git(wt, "status", "--porcelain");
    const r = await run(BASE_RUN, ["a::1", "c::new"]);
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") expect(r.why).toMatch(why);
    expect(git(wt, "status", "--porcelain")).toBe(before);
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("agent a\n");
    expect(readFileSync(join(wt, "c.txt"), "utf8")).toBe("agent new file\n");
  };

  it("submodules", async () => {
    writeFileSync(join(wt, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
    await refusesUntouched(/submodules/);
  });

  it("a submodule in the base commit, even after the agent deleted .gitmodules", async () => {
    rmSync(root, { recursive: true, force: true });
    makeBase((dir) => writeFileSync(join(dir, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ./x\n'));
    agentWork();
    rmSync(join(wt, ".gitmodules"));
    await refusesUntouched(/submodules/);
  });

  it("line-ending conversion", async () => {
    git(wt, "config", "core.autocrlf", "input");
    await refusesUntouched(/line endings/);
  });

  it("line-ending conversion spelled any way git accepts", async () => {
    git(wt, "config", "core.autocrlf", "TRUE");
    await refusesUntouched(/line endings/);
  });

  it("content filters (e.g. LFS)", async () => {
    writeFileSync(join(wt, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await refusesUntouched(/filters or re-encodes/);
  });
});
