
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { seen } = vi.hoisted(() => ({ seen: { prompts: [] as string[] } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> }) {
    const parts: string[] = [];
    for await (const m of args.prompt) parts.push(JSON.stringify(m));
    seen.prompts.push(parts.join("\n"));
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

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";
import { READER_NOTE } from "../reader-note";

function makeCtx(trigger: string): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: `run-reader-note-${trigger}`,
    trigger,
    draft_mode: true,
    citedNotes: new Map(),
    agent: {
      slug: "operator",
      body_markdown: "# Operator",
      metadata_praxis: { memory_layer: false, tools: [] as string[], model: "claude-sonnet-4-6" },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

const copies = (s: string) => s.split("Reader: this person runs the business").length - 1;

beforeEach(() => {
  seen.prompts = [];
});

describe("reader note reaches the SDK prompt", () => {
  it.each(["slack", "chat"])("operator on %s: exactly one copy", async (trigger) => {
    await runGeneric(makeCtx(trigger), "how does gatekeeper work?");
    expect(seen.prompts.length, "SDK was never called").toBeGreaterThan(0);
    expect(copies(seen.prompts[0])).toBe(1);
    expect(READER_NOTE.startsWith("Reader: this person runs the business")).toBe(true);
  });

  it("operator on handoff: none", async () => {
    await runGeneric(makeCtx("handoff"), "how does gatekeeper work?");
    expect(seen.prompts.length, "SDK was never called").toBeGreaterThan(0);
    expect(copies(seen.prompts[0])).toBe(0);
  });
});
