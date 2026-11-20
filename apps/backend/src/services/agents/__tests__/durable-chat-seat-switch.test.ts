
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { plan, updates } = vi.hoisted(() => ({
  plan: {
    calls: [] as Array<{ options: Record<string, unknown>; env: Record<string, string | undefined>; prompt: unknown[] }>,
    capFirst: true,
  },
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
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
    const prompt: unknown[] = [];
    for await (const m of args.prompt) prompt.push(m);
    const env = (args.options.env ?? {}) as Record<string, string | undefined>;
    plan.calls.push({ options: args.options, env, prompt });
    if (plan.capFirst && plan.calls.length === 1) {
      yield {
        type: "result" as const,
        subtype: "success" as const,
        session_id: "sess-capped",
        result: "You've hit your limit · resets 12am (UTC)",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      return;
    }
    yield {
      type: "assistant" as const,
      message: { content: [{ type: "text", text: "answer" }] },
    };
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "sess-new",
      result: "answer",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
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
import type { AgentContext } from "@/services/agents/types";

function makeCtx(): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "run-durable-seat-switch",
    trigger: "chat",
    thread_id: "11111111-1111-4111-8111-111111111111",
    agent: {
      slug: "operator",
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

const payload = {
  prior_messages: [
    { role: "user", content: "earlier question ALPHA" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "follow-up BETA" },
  ],
  current_message: "follow-up BETA",
  sdk_session_id: "sess-old",
};

const ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKENS", "PRAXIS_AGENT_AUTH_MODE"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  plan.calls.length = 0;
  plan.capFirst = true;
  updates.length = 0;
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

describe("durable web chat — seat switch on a usage limit", () => {
  it("retries on the next seat without the durable store or resume, and marks the session degraded", async () => {
    await runGeneric(makeCtx(), payload);

    expect(plan.calls).toHaveLength(2);
    const [first, second] = plan.calls;

    expect(first.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("seat-a");
    expect(first.options.resume).toBe("sess-old");
    expect(first.options.sessionStore).toBeDefined();

    expect(second.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("seat-b");
    expect(second.options.resume).toBeUndefined();
    expect(second.options.sessionStore).toBeUndefined();
    expect(JSON.stringify(second.prompt)).toContain("earlier question ALPHA");

    expect(isTokenCooling("seat-a")).toBe(true);
    expect(
      updates.some(
        (u) => u.table === "agent_threads" && typeof u.patch.sdk_session_mirror_degraded_at === "string",
      ),
    ).toBe(true);
  });

  it("an attachment turn keeps the prior conversation on the retry (not just the attachment)", async () => {
    const attachment = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "follow-up BETA" },
    ];
    await runGeneric(makeCtx(), { ...payload, current_message_content: attachment });

    expect(plan.calls).toHaveLength(2);
    const retry = JSON.stringify(plan.calls[1].prompt);
    expect(retry).toContain("earlier question ALPHA");
    expect(retry).toContain('"type":"image"');
  });

  it("a healthy seat keeps the durable store + resume and never marks degraded", async () => {
    plan.capFirst = false;
    await runGeneric(makeCtx(), payload);

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0].options.resume).toBe("sess-old");
    expect(plan.calls[0].options.sessionStore).toBeDefined();
    expect(updates.some((u) => "sdk_session_mirror_degraded_at" in u.patch)).toBe(false);
  });
});
