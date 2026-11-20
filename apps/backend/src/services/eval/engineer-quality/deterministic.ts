
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DeterministicResult,
  EvalTask,
  ProducedDiff,
  ProducedFileChange,
} from "./types";

const OUTPUT_TAIL_CHARS = 2000;

export function safeResolve(copyRoot: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null;
  const abs = path.resolve(copyRoot, relPath);
  const rootWithSep = copyRoot.endsWith(path.sep) ? copyRoot : copyRoot + path.sep;
  if (abs !== copyRoot && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

function copyTree(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const base = path.basename(s);
      return base !== "node_modules" && base !== ".git";
    },
  });
}

export function scoreDeterministic(
  fixtureRepoPath: string,
  task: EvalTask,
  diff: ProducedDiff,
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

  let copyRoot = "";
  try {
    copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eq-eval-"));
    copyTree(fixtureRepoPath, copyRoot);

    const touched: string[] = [];
    for (const f of diff.files) {
      const applied = applyChange(copyRoot, f);
      if (applied.error) return { ...base, error: applied.error };
      touched.push(f.path);
    }

    const expected = new Set(task.expected_touch);
    const out_of_scope = touched.filter((t) => !expected.has(t));

    const testRun = runShell(task.pass_check, copyRoot);
    const tests_green = testRun.status === 0;
    const output_tail = tail(testRun.combined, OUTPUT_TAIL_CHARS);

    let typecheck_ok: boolean | null = null;
    if (fs.existsSync(path.join(copyRoot, "tsconfig.json"))) {
      const tc = runShell("npx --no-install tsc --noEmit -p tsconfig.json", copyRoot);
      typecheck_ok = tc.status === 0;
    }

    return {
      ...base,
      tests_green,
      typecheck_ok,
      touched,
      out_of_scope,
      output_tail,
    };
  } catch (e) {
    return { ...base, error: `deterministic scorer failed: ${(e as Error).message}` };
  } finally {
    if (copyRoot) {
      try {
        fs.rmSync(copyRoot, { recursive: true, force: true });
      } catch {
      }
    }
  }
}

function applyChange(
  copyRoot: string,
  f: ProducedFileChange,
): { error?: string } {
  const abs = safeResolve(copyRoot, f.path);
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
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status, combined };
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}
