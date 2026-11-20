
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  realRepoTaskSchema,
  realRepoTasksFileSchema,
  type RealRepoTask,
} from "../types";
import { parseRealRepoTasks, toEvalTask } from "../real-repo-loader";
import { buildOracleCommand } from "../materialize-repo";
import { scoreRealRepo, reoverlayOracle } from "../real-repo-scorer";
import type { Materialization } from "../materialize-repo";
import type { ProducedDiff } from "../types";

const sampleRealTask: RealRepoTask = {
  task_id: "rr-sample-abc1234",
  agent_slug: "engineer",
  bucket: "bug-fix",
  source: "real-praxis-commit abc1234de",
  prompt: "There is a bug exercised by the test. Make it pass.",
  base_sha: "0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  head_sha: "1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  oracle_test_files: ["apps/backend/src/services/foo/__tests__/foo.test.ts"],
  expected_touch: ["apps/backend/src/services/foo/foo.ts"],
  known_good_reference: "fix(foo): handle the empty case",
};

describe("realRepoTaskSchema", () => {
  it("accepts a well-formed task", () => {
    expect(realRepoTaskSchema.safeParse(sampleRealTask).success).toBe(true);
  });
  it("rejects a too-short sha", () => {
    const bad = { ...sampleRealTask, base_sha: "abc" };
    expect(realRepoTaskSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects an empty oracle_test_files", () => {
    const bad = { ...sampleRealTask, oracle_test_files: [] };
    expect(realRepoTaskSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a non-engineer agent_slug", () => {
    const bad = { ...sampleRealTask, agent_slug: "qa" };
    expect(realRepoTaskSchema.safeParse(bad).success).toBe(false);
  });
});

describe("realRepoTasksFileSchema", () => {
  it("rejects an empty array", () => {
    expect(realRepoTasksFileSchema.safeParse([]).success).toBe(false);
  });
});

describe("parseRealRepoTasks", () => {
  it("rejects invalid JSON", () => {
    expect(() => parseRealRepoTasks("{not json")).toThrow(/not valid JSON/);
  });
  it("rejects a duplicate task_id", () => {
    const dup = JSON.stringify([sampleRealTask, { ...sampleRealTask }]);
    expect(() => parseRealRepoTasks(dup)).toThrow(/duplicate task_id/);
  });
  it("accepts a valid single task", () => {
    const tasks = parseRealRepoTasks(JSON.stringify([sampleRealTask]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_id).toBe("rr-sample-abc1234");
  });
});

describe("toEvalTask (RealRepoTask → EvalTask adapter)", () => {
  it("carries the shared fields the driver + rubric read", () => {
    const ev = toEvalTask(sampleRealTask);
    expect(ev.task_id).toBe(sampleRealTask.task_id);
    expect(ev.bucket).toBe("bug-fix");
    expect(ev.prompt).toBe(sampleRealTask.prompt);
    expect(ev.expected_touch).toEqual(sampleRealTask.expected_touch);
    expect(ev.known_good_reference).toBe(sampleRealTask.known_good_reference);
  });
  it("synthesizes fixture_file/test_file from the real-repo fields", () => {
    const ev = toEvalTask(sampleRealTask);
    expect(ev.fixture_file).toBe(sampleRealTask.expected_touch[0]);
    expect(ev.test_file).toBe(sampleRealTask.oracle_test_files[0]);
  });
  it("NEVER leaks the fix into the prompt (prompt is the curated stripped one)", () => {
    const ev = toEvalTask(sampleRealTask);
    expect(ev.prompt).not.toContain("handle the empty case");
  });
});

describe("buildOracleCommand", () => {
  it("builds a vitest run of the oracle file(s) relative to the backend dir", () => {
    const repoDir = "/tmp/eq-wt";
    const backendDir = path.join(repoDir, "apps", "backend");
    const cmd = buildOracleCommand(sampleRealTask, backendDir, repoDir);
    expect(cmd).toContain("npx --no-install vitest run");
    expect(cmd).toContain("src/services/foo/__tests__/foo.test.ts");
    expect(cmd).not.toContain("apps/backend/src");
  });
  it("handles multiple oracle files", () => {
    const repoDir = "/tmp/eq-wt";
    const backendDir = path.join(repoDir, "apps", "backend");
    const task = {
      ...sampleRealTask,
      oracle_test_files: [
        "apps/backend/src/a/__tests__/a.test.ts",
        "apps/backend/src/b/__tests__/b.test.ts",
      ],
    };
    const cmd = buildOracleCommand(task, backendDir, repoDir);
    expect(cmd).toContain("src/a/__tests__/a.test.ts");
    expect(cmd).toContain("src/b/__tests__/b.test.ts");
  });
});

describe("scoreRealRepo — guards (no real materialization)", () => {
  const fakeM: Materialization = {
    repoDir: "/tmp/does-not-exist-eq",
    backendDir: "/tmp/does-not-exist-eq/apps/backend",
    nodeModulesFromCache: true,
    worktreePath: "/tmp/does-not-exist-eq",
  };

  it("classifies a transient ProducedDiff as failure_kind=infra (excluded from baseline)", () => {
    const diff: ProducedDiff = {
      task_id: sampleRealTask.task_id,
      files: [],
      error_kind: "transient",
      attempts: 3,
      error_detail: "overload",
    };
    const res = scoreRealRepo(sampleRealTask, diff, fakeM);
    expect(res.failure_kind).toBe("infra");
    expect(res.tests_green).toBe(false);
  });

  it("classifies a clean zero-file ProducedDiff as failure_kind=nofix (counts)", () => {
    const diff: ProducedDiff = {
      task_id: sampleRealTask.task_id,
      files: [],
      error_kind: "ok",
      attempts: 3,
    };
    const res = scoreRealRepo(sampleRealTask, diff, fakeM);
    expect(res.failure_kind).toBe("nofix");
  });

  it("REJECTS a diff that modifies the oracle test file (test-gaming guard)", () => {
    const diff: ProducedDiff = {
      task_id: sampleRealTask.task_id,
      files: [
        {
          path: sampleRealTask.oracle_test_files[0],
          action: "modify",
          content: "// gamed",
        },
      ],
      error_kind: "ok",
      attempts: 1,
    };
    const res = scoreRealRepo(sampleRealTask, diff, fakeM);
    expect(res.error).toMatch(/oracle test file/);
    expect(res.tests_green).toBe(false);
  });

  it("REJECTS an unsafe produced path before touching the FS", () => {
    const diff: ProducedDiff = {
      task_id: sampleRealTask.task_id,
      files: [{ path: "../../escape.ts", action: "create", content: "x" }],
      error_kind: "ok",
      attempts: 1,
    };
    const res = scoreRealRepo(sampleRealTask, diff, fakeM);
    expect(res.error).toMatch(/unsafe produced path/);
  });
});

describe("reoverlayOracle — oracle survives resetWorktree in HEAD form", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
      }
    }
  });

  function g(cwd: string, args: string[]): void {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  }

  function buildFixtureRepo(opts: { oracleTrackedAtBase: boolean }): {
    repoDir: string;
    baseSha: string;
    headSha: string;
    oracleRel: string;
    headOracleContent: string;
  } {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "eq-reoverlay-test-"));
    tmpDirs.push(repoDir);
    g(repoDir, ["init", "-q"]);
    g(repoDir, ["config", "user.email", "eval@test.local"]);
    g(repoDir, ["config", "user.name", "Eval Test"]);

    const oracleRel = "oracle.test.ts";
    const headOracleContent = "// HEAD oracle — the correct grader\nexport const ORACLE = 'head';\n";

    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const v = 0; // buggy base\n");
    if (opts.oracleTrackedAtBase) {
      fs.writeFileSync(path.join(repoDir, oracleRel), "// STALE base oracle\nexport const ORACLE = 'base';\n");
    }
    g(repoDir, ["add", "-A"]);
    g(repoDir, ["commit", "-q", "-m", "base"]);
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).stdout.trim();

    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const v = 1; // fixed\n");
    fs.writeFileSync(path.join(repoDir, oracleRel), headOracleContent);
    g(repoDir, ["add", "-A"]);
    g(repoDir, ["commit", "-q", "-m", "head: fix + oracle"]);
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).stdout.trim();

    g(repoDir, ["checkout", "-q", baseSha]);
    fs.writeFileSync(path.join(repoDir, oracleRel), headOracleContent);
    fs.writeFileSync(path.join(repoDir, "src.ts"), "export const v = 1; // engineer's edit\n");

    return { repoDir, baseSha, headSha, oracleRel, headOracleContent };
  }

  function resetWorktree(dir: string): void {
    spawnSync("git", ["checkout", "--", "."], { cwd: dir, encoding: "utf-8" });
    spawnSync("git", ["clean", "-fdq", "--exclude=node_modules"], { cwd: dir, encoding: "utf-8" });
  }

  it("NEW-at-base oracle: git clean DELETES the overlay; re-overlay restores HEAD form", () => {
    const fx = buildFixtureRepo({ oracleTrackedAtBase: false });
    const oracleAbs = path.join(fx.repoDir, fx.oracleRel);

    expect(fs.existsSync(oracleAbs)).toBe(true);

    resetWorktree(fx.repoDir);
    expect(fs.existsSync(oracleAbs)).toBe(false);

    const res = reoverlayOracle(fx.repoDir, fx.headSha, [fx.oracleRel]);
    expect(res.error).toBeUndefined();
    expect(fs.existsSync(oracleAbs)).toBe(true);
    expect(fs.readFileSync(oracleAbs, "utf-8")).toBe(fx.headOracleContent);
  });

  it("TRACKED-at-base oracle: git checkout REVERTS to stale base; re-overlay restores HEAD form", () => {
    const fx = buildFixtureRepo({ oracleTrackedAtBase: true });
    const oracleAbs = path.join(fx.repoDir, fx.oracleRel);

    resetWorktree(fx.repoDir);
    expect(fs.existsSync(oracleAbs)).toBe(true);
    expect(fs.readFileSync(oracleAbs, "utf-8")).toContain("STALE base oracle");

    const res = reoverlayOracle(fx.repoDir, fx.headSha, [fx.oracleRel]);
    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(oracleAbs, "utf-8")).toBe(fx.headOracleContent);
  });

  it("returns an infra error (not a silent miss) if the oracle is absent at head_sha", () => {
    const fx = buildFixtureRepo({ oracleTrackedAtBase: false });
    const res = reoverlayOracle(fx.repoDir, fx.headSha, ["does/not/exist.test.ts"]);
    expect(res.error).toMatch(/not found at head_sha/);
  });
});
