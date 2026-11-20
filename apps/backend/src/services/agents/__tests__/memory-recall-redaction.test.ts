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

const captured: { systemPrompt?: string }[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown>; options: { systemPrompt?: string } }) {
    for await (const _ of args.prompt) void _;
    captured.push({ systemPrompt: args.options?.systemPrompt });
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "test-session",
      result: "ok",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }),
}));

vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  searchMemory: vi.fn(async () => [
    {
      note_id: "note-stripe-stale",
      title: "Payments status",
      body: "Stripe is not connected for this tenant. Take-rate is 14.1% as of last close.",
      source: "distill",
      note_type: "tenant_reference",
      agent_slug: "operator",
      created_at: "2026-06-01T00:00:00Z",
    },
  ]),
}));

vi.mock("@/services/memory/live-connectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/live-connectors")>()),
  liveConnectorsForTenant: vi.fn(async () => ["stripe"]),
}));

const { logEventSpy } = vi.hoisted(() => ({ logEventSpy: vi.fn(async () => {}) }));
vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: logEventSpy,
}));

vi.mock("@/services/mcp/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/mcp/discovery")>()),
  discoverToolsForTenant: vi.fn(async () => ({
    tools: [{ name: "stripe__list_charges" }],
    disconnected_connectors: [],
  })),
}));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "run-tdz-test",
    trigger: "manual",
    draft_mode: true,
    agent: {
      slug: "operator",
      body_markdown: "# Operator",
      metadata_praxis: { memory_layer: true, tools: [] as string[] },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

describe("memory recall redaction — TDZ behavioral regression", () => {
  beforeEach(() => {
    captured.length = 0;
    logEventSpy.mockClear();
  });

  it("restores the recall block, excises the stale connector claim, keeps the true fact", async () => {
    await runGeneric(makeCtx(), "what is our current payments and take-rate status");

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured[0]?.systemPrompt ?? "";

    expect(prompt).toContain("## Relevant prior context");
    expect(prompt).toContain("14.1%");
    expect(prompt).not.toContain("Stripe is not connected");
    expect(logEventSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "memory_recall_failed" }),
    );
  });
});
