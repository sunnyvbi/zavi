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

const { seen } = vi.hoisted(() => ({ seen: { prompts: [] as string[], systems: [] as string[] } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
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
import { channelChatPrompt } from "@/services/agents/channel-chat-mode";
import { channelForAgent } from "@/services/agents/channel-agents";
import { loadChannelRecipe } from "@/services/channels/recipe";
import { searchMemory } from "@/services/memory";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(slug: string): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
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

beforeEach(() => { seen.prompts = []; seen.systems = []; vi.mocked(searchMemory).mockClear(); });

describe("paid-channel handoff scope reaches the model", () => {
  it("hydrates an intent-only ChatGPT Ads handoff with its own playbook and scope", async () => {
    const ctx = makeCtx("chatgpt_ads");
    ctx.trigger = "handoff";
    ctx.agent.metadata_praxis.memory_layer = true;
    await runGeneric(ctx, {
      intent: "Can you suggest a few ads options for our company?",
      operator_thread_id: "thread-1",
      source_agent_slug: "operator",
      channel_slug: "meta_ads",
      recipe_body: "STALE_OTHER_CHANNEL_PLAYBOOK",
    });
    expect(seen.prompts.length).toBeGreaterThan(0);
    expect(seen.prompts[0]).toContain("options on ChatGPT Ads");
    expect(seen.prompts[0]).toContain("Other platforms' drafts");
    expect(seen.systems[0]).toContain("Zavi-managed ChatGPT Ads");
    expect(seen.systems[0]).toContain("chatgpt_ads__read_performance");
    expect(seen.systems[0]).not.toContain("STALE_OTHER_CHANNEL_PLAYBOOK");
    expect(searchMemory).toHaveBeenCalledWith(
      ctx.tenant_id,
      expect.stringContaining("ChatGPT Ads (chatgpt_ads)"),
      3,
      expect.objectContaining({ agent_slug: "chatgpt_ads" }),
    );
  });

  it("preserves the channel on direct chat and excludes sibling run history", async () => {
    const ctx = makeCtx("chatgpt_ads");
    ctx.trigger = "chat";
    ctx.scanRecentRuns = async () => [
      { agent_slug: "meta_ads", status: "success", output_text: "SIBLING_CAMPAIGN_SCALE_THIS" },
      { agent_slug: "chatgpt_ads", status: "success", output_text: "OWN_CHANNEL_CAMPAIGN" },
    ] as never;
    await runGeneric(ctx, {
      mode: "chat", prior_messages: [], current_message: "Suggest a few ads options",
    });
    const system = seen.systems[0];
    expect(system).toContain("options on ChatGPT Ads");
    expect(system).toContain("OWN_CHANNEL_CAMPAIGN");
    expect(system).not.toContain("SIBLING_CAMPAIGN_SCALE_THIS");
    expect(seen.prompts[0]).toContain("Suggest a few ads options");
  });

  it("keeps a primitive request on a direct paid-channel run", async () => {
    const ctx = makeCtx("chatgpt_ads");
    ctx.trigger = "manual";
    ctx.agent.metadata_praxis.memory_layer = true;
    await runGeneric(ctx, "PRIMITIVE_AUDIT_MY_CAMPAIGN");
    expect(seen.prompts.join("\n") + seen.systems.join("\n")).toContain("PRIMITIVE_AUDIT_MY_CAMPAIGN");
    expect(searchMemory).toHaveBeenCalledWith(
      ctx.tenant_id,
      expect.stringContaining("(chatgpt_ads)\nPRIMITIVE_AUDIT_MY_CAMPAIGN"),
      3,
      expect.anything(),
    );
  });

  it("a pressed Run is the full channel check, not a scoped follow-up to an earlier chat ask", async () => {
    const handoffAnswer =
      "LinkedIn Ads account state: 2 campaigns, both paused, no spend in the last 30 days. You asked how your LinkedIn ads are doing.";
    const recipe = loadChannelRecipe("linkedin_ads");
    const ctx = makeCtx("linkedin_ads");
    ctx.trigger = "channel_recipe";
    ctx.scanRecentRuns = async () => [
      { agent_slug: "linkedin_ads", status: "success", output_text: handoffAnswer },
    ] as never;
    await runGeneric(ctx, {
      inputs: recipe.meta.inputs,
      router: recipe.meta.router,
      artifact: recipe.meta.artifact,
      recipe_body: recipe.body,
      channel_slug: "linkedin_ads",
      min_evidence: recipe.meta.min_evidence,
      channel_claim_id: "claim-1",
      pending_proposals: [],
    });
    const recipeRun = seen.prompts[0];
    expect(recipeRun).toContain(handoffAnswer.slice(0, 40));
    expect(recipeRun).toContain("## Current channel: LinkedIn Ads (linkedin_ads)");
    expect(recipeRun).not.toContain("only for steps relevant to the current request");
    expect(recipeRun).not.toContain("full scheduled audit");
    expect(recipeRun).toContain("full channel check");

    seen.prompts = []; seen.systems = [];
    const handoff = makeCtx("linkedin_ads");
    await runGeneric(handoff, {
      intent: "Report on current LinkedIn Ads performance. User asked: how are my LinkedIn ads doing?",
      operator_thread_id: "thread-1",
      source_agent_slug: "operator",
    });
    expect(seen.prompts[0]).toContain("only for steps relevant to the current request");
    expect(seen.prompts[0]).not.toContain("full channel check");
  });

  it("leaves a generalist handoff free to answer a cross-channel request", async () => {
    const ctx = makeCtx("operator");
    ctx.trigger = "handoff";
    await runGeneric(ctx, { intent: "Compare Meta and Google campaigns" });
    expect(seen.prompts[0]).toContain("Compare Meta and Google campaigns");
    expect(seen.prompts[0]).not.toContain("## Current channel:");
    expect(seen.systems[0]).not.toContain("## Channel playbook");
  });

  it("channel chat mode: an organic channel's chat gets its playbook and the chat rules", async () => {
    const ctx = makeCtx("seo");
    ctx.trigger = "chat";
    await runGeneric(ctx, { mode: "chat", prior_messages: [], current_message: "why did traffic drop?" });
    const system = seen.systems[0];
    expect(system).toContain(JSON.stringify(channelChatPrompt(channelForAgent("seo")!)).slice(1, 80));
    expect(system).toContain(JSON.stringify(loadChannelRecipe("seo").body.trim()).slice(1, 60));
  });

  it("channel chat mode: a paid channel's chat gets the chat rules too, and a handoff does not", async () => {
    const chat = makeCtx("chatgpt_ads");
    chat.trigger = "chat";
    await runGeneric(chat, { mode: "chat", prior_messages: [], current_message: "how are my ads?" });
    const rules = JSON.stringify(channelChatPrompt(channelForAgent("chatgpt_ads")!)).slice(1, 80);
    expect(seen.systems[0]).toContain(rules);

    seen.prompts = []; seen.systems = [];
    const handoff = makeCtx("seo");
    await runGeneric(handoff, { intent: "audit the site", operator_thread_id: "thread-1", source_agent_slug: "operator" });
    expect(seen.systems.join("\n") + seen.prompts.join("\n")).not.toContain("This is a chat, not a run");
  });
});
