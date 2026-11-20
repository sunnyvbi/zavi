import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStringSettingStrict } from "@/services/settings";
import { execCommand, writeFile } from "@/services/sandbox/e2b-client";
import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";
import { shellSingleQuote } from "@/services/sandbox/tool-registry";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { AGENT_DISPATCH_STAGES, AUTOPILOT_BUILD_STACK } from "@/services/agents/autopilot-pipeline-contract";
import {
  BUILD_REPLAY_FIXTURES,
  BUILD_REPLAY_OFF,
  BUILD_REPLAY_SETTING,
  buildReplayAllowed,
} from "@/services/agents/build-replay-config";


const REPLAY_STAGES: Record<string, string> = { spec: "pm", scaffold: "engineer", build: "engineer" };
const DEFAULT_REPO_ROOT = "/home/user/repo";
const STACK_RE = /^[a-z0-9-]{1,64}$/;

export function buildReplayFixtureRoot(): string {
  return path.join(process.cwd(), "dev-fixtures", "build-replay");
}

const fixtureFileSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["create", "modify", "delete"]),
  content: z.string().optional(),
  encoding: z.literal("base64").optional(),
});

export const buildReplayStageSchema = z.object({
  agent: z.string().min(1),
  stage: z.string().min(1),
  stack: z.string().min(1),
  source_run_id: z.string().min(1),
  output_text: z.string(),
  parsed: z.unknown(),
  files: z.array(fixtureFileSchema).default([]),
});

export type BuildReplayStage = z.infer<typeof buildReplayStageSchema>;
export type BuildReplayFile = z.infer<typeof fixtureFileSchema>;

export type BuildReplayDeps = {
  env: () => NodeJS.ProcessEnv;
  readSetting: (tenant_id: string) => Promise<string>;
  readFixture: (file: string) => Promise<string | null>;
  sandboxIdFor: (tenant_id: string, repo: string) => Promise<string | null>;
  exec: (sandbox_id: string, command: string) => Promise<{ exit_code: number; stderr: string }>;
  write: (sandbox_id: string, file: string, content: string) => Promise<void>;
  log: (line: string) => void;
};

const defaultDeps: BuildReplayDeps = {
  env: () => process.env,
  readSetting: (tenant_id) => getStringSettingStrict(BUILD_REPLAY_SETTING, tenant_id),
  readFixture: async (file) => {
    try {
      return await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  sandboxIdFor: (tenant_id, repo) => getSandboxIdForRun(tenant_id, repo),
  exec: (sandbox_id, command) => execCommand(sandbox_id, command, 30_000),
  write: (sandbox_id, file, content) => writeFile(sandbox_id, file, content),
  log: (line) => console.warn(line),
};

const replayedRuns = new WeakSet<AgentContext>();

export function wasBuildReplayed(ctx: AgentContext): boolean {
  return replayedRuns.has(ctx);
}

type ReplayPayload = {
  stage?: unknown;
  stack?: unknown;
  repair_mode?: unknown;
  refine_mode?: unknown;
  repo_hint?: unknown;
  _mt_repo_root?: unknown;
};

function replayStageOf(
  ctx: AgentContext,
  payload: unknown,
): { stage: string; stack: string; follow_up: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as ReplayPayload;
  const follow_up = p.repair_mode === true || p.refine_mode === true;
  if (typeof p.stage !== "string") return null;
  if (follow_up && (AGENT_DISPATCH_STAGES as readonly string[]).includes(p.stage) && REPLAY_STAGES[p.stage] !== ctx.agent.slug) {
    return { stage: p.stage, stack: typeof p.stack === "string" && STACK_RE.test(p.stack) ? p.stack : "unknown", follow_up };
  }
  if (REPLAY_STAGES[p.stage] !== ctx.agent.slug) return null;
  const stack = typeof p.stack === "string" ? p.stack : p.stage === "spec" ? AUTOPILOT_BUILD_STACK : null;
  if (!stack || !STACK_RE.test(stack)) {
    if (follow_up) return { stage: p.stage, stack: "unknown", follow_up };
    return null;
  }
  return { stage: p.stage, stack, follow_up };
}

export async function resolveBuildReplayFixture(
  ctx: AgentContext,
  payload: unknown,
  deps: BuildReplayDeps = defaultDeps,
): Promise<string | null> {
  if (ctx.draft_mode === true || ctx.shadow_mode === true) return null;
  if (!replayStageOf(ctx, payload)) return null;
  let value: string;
  try {
    value = (await deps.readSetting(ctx.tenant_id)).trim();
  } catch (e) {
    deps.log(`[build-replay] setting read failed, running the real model: ${(e as Error).message}`);
    return null;
  }
  if (!value || value === BUILD_REPLAY_OFF) return null;
  if (!buildReplayAllowed(deps.env())) {
    deps.log(`[build-replay] ${BUILD_REPLAY_SETTING}=${value} ignored for run ${ctx.runId}: replay never runs in production`);
    return null;
  }
  if (!(BUILD_REPLAY_FIXTURES as readonly string[]).includes(value)) {
    throw new Error(`build replay: unknown fixture "${value}"`);
  }
  return value;
}

export function repoRootFor(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_REPO_ROOT;
  const root = path.posix.normalize(raw).replace(/\/+$/, "");
  return root.startsWith("/home/user/") ? root : DEFAULT_REPO_ROOT;
}

export function safeRepoPath(root: string, file: string): string {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || file.includes("\0")) {
    throw new Error(`build replay: unsafe fixture path "${file}"`);
  }
  const full = path.posix.join(root, file);
  if (!full.startsWith(`${root}/`)) throw new Error(`build replay: unsafe fixture path "${file}"`);
  return full;
}

async function applyFiles(
  sandbox_id: string,
  root: string,
  files: BuildReplayFile[],
  deps: BuildReplayDeps,
): Promise<void> {
  const planned = files.map((f) => {
    if (f.action !== "delete" && typeof f.content !== "string") {
      throw new Error(`build replay: ${f.path} has no content`);
    }
    return { f, full: safeRepoPath(root, f.path) };
  });
  for (const { f, full } of planned) {
    if (f.action === "delete") {
      const r = await deps.exec(sandbox_id, `rm -f ${shellSingleQuote(full)}`);
      if (r.exit_code !== 0) throw new Error(`build replay: delete ${f.path} failed: ${r.stderr}`);
      continue;
    }
    const content = f.content as string;
    const dir = path.posix.dirname(full);
    const mk = await deps.exec(sandbox_id, `mkdir -p ${shellSingleQuote(dir)}`);
    if (mk.exit_code !== 0) throw new Error(`build replay: mkdir for ${f.path} failed: ${mk.stderr}`);
    if (f.encoding === "base64") {
      const tmp = `${full}.replay-b64`;
      await deps.write(sandbox_id, tmp, content);
      const r = await deps.exec(
        sandbox_id,
        `base64 -d ${shellSingleQuote(tmp)} > ${shellSingleQuote(full)} && rm -f ${shellSingleQuote(tmp)}`,
      );
      if (r.exit_code !== 0) throw new Error(`build replay: decode ${f.path} failed: ${r.stderr}`);
    } else {
      await deps.write(sandbox_id, full, content);
    }
  }
}

export async function replayBuildStage(
  ctx: AgentContext,
  payload: unknown,
  deps: BuildReplayDeps = defaultDeps,
): Promise<DispatcherResult | null> {
  const fixture = await resolveBuildReplayFixture(ctx, payload, deps);
  if (!fixture) return null;
  const { stage, stack, follow_up } = replayStageOf(ctx, payload)!;
  if (follow_up) {
    throw new Error(
      `build replay: fixture "${fixture}" is on for this tenant and has no recording for a repair or refine of ${stack}/${stage}; refusing a paid model run`,
    );
  }
  const file = path.join(buildReplayFixtureRoot(), fixture, stack, `${stage}.json`);
  const raw = await deps.readFixture(file);
  if (raw === null) {
    throw new Error(`build replay: fixture "${fixture}" has no ${stack}/${stage}.json`);
  }
  const recorded = buildReplayStageSchema.parse(JSON.parse(raw));
  if (recorded.agent !== ctx.agent.slug || recorded.stage !== stage || recorded.stack !== stack) {
    throw new Error(`build replay: ${file} records ${recorded.agent}/${recorded.stage}/${recorded.stack}`);
  }

  let parsed = recorded.parsed;
  if (ctx.agent.slug === "engineer") {
    const p = payload as ReplayPayload;
    const repo = typeof p.repo_hint === "string" ? p.repo_hint : "";
    if (!repo) throw new Error("build replay: payload.repo_hint missing");
    parsed = {
      ...(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}),
      repo,
      head_branch: `engineer/replay-${stage}-${ctx.runId.slice(0, 8)}`,
    };
    const sandbox_id = await deps.sandboxIdFor(ctx.tenant_id, repo);
    if (!sandbox_id) throw new Error(`build replay: no active sandbox for ${repo}`);
    const root = repoRootFor(p._mt_repo_root);
    await applyFiles(sandbox_id, root, recorded.files, deps);
  }

  replayedRuns.add(ctx);
  deps.log(`[build-replay] run ${ctx.runId} replayed ${fixture}/${stack}/${stage} (${recorded.files.length} files) from ${recorded.source_run_id}`);
  return {
    output_text: recorded.output_text,
    parsed,
    parse_ok: true,
    raw_response_text: recorded.output_text,
    prompt_snapshot: `build replay: ${fixture}/${stack}/${stage}`,
    usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  };
}
