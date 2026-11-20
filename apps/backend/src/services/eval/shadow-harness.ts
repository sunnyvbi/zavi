
import { execFileSync } from "node:child_process";
import type { Provider } from "@/services/llm/models";
import { classifyProviderError } from "@/services/llm/provider-errors";
import type { ToolCallTrace } from "@/services/tools/types";

export class HarnessFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessFailure";
  }
}

const MODEL_BEHAVIOR_ERROR_NAMES = new Set([
  "ModelBehaviorError",
  "InvalidToolInputError",
  "ToolCallError",
  "MaxTurnsExceededError",
  "OutputGuardrailTripwireTriggered",
  "InputGuardrailTripwireTriggered",
]);

const DEFINITE_HARNESS_PATTERNS = [
  "require() of es module",
  "err_require_esm",
  "cannot find module",
  "module_not_found",
  "enoent",
  "tsconfig",
];

export type FailureOrigin = "model" | "harness" | "unknown";

export function classifyFailureOrigin(
  err: unknown,
  provider: Provider,
): FailureOrigin {
  if (err instanceof HarnessFailure) return "harness";
  const name = (err as { name?: string } | null)?.name ?? "";
  if (MODEL_BEHAVIOR_ERROR_NAMES.has(name)) return "model";

  const msg = ((err as Error | null)?.message ?? String(err)).toLowerCase();
  if (DEFINITE_HARNESS_PATTERNS.some((p) => msg.includes(p))) return "harness";

  const { kind } = classifyProviderError(err, provider);
  switch (kind) {
    case "request_failed":
    case "context_length":
      return "model";
    case "authentication":
    case "credits_exhausted":
    case "endpoint_not_found":
      return "harness";
    case "rate_limit":
    case "server_error":
    case "network_error":
    default:
      return "unknown";
  }
}

let _harnessSha: string | null = null;

export function resolveHarnessSha(): string {
  if (_harnessSha !== null) return _harnessSha;
  const fromEnv =
    process.env.PRAXIS_BUILD_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA;
  if (fromEnv) return (_harnessSha = fromEnv.trim());
  try {
    _harnessSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.warn(
      "WARNING: could not resolve the harness build SHA (no .git, and none of " +
        "PRAXIS_BUILD_SHA / GIT_COMMIT_SHA / GITHUB_SHA is set). Results will " +
        'stamp harness_sha="unknown". Set PRAXIS_BUILD_SHA.',
    );
    _harnessSha = "unknown";
  }
  return _harnessSha;
}

export type SelfTestTarget = {
  label: string;
  baseURL: string;
  apiKey: string;
  model: string;
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  meter?: (label: string) => (billedUsd: number | undefined) => void;
};

export async function preflightInstrumentSelfTest(
  t: SelfTestTarget,
): Promise<void> {
  const doFetch = t.fetchImpl ?? fetch;
  const post = async (label: string, body: Record<string, unknown>) => {
    const settle = t.meter?.(`selftest:${t.label}:${label}`);
    let billed: number | undefined;
    let res: Response;
    let text = "";
    try {
      res = await doFetch(`${t.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: t.model,
          max_tokens: 32,
          ...(t.extraBody ?? {}),
          ...body,
        }),
      });
      text = await res.text();
      try {
        const cost = (JSON.parse(text) as { usage?: { cost?: unknown } })?.usage?.cost;
        if (typeof cost === "number") billed = cost;
      } catch {
      }
    } finally {
      settle?.(billed);
    }
    if (!res.ok) {
      throw new HarnessFailure(
        `instrument self-test FAILED (${label}) for ${t.label}/${t.model}: ` +
          `HTTP ${res.status} ${text.slice(0, 400)}`,
      );
    }
  };

  await post("tools+response_format", {
    messages: [{ role: "user", content: 'Return {"ok":true}' }],
    tools: [
      {
        type: "function",
        function: {
          name: "noop",
          description: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "r",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
  });

  await post("assistant-block-array", {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "continue" },
    ],
  });
}

export function parsePromptSnapshot(
  s: string | null | undefined,
  isChat: boolean,
): { system: string; initial_user: string } | null {
  if (!s) return null;
  const SM = "--- system ---\n";
  const UM = "\n\n--- initial user ---\n";
  if (!s.startsWith(SM)) return null;
  const rest = s.slice(SM.length);
  const first = rest.indexOf(UM);
  const last = rest.lastIndexOf(UM);
  if (first < 0) {
    return isChat ? { system: rest, initial_user: "" } : null;
  }
  if (first !== last) return null;
  const system = rest.slice(0, first);
  const initial_user = rest.slice(first + UM.length);
  if (!isChat && !initial_user.trim()) return null;
  return { system, initial_user };
}

export const EVIDENCE_PER_TOOL_CAP = 6000;
export const EVIDENCE_TOTAL_CAP = 48_000;
export function buildEvidencePacket(toolCalls: ToolCallTrace[]): string {
  const traces = (toolCalls || []).filter((t) => t && t.name);
  if (!traces.length) return "";
  const blocks: string[] = [];
  let used = 0;
  for (const t of traces) {
    const block = `### ${t.name}(${(t.input_preview ?? "").slice(0, 400)})\n${(t.output_preview ?? "").slice(0, EVIDENCE_PER_TOOL_CAP)}`;
    if (used + block.length > EVIDENCE_TOTAL_CAP) break;
    blocks.push(block);
    used += block.length;
  }
  if (!blocks.length) return "";
  return (
    "\n\n## EVIDENCE — results from the tools the original run already executed. " +
    "Answer using THESE; you do NOT need to call any tools.\n" +
    blocks.join("\n\n") +
    "\n"
  );
}

export function isPinnedSha(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

export type BenchSandboxDeps = {
  createShadowSandboxForRun: (a: {
    run_id: string;
    tenant_id: string;
    payload: unknown;
  }) => Promise<{ sandbox_id: string; repo_full_name: string }>;
  destroyShadowSandbox: (id: string | null | undefined) => Promise<void>;
  execCommand: (
    sandbox_id: string,
    cmd: string,
    timeoutMs?: number,
  ) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
  revokeSandboxGithubToken: (sandbox_id: string) => Promise<void>;
};

export async function withBenchSandbox<T>(
  deps: BenchSandboxDeps,
  args: { run_id: string; tenant_id: string; payload: unknown; pinned_sha: string },
  fn: (handle: { sandbox_id: string; repo_full_name: string }) => Promise<T>,
): Promise<T> {
  if (!isPinnedSha(args.pinned_sha)) {
    throw new HarnessFailure(
      `bench sandbox: pinned_sha must be a 40-hex commit sha, got ${JSON.stringify(args.pinned_sha)}`,
    );
  }
  let sandboxId: string | undefined;
  try {
    let handle: { sandbox_id: string; repo_full_name: string };
    try {
      handle = await deps.createShadowSandboxForRun({
        run_id: args.run_id,
        tenant_id: args.tenant_id,
        payload: args.payload,
      });
    } catch (e) {
      const halfCreated = (e as { sandbox_id?: string }).sandbox_id;
      if (halfCreated) sandboxId = halfCreated;
      throw new HarnessFailure(`bench sandbox provision failed: ${(e as Error).message}`);
    }
    sandboxId = handle.sandbox_id;
    const co = await deps.execCommand(
      handle.sandbox_id,
      `cd /home/user/repo && git fetch --quiet origin ${args.pinned_sha} && git checkout --quiet --detach ${args.pinned_sha} && git rev-parse HEAD`,
      120_000,
    );
    if (co.exit_code !== 0 || !co.stdout.includes(args.pinned_sha)) {
      throw new HarnessFailure(
        `bench sandbox: could not check out pinned sha ${args.pinned_sha}: ${co.stderr.slice(0, 300)}`,
      );
    }
    await deps.revokeSandboxGithubToken(handle.sandbox_id);
    return await fn(handle);
  } finally {
    await deps.destroyShadowSandbox(sandboxId);
  }
}
