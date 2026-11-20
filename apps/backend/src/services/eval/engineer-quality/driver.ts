
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { withAgentSdkIsolation } from "@/services/agents/sdk-isolation";
import type {
  DriverErrorKind,
  EvalTask,
  ProducedDiff,
  ProducedFileChange,
} from "./types";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1500;

type TerminalResult = {
  subtype?: string;
  is_error?: boolean;
};

function classifyTerminal(r: TerminalResult | null): {
  kind: DriverErrorKind;
  detail: string;
} {
  if (!r) {
    return { kind: "transient", detail: "no terminal result message" };
  }
  if (r.subtype === "error_max_turns") {
    return { kind: "max_turns", detail: "error_max_turns" };
  }
  if (r.is_error === true || (r.subtype && r.subtype !== "success")) {
    return { kind: "transient", detail: r.subtype ?? "is_error" };
  }
  return { kind: "ok", detail: r.subtype ?? "success" };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const ENGINEER_AGENT_MD = path.resolve(
  __dirname,
  "../../../agents/engineer/agent.md",
);

const DRIVER_MODEL = "claude-opus-4-7";

const DRIVER_HARNESS_NOTE = `
====================  EVAL HARNESS NOTE  ====================
You are running inside a local coding-quality eval, NOT the production sandbox.
The repository is checked out at the current working directory. Use the built-in
Read / Grep / Glob / Edit / Write / Bash tools directly on these local files —
there is no e2b sandbox and no mcp__sandbox tools here.

Your job: make the SMALLEST correct change that satisfies the task below, then
run the repo's tests to confirm. Do NOT edit files unrelated to the task. Do NOT
weaken or delete existing tests. When the task's test passes, you are done.
Run tests with the command given in the task.
============================================================
`;

export function buildEngineerSystemPrompt(): string {
  let body = "";
  try {
    const raw = fs.readFileSync(ENGINEER_AGENT_MD, "utf-8");
    body = matter(raw).content.trim();
  } catch {
    body =
      "You are a senior software engineer. Make minimal, correct, well-tested code changes.";
  }
  return `${body}\n\n${DRIVER_HARNESS_NOTE}`;
}

function makeWorkingCopy(fixtureRepoPath: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eq-driver-"));
  fs.cpSync(fixtureRepoPath, dir, {
    recursive: true,
    filter: (s) => {
      const base = path.basename(s);
      return base !== "node_modules" && base !== ".git";
    },
  });
  return dir;
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.set(path.relative(root, abs), fs.readFileSync(abs, "utf-8"));
      }
    }
  };
  walk(root);
  return out;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): ProducedFileChange[] {
  const changes: ProducedFileChange[] = [];
  for (const [p, content] of after) {
    if (!before.has(p)) {
      changes.push({ path: p, action: "create", content });
    } else if (before.get(p) !== content) {
      changes.push({ path: p, action: "modify", content });
    }
  }
  for (const p of before.keys()) {
    if (!after.has(p)) changes.push({ path: p, action: "delete" });
  }
  return changes;
}

type AttemptResult = {
  files: ProducedFileChange[];
  kind: DriverErrorKind;
  detail: string;
};

async function driveOnce(
  fixtureRepoPath: string,
  task: EvalTask,
  maxTurns: number,
): Promise<AttemptResult> {
  const work = makeWorkingCopy(fixtureRepoPath);
  const before = snapshot(work);
  try {
    const systemPrompt = buildEngineerSystemPrompt();
    const userPrompt = `TASK ${task.task_id} (bucket: ${task.bucket})\n\n${task.prompt}\n\nRun the test with: ${task.pass_check}\nWhen that test passes, stop.`;

    const stream = query({
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: userPrompt },
          parent_tool_use_id: null,
          session_id: `eq-${task.task_id}`,
        };
      })(),
      options: withAgentSdkIsolation({
        systemPrompt,
        model: DRIVER_MODEL,
        cwd: work,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
        maxTurns,
      }),
    });

    let terminal: TerminalResult | null = null;
    try {
      for await (const msg of stream) {
        if ((msg as { type?: string }).type === "result") {
          terminal = msg as unknown as TerminalResult;
        }
      }
    } catch (e) {
      const after = snapshot(work);
      return {
        files: diffSnapshots(before, after),
        kind: "transient",
        detail: `stream error: ${(e as Error).name || "Error"}`,
      };
    }

    const after = snapshot(work);
    const { kind, detail } = classifyTerminal(terminal);
    return { files: diffSnapshots(before, after), kind, detail };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
    }
  }
}

async function driveOnceInDir(
  dir: string,
  task: EvalTask,
  maxTurns: number,
): Promise<AttemptResult> {
  const before = snapshot(dir);
  try {
    const systemPrompt = buildEngineerSystemPrompt();
    const userPrompt = `TASK ${task.task_id} (bucket: ${task.bucket})\n\n${task.prompt}\n\nRun the test with: ${task.pass_check}\nWhen that test passes, stop.`;

    const stream = query({
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: userPrompt },
          parent_tool_use_id: null,
          session_id: `eq-${task.task_id}`,
        };
      })(),
      options: withAgentSdkIsolation({
        systemPrompt,
        model: DRIVER_MODEL,
        cwd: dir,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
        maxTurns,
      }),
    });

    let terminal: TerminalResult | null = null;
    try {
      for await (const msg of stream) {
        if ((msg as { type?: string }).type === "result") {
          terminal = msg as unknown as TerminalResult;
        }
      }
    } catch (e) {
      const after = snapshot(dir);
      const files = diffSnapshots(before, after);
      resetWorktree(dir);
      return {
        files,
        kind: "transient",
        detail: `stream error: ${(e as Error).name || "Error"}`,
      };
    }

    const after = snapshot(dir);
    const files = diffSnapshots(before, after);
    const { kind, detail } = classifyTerminal(terminal);
    resetWorktree(dir);
    return { files, kind, detail };
  } catch (e) {
    resetWorktree(dir);
    return {
      files: [],
      kind: "transient",
      detail: `driver error: ${(e as Error).name || "Error"}`,
    };
  }
}

function resetWorktree(dir: string): void {
  try {
    spawnSync("git", ["checkout", "--", "."], { cwd: dir, encoding: "utf-8" });
    spawnSync("git", ["clean", "-fdq", "--exclude=node_modules"], {
      cwd: dir,
      encoding: "utf-8",
    });
  } catch {
  }
}

export async function driveEngineerRunInDir(
  dir: string,
  task: EvalTask,
  opts: { maxTurns?: number; maxRetries?: number; backoffMs?: number } = {},
): Promise<ProducedDiff> {
  const maxTurns = opts.maxTurns ?? 40;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const backoffMs = opts.backoffMs ?? RETRY_BASE_MS;

  const maxAttempts = 1 + maxRetries;
  let last: AttemptResult = { files: [], kind: "transient", detail: "not run" };
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0 && backoffMs > 0) await sleep(backoffMs * i);
    last = await driveOnceInDir(dir, task, maxTurns);
    attempts = i + 1;
    const transient = last.kind === "transient";
    const cleanButEmpty = last.kind === "ok" && last.files.length === 0;
    if (!transient && !cleanButEmpty) break;
  }
  return {
    task_id: task.task_id,
    files: last.files,
    error_kind: last.kind,
    attempts,
    error_detail: last.detail,
  };
}

export async function driveEngineerRun(
  fixtureRepoPath: string,
  task: EvalTask,
  opts: { maxTurns?: number; maxRetries?: number; backoffMs?: number } = {},
): Promise<ProducedDiff> {
  const maxTurns = opts.maxTurns ?? 40;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const backoffMs = opts.backoffMs ?? RETRY_BASE_MS;

  const maxAttempts = 1 + maxRetries;
  let last: AttemptResult = { files: [], kind: "transient", detail: "not run" };
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0 && backoffMs > 0) await sleep(backoffMs * i);
    last = await driveOnce(fixtureRepoPath, task, maxTurns);
    attempts = i + 1;

    const transient = last.kind === "transient";
    const cleanButEmpty = last.kind === "ok" && last.files.length === 0;
    if (!transient && !cleanButEmpty) {
      break;
    }
  }

  return {
    task_id: task.task_id,
    files: last.files,
    error_kind: last.kind,
    attempts,
    error_detail: last.detail,
  };
}

export function driverPreflight(): { ok: boolean; reason?: string } {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      ok: false,
      reason:
        "No Anthropic auth: set ANTHROPIC_API_KEY (metered) or CLAUDE_CODE_OAUTH_TOKEN (subscription) to drive live engineer runs",
    };
  }
  const node = spawnSync("node", ["--version"], { encoding: "utf-8" });
  if (node.status !== 0) return { ok: false, reason: "node not available on PATH" };
  return { ok: true };
}
