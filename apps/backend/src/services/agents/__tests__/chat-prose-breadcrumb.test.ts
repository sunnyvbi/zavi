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

const { script } = vi.hoisted(() => ({ script: { turns: [] as string[], subtype: "success" as string } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> }) {
    for await (const _m of args.prompt) void _m;
    for (const text of script.turns) {
      yield {
        type: "assistant" as const,
        message: { content: [{ type: "text", text }] },
      };
    }
    yield {
      type: "result" as const,
      subtype: script.subtype,
      session_id: "test-session",
      result: script.turns[script.turns.length - 1] ?? "",
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

const progress: Array<[string, unknown]> = [];

function makeCtx(trigger: string): AgentContext {
  return {
    tenant_id: "66666666-6666-4666-8666-666666666666",
    runId: "run-chat-prose-breadcrumb",
    trigger,
    draft_mode: true,
    citedNotes: new Map(),
    agent: {
      slug: "operator",
      body_markdown: "# Operator",
      metadata_praxis: {
        memory_layer: false,
        tools: [] as string[],
        model: "claude-sonnet-4-6",
        output_envelope: "strategy",
      },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async (stage: string, meta?: unknown) => {
      progress.push([stage, meta]);
    },
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

async function run(trigger: string, text: string) {
  script.turns = [text];
  script.subtype = "success";
  progress.length = 0;
  const r = await runGeneric(makeCtx(trigger), "is everything done?");
  return { r, stages: progress.map(([s, m]) => `${s}:${(m as { code?: string } | undefined)?.code ?? ""}`) };
}

const PROSE =
  "The Meta raise is live. The Google cut still needs your approval on its card, so the shift is not finished yet.";

beforeEach(() => {
  progress.length = 0;
});

describe("chat prose reply: no false parse_failed breadcrumb", () => {
  it("a chat turn answered in prose records parsed:chat_prose_reply, not parse_failed", async () => {
    const { r, stages } = await run("chat", PROSE);
    expect(stages).toContain("parsed:chat_prose_reply");
    expect(stages).not.toContain("parse_failed:no_envelope_block");
    expect(r.parse_ok).toBe(false);
  });

  it("a non-chat run with the same prose still records parse_failed", async () => {
    const { stages } = await run("cron", PROSE);
    expect(stages).toContain("parse_failed:no_envelope_block");
    expect(stages).not.toContain("parsed:chat_prose_reply");
  });

  it("a chat turn with only a few words still records parse_failed", async () => {
    const { stages } = await run("chat", "Done.");
    expect(stages).toContain("parse_failed:no_envelope_block");
  });

  it("the 50-character line matches the chat bubble's own rule", async () => {
    expect((await run("chat", "a".repeat(50))).stages).toContain("parse_failed:no_envelope_block");
    expect((await run("chat", "a".repeat(51))).stages).toContain("parsed:chat_prose_reply");
  });

  it("records exactly one verdict for the turn", async () => {
    const { stages } = await run("chat", PROSE);
    expect(stages.filter((x) => x === "parsed:chat_prose_reply" || x === "parse_failed:no_envelope_block")).toHaveLength(1);
  });

  it("a chat turn that opened the envelope and broke it still records parse_failed", async () => {
    const { stages } = await run("chat", `${PROSE} <strategy>{"summary": "cut off`);
    expect(stages).toContain("parse_failed:no_envelope_block");
  });
});
