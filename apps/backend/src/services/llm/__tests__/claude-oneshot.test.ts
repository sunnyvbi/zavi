
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Scripted = { result?: string; subtype?: string; is_error?: boolean; metrics?: Record<string, unknown>; advanceMs?: number; beforeResult?: () => void } | Error;

const state = vi.hoisted(() => ({
  pool: [] as string[],
  answers: [] as Scripted[],
  seen: [] as Array<{ oauth: string | undefined; apiKey: string | undefined; pool: string | undefined }>,
  cooled: [] as string[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: { env: Record<string, string | undefined> } }) => {
    state.seen.push({
      oauth: options.env.CLAUDE_CODE_OAUTH_TOKEN,
      apiKey: options.env.ANTHROPIC_API_KEY,
      pool: options.env.CLAUDE_CODE_OAUTH_TOKENS,
    });
    const next = state.answers.shift() ?? { result: "" };
    return (async function* () {
      if (next instanceof Error) throw next;
      next.beforeResult?.();
      if (next.advanceMs) vi.advanceTimersByTime(next.advanceMs);
      yield { ...next.metrics, type: "result", subtype: next.subtype ?? "success", is_error: next.is_error ?? false, result: next.result, total_cost_usd: 0.01 };
    })();
  },
}));
vi.mock("@/services/agents/generic-dispatcher", () => ({ resolveClaudeBinary: () => null }));
vi.mock("@/services/agents/agent-auth", async () => ({
  buildAgentChildEnv: (await vi.importActual<typeof import("@/services/agents/agent-auth")>(
    "@/services/agents/agent-auth",
  )).buildAgentChildEnv,
  resolveOAuthTokenPool: () => state.pool,
  resolveAttemptTokens: ({ pool }: { pool: string[] }) => [...pool],
  nextStartOffset: () => 0,
  benchSeatForLimit: (t: string) => state.cooled.push(t),
}));

import { claudeOneShot, oneShotCredentials } from "../claude-oneshot";

const call = () => claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5_000 });

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  state.pool = ["seat-a", "seat-b", "seat-c"];
  state.answers = [];
  state.seen = [];
  state.cooled = [];
});
afterEach(() => {
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("claudeOneShot", () => {
  it("answers from the first seat when it is free", async () => {
    state.answers = [{ result: "hello" }];
    await expect(call()).resolves.toEqual({ text: "hello", cost_usd: 0.01 });
    expect(state.seen.map((s) => s.oauth)).toEqual(["seat-a"]);
  });

  it("never hands the whole seat pool to the child, only the one token in play", async () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKENS;
    process.env.CLAUDE_CODE_OAUTH_TOKENS = "seat-a,seat-b,seat-c";
    try {
      state.answers = [{ result: "hello" }];
      await call();
      expect(state.seen).toHaveLength(1);
      expect(state.seen[0].pool).toBeUndefined();
      expect(state.seen[0].oauth).toBe("seat-a");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKENS;
      else process.env.CLAUDE_CODE_OAUTH_TOKENS = saved;
    }
  });

  it("moves to the next seat on a rate limit, without cooling the busy one", async () => {
    state.answers = [{ subtype: "error_during_execution", result: 'API Error: 429 {"type":"rate_limit_error"}' }, { result: "ok" }];
    await expect(call()).resolves.toMatchObject({ text: "ok" });
    expect(state.seen.map((s) => s.oauth)).toEqual(["seat-a", "seat-b"]);
    expect(state.cooled).toEqual([]);
  });

  it("moves on from a capped seat and puts it on cooldown", async () => {
    state.answers = [new Error("Claude AI usage limit reached · resets 7pm (UTC)"), { result: "ok" }];
    await expect(call()).resolves.toMatchObject({ text: "ok" });
    expect(state.cooled).toEqual(["seat-a"]);
  });

  it("treats a cap notice returned as 'success' as a refusal, not an answer", async () => {
    state.answers = [{ result: "You've hit your limit · resets 7pm (UTC)" }, { result: "real answer" }];
    await expect(call()).resolves.toMatchObject({ text: "real answer" });
    expect(state.cooled).toEqual(["seat-a"]);
  });

  it("does not rotate on an error the next seat would repeat", async () => {
    state.answers = [new Error("invalid_request_error: bad model")];
    await expect(call()).rejects.toThrow(/bad model/);
    expect(state.seen).toHaveLength(1);
  });

  it("throws the last refusal when every seat is busy", async () => {
    state.answers = [new Error("429 rate_limit"), new Error("429 rate_limit"), new Error("529 overloaded")];
    await expect(call()).rejects.toThrow(/overloaded/);
    expect(state.seen).toHaveLength(3);
  });

  it("uses only the API key when one is configured, with no OAuth token in the child env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    state.answers = [{ result: "ok" }];
    await call();
    expect(state.seen).toEqual([{ oauth: undefined, apiKey: "sk-test" }]);
    expect(oneShotCredentials()).toEqual([{ kind: "api_key" }]);
  });

  it("refuses up front when there is no credential at all", async () => {
    state.pool = [];
    await expect(call()).rejects.toThrow(/no Anthropic credential/);
  });
});

it("does not purchase a completion after the caller deadline expired", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5_000, signal: abort.signal })).rejects.toThrow();
  expect(state.seen).toHaveLength(0);
});

describe("opt-in attempt timing", () => {
  it("reports numerical SDK usage and API duration without prompts, credentials or output", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    state.answers = [{ result: "PRIVATE RESULT", advanceMs: 90, metrics: {
      duration_api_ms: 70, usage: { input_tokens: 14, output_tokens: 4, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 },
    } }];
    const observed = vi.fn();
    const result = await claudeOneShot({ model: "m", system: "PRIVATE SYSTEM", user: "PRIVATE USER", timeoutMs: 5000, onAttempt: observed });
    expect(result).toEqual({ text: "PRIVATE RESULT", cost_usd: 0.01 });
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ attempt: 0, ms: 90, outcome: "ok", promptChars: 26,
      apiMs: 70, inputTokens: 14, outputTokens: 4, cacheReadTokens: 11, cacheWriteTokens: 3 });
    expect(JSON.stringify(observed.mock.calls)).not.toMatch(/PRIVATE|seat-|sk-/);
  });

  it("separates a rate-limited attempt from the successful replacement without changing rotation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    state.answers = [{ subtype: "error_during_execution", result: "429 rate_limit", advanceMs: 20 }, { result: "ok", advanceMs: 60 }];
    const observed = vi.fn();
    await claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000, onAttempt: observed });
    expect(observed.mock.calls.map(([e]) => e)).toEqual([
      { attempt: 0, ms: 20, outcome: "rate_limited", promptChars: 2 },
      { attempt: 1, ms: 60, outcome: "ok", promptChars: 2 },
    ]);
    expect(state.seen.map(s => s.oauth)).toEqual(["seat-a", "seat-b"]);
  });

  it("reports usage limits and ordinary errors as fixed categories only", async () => {
    state.answers = [{ result: "You've hit your limit · resets 7pm (UTC)" }, new Error("PRIVATE invalid request")];
    const observed = vi.fn();
    await expect(claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000, onAttempt: observed })).rejects.toThrow("PRIVATE invalid request");
    expect(observed.mock.calls.map(([e]) => e.outcome)).toEqual(["usage_limited", "error"]);
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
    expect(state.cooled).toEqual(["seat-a"]);
  });

  it("distinguishes overload from a rate limit while preserving the same retry policy", async () => {
    state.answers = [new Error("529 overloaded"), { result: "ok" }];
    const observed = vi.fn();
    await claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000, onAttempt: observed });
    expect(observed.mock.calls.map(([e]) => e.outcome)).toEqual(["overloaded", "ok"]);
    expect(state.seen.map(s => s.oauth)).toEqual(["seat-a", "seat-b"]);
    expect(state.cooled).toEqual([]);
  });

  it("omits absent or malformed SDK metrics instead of inventing zero usage", async () => {
    state.answers = [{ result: "ok", metrics: { duration_api_ms: Infinity,
      usage: { input_tokens: "PRIVATE", output_tokens: -1, cache_read_input_tokens: 1.5, cache_creation_input_tokens: null } } }];
    const observed = vi.fn();
    await claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000, onAttempt: observed });
    expect(Object.keys(observed.mock.calls[0][0]).sort()).toEqual(["attempt", "ms", "outcome", "promptChars"]);
  });

  it("distinguishes deadline expiry from caller cancellation and does not rotate either", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    state.answers = [{ subtype: "error_during_execution", result: "aborted", advanceMs: 5000 }];
    const observed = vi.fn();
    await expect(claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000, onAttempt: observed })).rejects.toThrow("aborted");
    expect(observed.mock.calls[0][0]).toMatchObject({ outcome: "timeout", ms: 5000 });
    expect(state.seen).toHaveLength(1);
    const abort = new AbortController();
    state.answers = [{ subtype: "error_during_execution", result: "aborted", beforeResult: () => abort.abort() }];
    await expect(claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000, signal: abort.signal, onAttempt: observed })).rejects.toThrow("aborted");
    expect(observed.mock.calls[1][0]).toMatchObject({ outcome: "cancelled" });
    expect(state.seen).toHaveLength(2);
  });

  it("a rejected asynchronous observer is contained without delaying the completion", async () => {
    state.answers = [{ result: "ok" }];
    await expect(claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000,
      onAttempt: async () => { throw new Error("logging down"); } })).resolves.toMatchObject({ text: "ok" });
    expect(state.seen).toHaveLength(1);
  });

  it("a broken observer cannot fail a completion or rotate another credential", async () => {
    state.answers = [{ result: "ok" }];
    await expect(claudeOneShot({ model: "m", system: "s", user: "u", timeoutMs: 5000,
      onAttempt: () => { throw new Error("logging down"); } })).resolves.toMatchObject({ text: "ok" });
    expect(state.seen).toHaveLength(1);
  });
});
