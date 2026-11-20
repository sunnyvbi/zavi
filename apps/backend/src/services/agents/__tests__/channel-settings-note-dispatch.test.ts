
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

function makeCtx(slug: string): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: `run-settings-note-${slug}`,
    trigger: "channel_recipe",
    draft_mode: true,
    citedNotes: new Map(),
    agent: {
      slug,
      metadata_praxis: { memory_layer: false, tools: [] as string[], model: "claude-sonnet-4-6" },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

function payload(channelSettings: unknown) {
  return {
    channel_slug: "instagram_organic",
    router: [{ id: "handle_discovery", when: "always", goal: "Establish the account." }],
    ...(channelSettings === undefined ? {} : { channel_settings: channelSettings }),
  };
}

const rows = (...items: string[]) => items.map((item) => ({ item, status: "tracking" }));

const HANDLE_LINE =
  '- handle (this company\'s OWN account on this channel, named by the founder): \\"acmeco\\"';

beforeEach(() => {
  seen.prompts = [];
});

describe("the settings note reaches the SDK prompt on a channel run", () => {
  it("is present exactly once, and describes the role", async () => {
    await runGeneric(
      makeCtx("instagram_organic"),
      payload({ handle: rows("acmeco"), competitors: rows("rivalone") }),
    );
    expect(seen.prompts.length, "SDK was never called").toBeGreaterThan(0);
    const prompt = seen.prompts[0];
    expect(prompt.split("Saved by this company in this channel").length - 1).toBe(1);
    expect(prompt).toContain(HANDLE_LINE);
    expect(prompt).toContain("this company's OWN account");
    expect(prompt).toContain(
      '- competitors (OTHER people\'s accounts the founder chose for you to work with. ' +
        'Never this company\'s own): \\"rivalone\\"',
    );
  });

  it("lands AFTER the run context and after the closing instruction", async () => {
    await runGeneric(makeCtx("instagram_organic"), payload({ handle: rows("acmeco") }));
    const prompt = seen.prompts[0];
    expect(prompt.indexOf("Run context (JSON)")).toBeLessThan(prompt.indexOf(HANDLE_LINE));
    expect(prompt.indexOf("Produce your final output now")).toBeLessThan(
      prompt.indexOf(HANDLE_LINE),
    );
  });

  it("is absent when the tenant saved nothing", async () => {
    await runGeneric(makeCtx("instagram_organic"), payload(undefined));
    expect(seen.prompts.length, "SDK was never called").toBeGreaterThan(0);
    expect(seen.prompts[0]).not.toContain("Saved by this company in this channel");
  });
});
