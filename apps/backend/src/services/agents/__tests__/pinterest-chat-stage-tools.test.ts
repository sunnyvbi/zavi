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

const { seen } = vi.hoisted(() => ({ seen: { serverTools: [] as string[][] } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { tools?: Array<{ name: string }> }) => {
    seen.serverTools.push((opts.tools ?? []).map((t) => t.name));
    return { name: "stub", instance: {} };
  },
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> }) {
    for await (const _m of args.prompt) void _m;
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

const tool = (server_id: string, tool_name: string) => ({
  name: `${server_id}__${tool_name}`,
  description: tool_name,
  input_schema: { type: "object", properties: {} },
  server_id,
  tool_name,
});
const RAW_CATALOG = () => [
  tool("social", "list_posts"),
  tool("social", "propose_post"),
  tool("composio", "PINTEREST_LIST_BOARDS"),
  tool("composio", "PINTEREST_CREATE_PIN"),
  tool("composio", "PINTEREST_DELETE_PIN"),
];
vi.mock("@/services/mcp/discovery", async () => {
  const { isRawPinterestWrite } = await import("@/services/connectors/pinterest-composio/raw-write");
  const advertised = () => RAW_CATALOG().filter((t) => t.server_id !== "composio" || !isRawPinterestWrite(t.tool_name, "pinterest"));
  return {
    discoverToolsForTenant: async () => ({ tools: advertised(), disconnected_connectors: [] }),
    listToolsForTenant: async () => advertised(),
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
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: vi.fn(async () => null) }));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { resolveChatTurnVerdict } from "@/services/agents/chat-turn-verdict";
import { chatAnswerTurnEmit } from "@/services/agents/redo-mode";
import type { AgentContext } from "@/services/agents/types";

const SLUG = "pinterest_organic";

function makeCtx(): AgentContext {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    runId: "run-pinterest-chat-stage",
    trigger: "chat",
    draft_mode: true,
    citedNotes: new Map(),
    agent: {
      slug: SLUG,
      body_markdown: "You are the Pinterest specialist.",
      metadata_praxis: {
        memory_layer: false,
        tools: ["social__list_posts", "social__propose_post", "composio__PINTEREST_LIST_BOARDS"],
        model: "claude-sonnet-4-6",
      },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

const haikuTimedOut = vi.fn(async () => {
  throw new Error("chatTurnTiebreak timeout after 1500ms");
});

async function chatTurnServerTools(userText: string, prevAssistantText: string | null): Promise<string[]> {
  const ctx = makeCtx();
  const verdict = await resolveChatTurnVerdict({
    userText,
    prevAssistantText,
    tags: { tenantId: ctx.tenant_id, agentSlug: SLUG, runId: ctx.runId },
    tiebreak: haikuTimedOut,
  });
  ctx.chat_turn_verdict = verdict;
  if (verdict === "answer") ctx.emitDecision = chatAnswerTurnEmit;
  await runGeneric(ctx, { prior_messages: [], current_message: userText, current_user_text_raw: userText });
  return seen.serverTools.flat();
}

beforeEach(() => {
  seen.serverTools = [];
  haikuTimedOut.mockClear();
});

const PIN_DRAFT = "Here is pin 1: a 1000x1500 image, title, description and board Spring Looks.";

describe("pinterest_organic chat: a staging ask keeps social__propose_post even when the Haiku tiebreak times out", () => {
  it.each([
    ["Stage this pin for approval", null],
    ["Can you stage pin 1 for my approval?", PIN_DRAFT],
    ["Yes, stage it", PIN_DRAFT],
    ["Create a pin for the spring collection and stage it", null],
  ])("%s", async (userText, prev) => {
    const names = await chatTurnServerTools(userText, prev);
    expect(names).toContain("social__propose_post");
    expect(names).toContain("social__list_posts");
    expect(names).toContain("composio__PINTEREST_LIST_BOARDS");
    expect(names).not.toContain("composio__PINTEREST_CREATE_PIN");
    expect(names).not.toContain("composio__PINTEREST_DELETE_PIN");
    expect(haikuTimedOut).not.toHaveBeenCalled();
  });

  it("a plain question still loses the staging tool", async () => {
    const names = await chatTurnServerTools("Why are my pins getting so few saves?", null);
    expect(names).toContain("social__list_posts");
    expect(names).not.toContain("social__propose_post");
    expect(names).not.toContain("composio__PINTEREST_CREATE_PIN");
  });
});
