
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { safeResolve } from "./deterministic";
import {
  buildOracleCommand,
  readFileAtSha,
  type Materialization,
} from "./materialize-repo";
import type {
  DeterministicResult,
  ProducedDiff,
  ProducedFileChange,
  RealRepoTask,
} from "./types";

const OUTPUT_TAIL_CHARS = 2000;
const TEST_TIMEOUT_MS = 300_000;

export function scoreRealRepo(
  task: RealRepoTask,
  diff: ProducedDiff,
  m: Materialization,
): DeterministicResult {
  const base: DeterministicResult = {
    task_id: task.task_id,
    tests_green: false,
    typecheck_ok: null,
    touched: [],
    out_of_scope: [],
    output_tail: "",
    failure_kind: null,
    attempts: diff.attempts,
    error_detail: diff.error_detail,
  };

  if (diff.error_kind === "transient") {
    return {
      ...base,
      error: `transient run error after ${diff.attempts ?? "?"} attempt(s): ${diff.error_detail ?? "unknown"}`,
      failure_kind: "infra",
    };
  }
  if (!diff.files || diff.files.length === 0) {
    return {
      ...base,
      error: "engineer produced no files",
      failure_kind: "nofix",
    };
  }

  try {
    const touched: string[] = [];
    for (const f of diff.files) {
      if (task.oracle_test_files.includes(f.path)) {
        return {
          ...base,
          touched,
          error: `engineer attempted to modify the oracle test file ${f.path} — rejected (test-gaming guard)`,
        };
      }
      const applied = applyChange(m.repoDir, f);
      if (applied.error) return { ...base, touched, error: applied.error };
      touched.push(f.path);
    }

    const expected = new Set(task.expected_touch);
    const out_of_scope = touched.filter((t) => !expected.has(t));

    const overlay = reoverlayOracle(m.repoDir, task.head_sha, task.oracle_test_files);
    if (overlay.error) {
      return {
        ...base,
        touched,
        out_of_scope,
        error: overlay.error,
        failure_kind: "infra",
      };
    }

    const cmd = buildOracleCommand(task, m.backendDir, m.repoDir);
    const testRun = runShell(cmd, m.backendDir);
    const tests_green = testRun.status === 0;
    const output_tail = tail(testRun.combined, OUTPUT_TAIL_CHARS);

    return {
      ...base,
      tests_green,
      typecheck_ok: null,
      touched,
      out_of_scope,
      output_tail,
    };
  } catch (e) {
    return { ...base, error: `real-repo scorer failed: ${(e as Error).message}` };
  }
}

export function reoverlayOracle(
  repoDir: string,
  headSha: string,
  oracleTestFiles: string[],
): { error?: string } {
  for (const rel of oracleTestFiles) {
    const content = readFileAtSha(repoDir, headSha, rel);
    if (content === null) {
      return {
        error: `oracle test ${rel} not found at head_sha ${headSha} (re-overlay) — harness fault, cannot score`,
      };
    }
    const abs = safeResolve(repoDir, rel);
    if (abs === null) {
      return { error: `unsafe oracle path rejected on re-overlay: ${rel}` };
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    } catch (e) {
      return {
        error: `oracle re-overlay write failed for ${rel}: ${(e as Error).message}`,
      };
    }
  }
  return {};
}

function applyChange(
  repoDir: string,
  f: ProducedFileChange,
): { error?: string } {
  const abs = safeResolve(repoDir, f.path);
  if (abs === null) {
    return { error: `unsafe produced path rejected: ${f.path}` };
  }
  if (f.action === "delete") {
    try {
      fs.rmSync(abs, { force: true });
    } catch (e) {
      return { error: `delete failed for ${f.path}: ${(e as Error).message}` };
    }
    return {};
  }
  if (typeof f.content !== "string") {
    return { error: `${f.action} on ${f.path} missing content` };
  }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  } catch (e) {
    return { error: `write failed for ${f.path}: ${(e as Error).message}` };
  }
  return {};
}

function runShell(
  cmd: string,
  cwd: string,
): { status: number | null; combined: string } {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf-8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnvWithoutEsbuildPin(),
  });
  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status, combined };
}

function childEnvWithoutEsbuildPin(): NodeJS.ProcessEnv {
  const { ESBUILD_BINARY_PATH, ...rest } = process.env;
  return rest;
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}
