
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const chainable: Record<string, unknown> = {};
const thenableChain = new Proxy(chainable, {
  get(_t, prop) {
    if (prop === "then") return undefined;
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

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
};

const { streamPlan } = vi.hoisted(() => ({
  streamPlan: { toolName: "memory__search", result: null as unknown as ToolResultBlock },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> }) {
    for await (const _ of args.prompt) void _;
    yield {
      type: "assistant" as const,
      message: {
        content: [
          { type: "tool_use", id: "tu_1", name: streamPlan.toolName, input: {} },
        ],
      },
    };
    yield {
      type: "user" as const,
      message: { content: [streamPlan.result] },
    };
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "test-session",
      result: "done",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }),
}));

vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  searchMemory: vi.fn(async () => []),
}));
vi.mock("@/services/mcp/discovery", () => {
  const buildTools = () =>
    ["memory__search", "slack__post_message", "stripe__create_payment"].map((anthropicName) => {
      const idx = anthropicName.indexOf("__");
      return {
        name: anthropicName,
        description: `stub tool ${anthropicName}`,
        input_schema: { type: "object", properties: {} },
        server_id: anthropicName.slice(0, idx),
        tool_name: anthropicName.slice(idx + 2),
      };
    });
  return {
    discoverToolsForTenant: async () => ({ tools: buildTools(), disconnected_connectors: [] }),
    listToolsForTenant: async () => buildTools(),
    _clearToolCacheForTests: () => {},
  };
});
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

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";

type CitedNotes = Map<string, { title: string; score: number }>;

function makeCtx(citedNotes: CitedNotes, slug = "operator"): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "run-sdk-seam-test",
    trigger: "manual",
    draft_mode: true,
    citedNotes,
    agent: {
      slug,
      body_markdown: "# Agent",
      metadata_praxis: { memory_layer: false, tools: [] as string[], model: "claude-sonnet-4-6" },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

function asTypedBlocks(payload: unknown): Array<{ type: string; text: string }> {
  return [{ type: "text", text: JSON.stringify(payload) }];
}

const MEMORY_HIT = {
  hits: [
    { note_id: "note-1", title: "Take-rate policy", score: 0.91, note_type: "tenant_reference" },
  ],
};

async function drive(toolName: string, result: ToolResultBlock, slug = "operator") {
  const citedNotes: CitedNotes = new Map();
  streamPlan.toolName = toolName;
  streamPlan.result = result;
  const out = await runGeneric(makeCtx(citedNotes, slug), "do the thing");
  const traces = out?.tool_calls ?? [];
  const trace = traces.find((t) => t.name === toolName);
  expect(trace, `seam not reached: no trace row for ${toolName}`).toBeDefined();
  return { citedNotes, traces, trace };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SDK capture seam — brain provenance is actually wired", () => {
  it("memory__search result populates ctx.citedNotes (ARRAY-shaped content)", async () => {
    const { citedNotes } = await drive("memory__search", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks(MEMORY_HIT),
      is_error: false,
    });

    expect(citedNotes.size).toBe(1);
    expect(citedNotes.get("note-1")).toEqual({ title: "Take-rate policy", score: 0.91 });
  });

  it("string-shaped content also works (defensive — some paths pre-flatten)", async () => {
    const { citedNotes } = await drive("memory__search", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: JSON.stringify(MEMORY_HIT),
      is_error: false,
    });
    expect(citedNotes.size).toBe(1);
  });

  it("errored memory__search does NOT record provenance", async () => {
    const { citedNotes } = await drive("memory__search", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks(MEMORY_HIT),
      is_error: true,
    });
    expect(citedNotes.size).toBe(0);
  });

  it("a non-memory tool does not pollute citedNotes", async () => {
    const { citedNotes } = await drive("slack__post_message", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks({ ok: true, ts: "1719859200.1" }),
      is_error: false,
    });
    expect(citedNotes.size).toBe(0);
  });
});

describe("SDK capture seam — proof-of-done receipts are actually wired", () => {
  it("slack__post_message result populates trace.receipts (ARRAY-shaped content)", async () => {
    const { trace } = await drive("slack__post_message", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks({ ok: true, ts: "1719859200.123456" }),
      is_error: false,
    });

    expect(trace?.receipts).toEqual([
      { type: "slack_message", label: "Slack message 1719859200.123456", url: undefined },
    ]);
  });

  it("errored tool result yields NO receipt (ok-capture seam contract)", async () => {
    const { trace } = await drive("slack__post_message", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks({ ok: true, ts: "1719859200.123456" }),
      is_error: true,
    });
    expect(trace?.receipts).toBeUndefined();
  });

  it("MONEY PATH — an unsucceeded Stripe result yields NO payment chip", async () => {
    const { trace } = await drive("stripe__create_payment", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks({ payment_intent_id: "pi_123ABC", status: "requires_capture" }),
      is_error: false,
    });
    expect(trace?.receipts).toBeUndefined();
  });

  it("MONEY PATH — a succeeded Stripe result DOES yield a payment chip", async () => {
    const { trace } = await drive("stripe__create_payment", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: asTypedBlocks({ payment_intent_id: "pi_123ABC", status: "succeeded" }),
      is_error: false,
    });
    expect(trace?.receipts).toEqual([
      { type: "stripe_payment", label: "Payment pi_123ABC" },
    ]);
  });
});

describe("AnthropicAgentEngine capture seam — same grounding capture as the inline funnel", () => {
  const prev = process.env.PRAXIS_ANTHROPIC_ENGINE;
  beforeEach(() => {
    process.env.PRAXIS_ANTHROPIC_ENGINE = "all";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PRAXIS_ANTHROPIC_ENGINE;
    else process.env.PRAXIS_ANTHROPIC_ENGINE = prev;
  });

  it("memory__search populates ctx.citedNotes on the engine seam (ARRAY content)", async () => {
    const { citedNotes } = await drive(
      "memory__search",
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: asTypedBlocks(MEMORY_HIT),
        is_error: false,
      },
      "research",
    );
    expect(citedNotes.size).toBe(1);
    expect(citedNotes.get("note-1")).toEqual({ title: "Take-rate policy", score: 0.91 });
  });

  it("slack__post_message populates trace.receipts on the engine seam (ARRAY content)", async () => {
    const { trace } = await drive(
      "slack__post_message",
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: asTypedBlocks({ ok: true, ts: "1719859200.123456" }),
        is_error: false,
      },
      "research",
    );
    expect(trace?.receipts).toEqual([
      { type: "slack_message", label: "Slack message 1719859200.123456", url: undefined },
    ]);
  });
});
