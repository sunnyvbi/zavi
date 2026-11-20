import { describe, it, expect, vi, beforeEach } from "vitest";

const chainable: unknown = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === "then") return undefined;
    return () => chainable;
  },
  apply() {
    return chainable;
  },
});
const thenableChain: unknown = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === "then") {
      return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    }
    return () => thenableChain;
  },
  apply() {
    return thenableChain;
  },
});
vi.mock("@/services/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/supabase")>()),
  serviceClient: () => ({
    from: () => thenableChain,
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => chainable },
  }),
}));

const h = vi.hoisted(() => ({
  queryCalls: 0,
  engineCalls: [] as Array<{ provider: string; spec: Record<string, unknown> }>,
  funnelDeps: [] as Array<Record<string, unknown>>,
  engineToolCalls: [] as Array<{ tool_name: string; input: unknown }>,
  fakeSandboxContent: null as string | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__B__",
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> | string }) {
    if (typeof args.prompt !== "string") for await (const _ of args.prompt) void _;
    h.queryCalls += 1;
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "s",
      result: "ok",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }),
}));
vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: vi.fn(async () => {}),
}));
vi.mock("@/services/mcp/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/mcp/discovery")>()),
  discoverToolsForTenant: vi.fn(async (_t: string, declared: string[]) => ({
    tools: declared.map((name) => ({ name, description: name, input_schema: { type: "object", properties: {} }, execute: async () => ({}) })),
    disconnected_connectors: [],
  })),
}));
vi.mock("@/services/agents/setup-schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/setup-schema")>()),
  probeSetupCompleteness: async () => ({
    ok: true,
    missing_vault_keys: [],
    missing_connectors: [],
    missing_required_connectors: [],
    missing_optional_connectors: [],
  }),
}));
vi.mock("@/services/agents/kill-switch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/kill-switch")>()),
  isAgentKilled: async () => false,
}));
vi.mock("@/services/agents/run-stop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/run-stop")>()),
  isRunStopRequested: async () => false,
}));
vi.mock("@/services/agents/engine/pick-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/engine/pick-engine")>()),
  pickEngine: (provider: string) => ({
    provider,
    async *run(spec: Record<string, unknown>) {
      h.engineCalls.push({ provider, spec });
      const dispatchTool = spec.dispatchTool as ((c: unknown) => Promise<unknown>) | undefined;
      for (const c of h.engineToolCalls) {
        const [server_id, bare_tool_name] = c.tool_name.split("__");
        await dispatchTool?.({ ...c, server_id, bare_tool_name, tool_use_id: `tu-${bare_tool_name}` });
      }
      yield {
        type: "terminal",
        resume: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
  }),
}));
vi.mock("@/services/email-learnings/note", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/email-learnings/note")>();
  return {
    ...real,
    emailLearningsNoteForRun: vi.fn(async (a: { resolvedToolNames: readonly string[] }) =>
      real.canDraftEmail(a.resolvedToolNames) ? `${real.NOTE_HEAD}\n- "LESSON-MARKER"` : null,
    ),
  };
});

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(slug: string, tools: string[]): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: `run-alt-${slug}`,
    trigger: "manual",
    draft_mode: true,
    agent: { slug, body_markdown: `You are the ${slug} test agent.`, metadata_praxis: { memory_layer: false, tools } },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

async function run(ctx: AgentContext, payload: unknown): Promise<void> {
  try {
    await runGeneric(ctx, payload);
  } catch {
  }
}

const userPrompt = () => {
  const c = h.engineCalls.find((x) => x.provider === "openrouter");
  const p = c?.spec.userPrompt;
  return typeof p === "string" ? p : JSON.stringify(p ?? "");
};

beforeEach(() => {
  h.engineCalls.length = 0;
});

describe("What we learned reaches the OpenAI-compatible funnel too", () => {
  it("an email-drafting run on a staff ?model= pick: one copy, last", async () => {
    await run(makeCtx("email_marketing", ["email__propose_campaign"]), { staff_model: { key: "qwen" } });
    expect(h.engineCalls.length, "the alt engine was never called").toBeGreaterThan(0);
    const p = userPrompt();
    expect(p.split("LESSON-MARKER").length - 1).toBe(1);
    expect(p.trimEnd().endsWith('"LESSON-MARKER"')).toBe(true);
  });

  it("must catch: a run that cannot draft an email gets none there either", async () => {
    await run(makeCtx("research", ["web_search"]), { staff_model: { key: "qwen" } });
    expect(h.engineCalls.length).toBeGreaterThan(0);
    expect(userPrompt()).not.toContain("LESSON-MARKER");
  });
});
