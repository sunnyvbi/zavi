
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { plan, updates, threadEvents } = vi.hoisted(() => ({
  plan: {
    calls: [] as Array<{ env: Record<string, string | undefined> }>,
    script: [] as unknown[][],
  },
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  threadEvents: [] as unknown[],
}));
vi.mock("../thread-event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-event")>()),
  emitThreadEvent: vi.fn(async (event: unknown) => { threadEvents.push(event); }),
  emitThreadEventOnce: vi.fn(async (_step: unknown, _key: unknown, _run: unknown, event: unknown) => { threadEvents.push(event); }),
}));
vi.mock("@/services/supabase", async (importOriginal) => {
  const chain: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "error" || prop === "data") return null;
      return () => proxy;
    },
  });
  return {
    ...(await importOriginal<typeof import("@/services/supabase")>()),
    serviceClient: () => ({
      from: (table: string) =>
        new Proxy(chain, {
          get(_t, prop) {
            if (prop === "then") return undefined;
            if (prop === "update")
              return (patch: Record<string, unknown>) => {
                updates.push({ table, patch });
                return proxy;
              };
            return () => proxy;
          },
        }),
      rpc: async () => ({ data: null, error: null }),
      storage: { from: () => chain },
    }),
  };
});

vi.mock("@/services/agents/seat-cooldown-store", () => ({
  publishSeatCooldown: vi.fn(),
  isSeatCoolingShared: () => false,
}));
vi.mock("@/services/tenant-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tenant-client")>()),
  globalClient: () => ({ from: () => ({ upsert: async () => ({ data: null, error: null }) }) }),
  recordSeatUsageRpc: async () => {},
  benchSeatCooldownRpc: async () => {},
}));

vi.mock("../sdk-session-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sdk-session-store")>()),
  createSdkSessionStore: () => ({
    append: vi.fn(async () => {}),
    load: vi.fn(async () => [{ type: "user", uuid: "u-1", message: { role: "user", content: "hi" } }]),
  }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) {
    for await (const _m of args.prompt) void _m;
    const env = (args.options.env ?? {}) as Record<string, string | undefined>;
    plan.calls.push({ env });
    const steps = plan.script[plan.calls.length - 1] ?? plan.script[plan.script.length - 1];
    for (const s of steps) yield s;
  }),
}));

vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  searchMemory: vi.fn(async () => []),
}));
vi.mock("@/services/mcp/discovery", () => ({
  discoverToolsForTenant: async () => ({ tools: [], disconnected_connectors: [] }),
  listToolsForTenant: async () => [],
  _clearToolCacheForTests: () => {},
}));
vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: vi.fn(async () => {}),
}));
vi.mock("../setup-schema", () => ({
  probeSetupCompleteness: async () => ({
    ok: true,
    missing_vault_keys: [],
    missing_connectors: [],
    missing_required_connectors: [],
    missing_optional_connectors: [],
  }),
  getAgentSetupSchema: async () => null,
  recordSetupBlock: async () => {},
}));
vi.mock("../learnings", () => ({ loadAgentLearnings: async () => [] }));
vi.mock("../deepagent", () => ({ LangChainDeepAgentEngine: class {} }));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { _setOAuthTokenPoolOverrideForTest } from "../oauth-token-source";
import { _resetTokenRotationForTest, isTokenCooling } from "../agent-auth";
import { _resetSeatUsageForTest } from "../seat-usage-store";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(slug = "operator"): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "run-seat-limit",
    trigger: "chat",
    thread_id: "11111111-1111-4111-8111-111111111111",
    agent: {
      slug,
      body_markdown: "# Operator",
      metadata_praxis: { memory_layer: false, tools: [] as string[], model: "claude-sonnet-4-6" },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    citedNotes: new Map(),
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

const payload = { current_message: "how is the goal doing?" };

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKENS", "PRAXIS_AGENT_AUTH_MODE", "PRAXIS_ANTHROPIC_ENGINE", "PRAXIS_ANTHROPIC_ENGINE_TENANTS"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  plan.calls.length = 0;
  plan.script = [];
  _resetSeatUsageForTest();
  updates.length = 0;
  threadEvents.length = 0;
  _resetTokenRotationForTest();
  _setOAuthTokenPoolOverrideForTest(["seat-a", "seat-b"]);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _setOAuthTokenPoolOverrideForTest([]);
});

const say = (text: string) => ({ type: "assistant" as const, message: { content: [{ type: "text", text }] } });
const done = (result: string, is_error = false) => ({
  type: "result" as const,
  subtype: "success" as const,
  is_error,
  session_id: "s",
  result,
  usage: { input_tokens: 0, output_tokens: 0 },
});
const WEEKLY = "You've hit your weekly limit · resets 4am (UTC)";
const HOUR = 3_600_000;

describe("a seat that hits its limit", () => {
  it("the new 'weekly limit' notice as the first turn: the run moves to the next seat, the seat is benched for its window", async () => {
    plan.script = [[say(WEEKLY), done(WEEKLY, true)], [say("answer"), done("answer")]];
    await runGeneric(makeCtx(), payload);
    expect(plan.calls.map((c) => c.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["seat-a", "seat-b"]);
    expect(isTokenCooling("seat-a", Date.now() + 19 * 60_000)).toBe(true);
    expect(isTokenCooling("seat-b")).toBe(false);
  });

  it("mid-run (after work): the run fails as before, but the seat is benched so the next run skips it", async () => {
    plan.script = [[say("Reading your goal and channels first."), say(WEEKLY), done(WEEKLY, true)]];
    await expect(runGeneric(makeCtx(), payload)).rejects.toThrow(/weekly limit/);
    expect(plan.calls).toHaveLength(1);
    expect(isTokenCooling("seat-a", Date.now() + 19 * 60_000)).toBe(true);
  });

  it("the SDK's own reset time wins when it reports the seat rejected", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    plan.script = [
      [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt } }, say(WEEKLY), done(WEEKLY, true)],
      [say("answer"), done("answer")],
    ];
    await runGeneric(makeCtx(), payload);
    expect(isTokenCooling("seat-a", Date.now() + 2 * 24 * HOUR)).toBe(true);
    expect(isTokenCooling("seat-a", resetsAt * 1000 + 60_000)).toBe(false);
  });

  it("two windows rejected at once: the seat is out until the LATER reset", async () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const later = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    plan.script = [
      [
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: later } },
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: soon } },
        say(WEEKLY),
        done(WEEKLY, true),
      ],
      [say("answer"), done("answer")],
    ];
    await runGeneric(makeCtx(), payload);
    expect(isTokenCooling("seat-a", soon * 1000 + 60_000)).toBe(true);
  });

  it("an answer that merely mentions limits never benches the seat", async () => {
    plan.script = [[say("x"), done("Your Meta usage limit · resets 4pm (UTC) on the account, so I left the budget alone.")]];
    await runGeneric(makeCtx(), payload);
    expect(isTokenCooling("seat-a")).toBe(false);
  });
});

const DISABLED = "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

describe("PR 4484 through the dispatcher", () => {
  it.each(["operator", "tiktok_ads"])("%s recovers from a standalone notice before any work", async (slug) => {
    plan.script = [[say(DISABLED), done(DISABLED, true)], [say("Account read completed."), done("Account read completed.")]];
    const result = await runGeneric(makeCtx(slug), payload);
    expect(result.output_text).toContain("Account read completed.");
    expect(JSON.stringify(result)).not.toContain(DISABLED);
    expect(JSON.stringify(threadEvents)).not.toContain(DISABLED);
    expect(plan.calls.map(c => c.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["seat-a", "seat-b"]);
    expect(isTokenCooling("seat-a")).toBe(true);
    expect(isTokenCooling("seat-b")).toBe(false);
  });

  it("TikTok recovers when the notice arrives as an error result", async () => {
    plan.script = [[done(DISABLED, true)], [say("Account read completed."), done("Account read completed.")]];
    const result = await runGeneric(makeCtx("tiktok_ads"), payload);
    expect(result.output_text).toContain("Account read completed.");
    expect(JSON.stringify(result)).not.toContain(DISABLED);
    expect(JSON.stringify(threadEvents)).not.toContain(DISABLED);
    expect(plan.calls.map(c => c.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["seat-a", "seat-b"]);
  });

  it("an informational system notice does not interrupt a successful answer", async () => {
    plan.script = [[{ type: "system", subtype: "status", message: DISABLED }, say("Account read completed."), done("Account read completed.")]];
    const result = await runGeneric(makeCtx("tiktok_ads"), payload);
    expect(result.output_text).toContain("Account read completed.");
    expect(plan.calls).toHaveLength(1);
    expect(isTokenCooling("seat-a")).toBe(false);
  });

  it("ordinary explanatory prose mentioning the notice does not fail or rotate", async () => {
    const explanation = `The earlier provider response was: ${DISABLED}. The current account read succeeded.`;
    plan.script = [[say(explanation), done(explanation)]];
    const result = await runGeneric(makeCtx("tiktok_ads"), payload);
    expect(result.output_text).toContain(explanation);
    expect(plan.calls).toHaveLength(1);
    expect(isTokenCooling("seat-a")).toBe(false);
  });

  it("does not replay a TikTok attempt after it has already emitted work", async () => {
    plan.script = [[say("Reading account facts."), say(DISABLED), done(DISABLED, true)], [say("Must not replay"), done("Must not replay")]];
    await expect(runGeneric(makeCtx("tiktok_ads"), payload)).rejects.toThrow(/disabled Claude subscription access/);
    expect(plan.calls).toHaveLength(1);
  });

  it("fails when every credential returns the notice instead of reporting success", async () => {
    plan.script = [[say(DISABLED)], [say(DISABLED)]];
    await expect(runGeneric(makeCtx("tiktok_ads"), payload)).rejects.toThrow(/disabled Claude subscription access/);
    expect(plan.calls).toHaveLength(2);
  });
});
