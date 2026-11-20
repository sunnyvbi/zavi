
import type { EngineerEffort } from "@/services/agents/engineer-cost-v2";
import { MODELS } from "@/services/llm/models";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeBinary } from "@/services/agents/generic-dispatcher";
import { withAgentSdkIsolation } from "@/services/agents/sdk-isolation";
import { SDK_03_NEW_BUILTINS } from "@/services/agents/sdk-builtins";
import {
  buildAgentChildEnv,
  benchSeatForLimit,
  nextStartOffset,
  resolveAttemptTokens,
  resolveOAuthTokenPool,
} from "@/services/agents/agent-auth";
import { isProviderCapNotice, isUsageLimitError } from "@/services/agents/infra-retry";

const SEAT_BUSY_RE = /\b(429|529)\b|rate.?limit|overloaded/i;

export type ClaudeOneShotResult = { text: string; cost_usd: number };

export type OneShotAttemptTiming = {
  attempt: number;
  ms: number;
  outcome: "ok" | "rate_limited" | "overloaded" | "usage_limited" | "timeout" | "cancelled" | "error";
  promptChars: number;
  apiMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};
type AttemptUsage = Pick<OneShotAttemptTiming, "apiMs" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

function attemptUsage(result: { duration_api_ms?: unknown; usage?: unknown }): AttemptUsage {
  const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
  const out: AttemptUsage = {};
  for (const [key, value] of [
    ["apiMs", result.duration_api_ms], ["inputTokens", usage.input_tokens], ["outputTokens", usage.output_tokens],
    ["cacheReadTokens", usage.cache_read_input_tokens], ["cacheWriteTokens", usage.cache_creation_input_tokens],
  ] as const) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

type Credential = { kind: "api_key" } | { kind: "oauth"; token: string };

export function oneShotCredentials(env: NodeJS.ProcessEnv = process.env): Credential[] {
  if (env.ANTHROPIC_API_KEY) return [{ kind: "api_key" }];
  const pool = resolveOAuthTokenPool(env);
  if (pool.length === 0) return [];
  return resolveAttemptTokens({ pool, preferApiKey: false, startOffset: nextStartOffset(pool.length) })
    .filter((t): t is string => Boolean(t))
    .map((token) => ({ kind: "oauth" as const, token }));
}

async function attempt(
  cred: Credential,
  opts: { model: string; system: string; user: string; effort?: EngineerEffort },
  abort: AbortController,
  measured: (usage: AttemptUsage) => void,
): Promise<ClaudeOneShotResult> {
  const env: NodeJS.ProcessEnv =
    cred.kind === "oauth"
      ? buildAgentChildEnv({ mode: "oauth", oauthToken: cred.token })
      : buildAgentChildEnv({ mode: "api_key", apiKey: process.env.ANTHROPIC_API_KEY });
  const stream = query({
    prompt: opts.user,
    options: withAgentSdkIsolation({
      systemPrompt: opts.system,
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort } : opts.model === MODELS.anthropic.opus ? { effort: "high" as const } : {}),
      maxTurns: 1,
      allowedTools: [],
      tools: [],
      disallowedTools: [
        "Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "Task", "WebFetch",
        "WebSearch", "NotebookEdit", "TodoWrite",
        ...SDK_03_NEW_BUILTINS,
      ],
      settingSources: [],
      env,
      abortController: abort,
      ...(resolveClaudeBinary() ? { pathToClaudeCodeExecutable: resolveClaudeBinary() } : {}),
    }),
  });
  let text = "";
  let cost_usd = 0;
  for await (const msg of stream) {
    const m = msg as { type?: string; subtype?: string; result?: string; total_cost_usd?: number; is_error?: boolean; duration_api_ms?: unknown; usage?: unknown };
    if (m.type === "result") {
      measured(attemptUsage(m));
      if (m.subtype !== "success" || m.is_error) {
        throw new Error(`claudeOneShot: ${m.subtype ?? "error"} ${String(m.result ?? "").slice(0, 200)}`);
      }
      text = m.result ?? "";
      cost_usd = m.total_cost_usd ?? 0;
    }
  }
  if (!text) throw new Error("claudeOneShot: empty result");
  if (isProviderCapNotice(text)) {
    throw new Error(`claudeOneShot: usage limit ${text.slice(0, 120)}`);
  }
  return { text, cost_usd };
}

export async function claudeOneShot(opts: {
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
  signal?: AbortSignal;
  effort?: EngineerEffort;
  onAttempt?: (event: OneShotAttemptTiming) => void;
}): Promise<ClaudeOneShotResult> {
  const creds = oneShotCredentials();
  if (creds.length === 0) throw new Error("claudeOneShot: no Anthropic credential available");

  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown = null;
  for (let i = 0; i < creds.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || opts.signal?.aborted) break;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    opts.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, remaining);
    const started = Date.now();
    let usage: AttemptUsage = {};
    let outcome: OneShotAttemptTiming["outcome"] = "ok";
    try {
      return await attempt(creds[i], opts, abort, measured => { usage = measured; });
    } catch (err) {
      lastErr = err;
      const cred = creds[i];
      const message = (err as Error)?.message ?? "";
      const capped = isUsageLimitError(message);
      outcome = opts.signal?.aborted ? "cancelled" : abort.signal.aborted ? "timeout" :
        capped ? "usage_limited" : /\b529\b|overloaded/i.test(message) ? "overloaded" :
        SEAT_BUSY_RE.test(message) ? "rate_limited" : "error";
      if (capped && cred.kind === "oauth") benchSeatForLimit(cred.token, message);
      if (!(capped || SEAT_BUSY_RE.test(message)) || abort.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", cancel);
      try {
        void Promise.resolve(opts.onAttempt?.({ attempt: i, ms: Math.max(0, Date.now() - started), outcome,
          promptChars: opts.system.length + opts.user.length, ...usage })).catch(() => {});
      } catch {  }
    }
  }
  throw lastErr ?? new Error("claudeOneShot: timed out before any seat answered");
}
