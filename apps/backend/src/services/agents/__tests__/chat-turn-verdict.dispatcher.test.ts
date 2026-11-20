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

const { seen } = vi.hoisted(() => ({ seen: { prompts: [] as string[], systems: [] as string[], serverTools: [] as string[][] } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { tools?: Array<{ name: string }> }) => { seen.serverTools.push((opts.tools ?? []).map((t) => t.name)); return { name: "stub", instance: {} }; },
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown>; options?: { systemPrompt?: unknown } }) {
    const parts: string[] = [];
    for await (const m of args.prompt) parts.push(JSON.stringify(m));
    seen.prompts.push(parts.join("\n"));
    seen.systems.push(JSON.stringify(args.options?.systemPrompt));
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
const TOOLS = () => [
    { name: "meta_ads__account_read", description: "Read.", input_schema: { type: "object", properties: {} }, server_id: "meta_ads", tool_name: "account_read" },
    { name: "meta_ads__propose_budget_change", description: "Propose.", input_schema: { type: "object", properties: {} }, server_id: "meta_ads", tool_name: "propose_budget_change" },
  ];
vi.mock("@/services/mcp/discovery", () => ({
  discoverToolsForTenant: async () => ({ tools: TOOLS(), disconnected_connectors: [] }),
  listToolsForTenant: async () => TOOLS(),
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
import { channelChatPrompt } from "@/services/agents/channel-chat-mode";
import { channelForAgent } from "@/services/agents/channel-agents";
import { loadChannelRecipe } from "@/services/channels/recipe";
import { searchMemory } from "@/services/memory";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(slug: string): AgentContext {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    runId: `run-paid-scope-${slug}`,
    trigger: "handoff",
    draft_mode: true,
    citedNotes: new Map(),
    agent: {
      slug,
      body_markdown: "You are a specialist.",
      metadata_praxis: { memory_layer: false, tools: [] as string[], model: "claude-sonnet-4-6" },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

beforeEach(() => { seen.prompts = []; seen.systems = []; seen.serverTools = []; });
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: vi.fn(async () => null) }));

async function serverToolsFor(trigger: string, verdict?: "answer" | "action"): Promise<string[]> {
  const ctx = makeCtx("meta_ads");
  ctx.trigger = trigger as never;
  ctx.agent.metadata_praxis.tools = ["meta_ads__account_read", "meta_ads__propose_budget_change"] as never;
  if (verdict) ctx.chat_turn_verdict = verdict;
  await runGeneric(ctx, { prior_messages: [], current_message: "why is my CPC high?", current_user_text_raw: "why is my CPC high?" });
  return seen.serverTools.flat();
}

describe("channel chat answer turn: tool list the model is handed", () => {
  it("a question turn has no propose tool", async () => {
    const names = await serverToolsFor("chat", "answer");
    expect(names).toContain("meta_ads__account_read");
    expect(names).not.toContain("meta_ads__propose_budget_change");
  });

  it("an order keeps it", async () => {
    expect(await serverToolsFor("chat", "action")).toContain("meta_ads__propose_budget_change");
  });

  it("a scheduled run keeps it, even with a stray verdict on its context", async () => {
    expect(await serverToolsFor("schedule", "answer")).toContain("meta_ads__propose_budget_change");
  });
});
