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

beforeEach(() => { seen.prompts = []; seen.systems = []; vi.mocked(searchMemory).mockClear(); });

vi.mock("@/services/channels/context", () => ({
  defaultChannelContext: vi.fn(async () => ({ channel_settings: { keywords: [{ item: "SAVED_KEYWORD_AUDIT" }] } })),
}));
import { defaultChannelContext } from "@/services/channels/context";

const channels = ["linkedin_organic", "x_ads", "tiktok_organic", "tiktok_ads", "chatgpt_ads", "instagram_organic", "x_organic"];

describe("channel chat: actual model input for the seven requested channels", () => {
  it("does not retain caller-supplied history or stale unavailable markers", async () => {
    const ctx = makeCtx("x_ads"); ctx.trigger = "chat";
    await runGeneric(ctx, { prior_messages: [], current_message: "Explain my settings", channel_history: ["CALLER_HISTORY_AUDIT_MARKER"], channel_context_unavailable: "CALLER_UNAVAILABLE_AUDIT_MARKER", channel_settings_unavailable: "CALLER_SETTINGS_ERROR_AUDIT_MARKER" });
    for (const marker of ["CALLER_HISTORY_AUDIT_MARKER", "CALLER_UNAVAILABLE_AUDIT_MARKER", "CALLER_SETTINGS_ERROR_AUDIT_MARKER"]) expect(seen.systems[0]).not.toContain(marker);
    expect(seen.systems[0]).toContain("SAVED_KEYWORD_AUDIT");
  });
  it.each(channels)("%s memory uses the current question rather than old transcript text", async (slug) => {
    const ctx = makeCtx(slug); ctx.trigger = "chat";
    ctx.agent.metadata_praxis.memory_layer = true;
    await runGeneric(ctx, {
      prior_messages: [{ role: "user", content: "OLD_TOPIC_AUDIT ".repeat(100) }],
      current_message: "Remember my preferred writing style CURRENT_ASK_AUDIT",
      current_user_text_raw: "Remember my preferred writing style CURRENT_ASK_AUDIT",
    });
    const probe = vi.mocked(searchMemory).mock.calls[0]?.[1];
    expect(probe).not.toContain("OLD_TOPIC_AUDIT");
    expect(probe).toContain("CURRENT_ASK_AUDIT");
  });
  it.each(channels)("%s excludes sibling run bodies", async (slug) => {
    const ctx = makeCtx(slug); ctx.trigger = "chat";
    ctx.scanRecentRuns = async () => [
      { agent_slug: "meta_ads", status: "success", output_text: "UNRELATED_META_OUTPUT_AUDIT" },
      { agent_slug: slug, status: "success", output_text: "OWN_SEO_OUTPUT_AUDIT" },
    ] as never;
    await runGeneric(ctx, { prior_messages: [], current_message: "Explain indexing" });
    expect(seen.systems[0]).not.toContain("UNRELATED_META_OUTPUT_AUDIT");
    expect(seen.systems[0]).toContain("OWN_SEO_OUTPUT_AUDIT");
  });
  it.each(channels)("%s loads saved channel settings", async (slug) => {
    vi.mocked(defaultChannelContext).mockClear();
    const ctx = makeCtx(slug); ctx.trigger = "chat";
    await runGeneric(ctx, { prior_messages: [], current_message: "Which keywords did I save?" });
    expect(defaultChannelContext).toHaveBeenCalled();
    expect(seen.systems[0]).toContain("SAVED_KEYWORD_AUDIT");
  });
  it("keeps raw questions and prior replies only in the conversation", async () => {
    const ctx = makeCtx("meta_ads"); ctx.trigger = "chat";
    ctx.scanRecentRuns = async () => [
      { agent_slug: "meta_ads", status: "success", output_text: "PRIOR_REPLY_AUDIT_MARKER" },
    ] as never;
    await runGeneric(ctx, {
      prior_messages: [{ role: "user", content: "Help" }, { role: "assistant", content: "PRIOR_REPLY_AUDIT_MARKER" }],
      current_message: "CURRENT_QUESTION_AUDIT_MARKER", current_user_text_raw: "CURRENT_QUESTION_AUDIT_MARKER",
    });
    for (const marker of ["CURRENT_QUESTION_AUDIT_MARKER", "PRIOR_REPLY_AUDIT_MARKER"]) {
      expect(seen.systems[0]).not.toContain(marker);
      expect(seen.prompts[0]).toContain(marker);
    }
  });
});

it.skipIf(!process.env.CHANNEL_CHAT_LIVE_FIXTURE).each(channels)("%s includes each active setting from the live capture", async slug => {
  const { readFileSync } = await import("node:fs");
  const captured = JSON.parse(readFileSync(process.env.CHANNEL_CHAT_LIVE_FIXTURE!, "utf8"));
  const { projectSettings } = await vi.importActual<typeof import("@/services/channels/context")>("@/services/channels/context");
  const fields = captured.channels[slug].settings.fields;
  const settings = projectSettings(fields, slug);
  vi.mocked(defaultChannelContext).mockResolvedValueOnce(settings ? { channel_settings: settings } : null);
  const ctx = makeCtx(slug); ctx.trigger = "chat";
  await runGeneric(ctx, { prior_messages: [], current_message: "Read my saved settings", current_user_text_raw: "Read my saved settings" });
  if (settings) {
    for (const items of Object.values(settings)) for (const item of items as Array<{ item?: unknown }>) {
      if (typeof item.item === "string") expect(seen.systems[0]).toContain(item.item);
    }
  } else {
    expect(seen.systems[0]).not.toContain('channel_settings');
  }
  expect(defaultChannelContext).toHaveBeenLastCalledWith(ctx.tenant_id, slug);
});
