
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

type AttemptScript = {
  throwName?: string;
  subtype?: string;
  is_error?: boolean;
  writeFile?: { rel: string; content: string };
};
const scripts: AttemptScript[] = [];
let queryCalls = 0;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options: { cwd: string } }) => {
    const script = scripts[queryCalls] ?? { subtype: "success" };
    queryCalls++;
    const cwd = args.options.cwd;
    return (async function* () {
      yield { type: "system" } as unknown;
      if (script.writeFile) {
        fs.writeFileSync(
          path.join(cwd, script.writeFile.rel),
          script.writeFile.content,
        );
      }
      if (script.throwName) {
        const err = new Error("boom");
        err.name = script.throwName;
        throw err;
      }
      yield {
        type: "result",
        subtype: script.subtype ?? "success",
        is_error: script.is_error ?? false,
      } as unknown;
    })();
  },
}));

import { driveEngineerRun } from "../driver";
import { scoreDeterministic } from "../deterministic";
import { buildReport } from "../report";
import { FIXTURE_REPO_PATH } from "../task-loader";
import type { EvalTask, TaskOutcome } from "../types";

const task: EvalTask = {
  task_id: "eq-driver-test",
  agent_slug: "engineer",
  bucket: "bug-fix",
  source: "synthetic",
  prompt: "fix it",
  fixture_file: "src/clamp.mjs",
  test_file: "test/clamp.test.mjs",
  pass_check: "true",
  expected_touch: ["new-fix.txt"],
  known_good_reference: "x",
};

beforeEach(() => {
  scripts.length = 0;
  queryCalls = 0;
});

const NO_BACKOFF = { maxRetries: 2, backoffMs: 0 };

describe("driveEngineerRun — clean first attempt", () => {
  it("returns error_kind=ok + attempts=1 when the first run finishes cleanly with files", async () => {
    scripts.push({ subtype: "success", writeFile: { rel: "new-fix.txt", content: "fixed\n" } });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(diff.error_kind).toBe("ok");
    expect(diff.attempts).toBe(1);
    expect(diff.files.map((f) => f.path)).toContain("new-fix.txt");
    expect(queryCalls).toBe(1);
  });
});

describe("driveEngineerRun — transient then success (the bug)", () => {
  it("RETRIES a transient error and succeeds on the 2nd attempt", async () => {
    scripts.push({ subtype: "error_during_execution", is_error: true });
    scripts.push({ subtype: "success", writeFile: { rel: "new-fix.txt", content: "fixed\n" } });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(queryCalls).toBe(2);
    expect(diff.error_kind).toBe("ok");
    expect(diff.attempts).toBe(2);
    expect(diff.files.map((f) => f.path)).toContain("new-fix.txt");
  });

  it("RETRIES a mid-stream THROW (overload) and succeeds on retry", async () => {
    scripts.push({ throwName: "APIConnectionError" });
    scripts.push({ subtype: "success", writeFile: { rel: "new-fix.txt", content: "fixed\n" } });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(queryCalls).toBe(2);
    expect(diff.error_kind).toBe("ok");
    expect(diff.files.length).toBeGreaterThan(0);
  });

  it("RETRIES a clean-but-empty run (zero files = likely swallowed transient)", async () => {
    scripts.push({ subtype: "success" });
    scripts.push({ subtype: "success", writeFile: { rel: "new-fix.txt", content: "fixed\n" } });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(queryCalls).toBe(2);
    expect(diff.files.length).toBeGreaterThan(0);
  });
});

describe("driveEngineerRun — exhausted retries", () => {
  it("marks error_kind=transient after all attempts error (infra, not engineer miss)", async () => {
    scripts.push({ subtype: "error_during_execution", is_error: true });
    scripts.push({ subtype: "error_during_execution", is_error: true });
    scripts.push({ subtype: "error_during_execution", is_error: true });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(queryCalls).toBe(3);
    expect(diff.error_kind).toBe("transient");
    expect(diff.attempts).toBe(3);
    expect(diff.files.length).toBe(0);
  });

  it("keeps error_kind=ok for a genuine no-fix after retries (real engineer miss, not infra)", async () => {
    scripts.push({ subtype: "success" });
    scripts.push({ subtype: "success" });
    scripts.push({ subtype: "success" });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(queryCalls).toBe(3);
    expect(diff.error_kind).toBe("ok");
    expect(diff.files.length).toBe(0);
  });
});

describe("driveEngineerRun — max_turns is a real outcome, not infra", () => {
  it("does NOT retry error_max_turns and reports error_kind=max_turns", async () => {
    scripts.push({ subtype: "error_max_turns", writeFile: { rel: "new-fix.txt", content: "partial\n" } });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    expect(queryCalls).toBe(1);
    expect(diff.error_kind).toBe("max_turns");
  });
});

describe("driver → deterministic → report — error-distinction wiring", () => {
  it("a transient ProducedDiff becomes failure_kind=infra and is excluded from baseline", async () => {
    scripts.push({ subtype: "error_during_execution", is_error: true });
    scripts.push({ subtype: "error_during_execution", is_error: true });
    scripts.push({ subtype: "error_during_execution", is_error: true });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    const det = scoreDeterministic(FIXTURE_REPO_PATH, task, diff);
    expect(det.failure_kind).toBe("infra");
    expect(det.tests_green).toBe(false);

    const outcomes: TaskOutcome[] = [{ task, deterministic: det, rubric: null }];
    const report = buildReport(outcomes);
    expect(report.infra_errors).toBe(1);
    expect(report.scored).toBe(0);
  });

  it("a clean zero-file ProducedDiff becomes failure_kind=nofix and counts in baseline", async () => {
    scripts.push({ subtype: "success" });
    scripts.push({ subtype: "success" });
    scripts.push({ subtype: "success" });
    const diff = await driveEngineerRun(FIXTURE_REPO_PATH, task, NO_BACKOFF);
    const det = scoreDeterministic(FIXTURE_REPO_PATH, task, diff);
    expect(det.failure_kind).toBe("nofix");

    const report = buildReport([{ task, deterministic: det, rubric: null }]);
    expect(report.infra_errors).toBe(0);
    expect(report.scored).toBe(1);
    expect(report.merge_equivalent_pct).toBe(0);
  });
});
