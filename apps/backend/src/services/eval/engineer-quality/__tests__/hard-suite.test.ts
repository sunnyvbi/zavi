
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseTasks } from "../task-loader";
import { parseRealRepoTasks } from "../real-repo-loader";
import { HARD_TASKS_JSON_PATH, HARD_FIXTURE_REPO_PATH } from "../task-loader";
import { REAL_REPO_HARD_TASKS_JSON_PATH } from "../real-repo-loader";

const HARD_TASKS = parseTasks(fs.readFileSync(HARD_TASKS_JSON_PATH, "utf-8"));
const RR_HARD = parseRealRepoTasks(
  fs.readFileSync(REAL_REPO_HARD_TASKS_JSON_PATH, "utf-8"),
);

describe("hard suite — synthetic-hard tasks (hard-tasks.json)", () => {
  it("has a non-trivial number of tasks", () => {
    expect(HARD_TASKS.length).toBeGreaterThanOrEqual(8);
  });

  it("every task points at a real src + test file in fixtures/repo-hard", () => {
    for (const t of HARD_TASKS) {
      const src = path.join(HARD_FIXTURE_REPO_PATH, t.fixture_file);
      const test = path.join(HARD_FIXTURE_REPO_PATH, t.test_file);
      expect(fs.existsSync(src), `${t.task_id}: ${t.fixture_file} exists`).toBe(true);
      expect(fs.existsSync(test), `${t.task_id}: ${t.test_file} exists`).toBe(true);
    }
  });

  it("every task uses a behavioral node --test oracle (not a grep)", () => {
    for (const t of HARD_TASKS) {
      expect(t.pass_check).toMatch(/^node --test /);
      const testSrc = fs.readFileSync(
        path.join(HARD_FIXTURE_REPO_PATH, t.test_file),
        "utf-8",
      );
      expect(testSrc).toMatch(/from\s+["']\.\.\/src\//);
      expect(testSrc).toMatch(/assert\./);
      expect(testSrc).not.toMatch(/readFileSync/);
    }
  });

  it("the multi-file task spans >=2 expected_touch files", () => {
    const scheduler = HARD_TASKS.find((t) => t.task_id === "hard-retry-scheduler");
    expect(scheduler, "hard-retry-scheduler present").toBeTruthy();
    expect(scheduler!.expected_touch.length).toBeGreaterThanOrEqual(2);
  });

  for (const t of HARD_TASKS) {
    it(`${t.task_id} is seeded-RED (oracle fails on the buggy fixture)`, () => {
      const res = spawnSync("node", ["--test", t.test_file], {
        cwd: HARD_FIXTURE_REPO_PATH,
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(res.status, `${t.task_id} oracle should be RED on buggy code`).not.toBe(0);
      expect(`${res.stdout}${res.stderr}`).toMatch(/# tests \d+/);
    }, 35_000);
  }
});

describe("hard suite — real-repo-hard tasks (real-repo-hard-tasks.json)", () => {
  it("parses and is non-empty", () => {
    expect(RR_HARD.length).toBeGreaterThanOrEqual(3);
  });

  it("every task is MULTI-FILE (>=2 expected_touch src files) — the hardness lever", () => {
    for (const t of RR_HARD) {
      expect(
        t.expected_touch.length,
        `${t.task_id} should span >=2 src files`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("every task has a distinct base/head sha and an oracle under apps/backend/src", () => {
    for (const t of RR_HARD) {
      expect(t.base_sha).not.toBe(t.head_sha);
      for (const f of t.oracle_test_files) {
        expect(f).toMatch(/^apps\/backend\/src\/.*__tests__\/.*\.test\.ts$/);
      }
    }
  });

  it("no prompt leaks the fix (symptom-only: points at the test, paraphrases the subject)", () => {
    for (const t of RR_HARD) {
      expect(t.prompt).toMatch(/oracle test/i);
      expect(t.prompt).toMatch(/SMALLEST correct change/);
      expect(t.prompt).not.toContain("known_good_reference");
    }
  });
});
