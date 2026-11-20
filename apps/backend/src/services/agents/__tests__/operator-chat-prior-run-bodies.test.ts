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

const { BOUNDARY, captured, cachedSegments } = vi.hoisted(() => ({
  BOUNDARY: "__TEST_DYNAMIC_BOUNDARY__",
  captured: [] as string[],
  cachedSegments: [] as string[],
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: BOUNDARY,
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: {
    prompt: AsyncIterable<unknown> | string;
    options: { systemPrompt?: string | string[] };
  }) {
    const parts: unknown[] = [args.options?.systemPrompt];
    if (typeof args.prompt === "string") parts.push(args.prompt);
    else for await (const m of args.prompt) parts.push(m);
    captured.push(JSON.stringify(parts));
    const sp = args.options?.systemPrompt;
    if (Array.isArray(sp)) cachedSegments.push(sp[0] ?? "");
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "test-session",
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
  discoverToolsForTenant: vi.fn(async () => ({ tools: [], disconnected_connectors: [] })),
}));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext, AgentRunSummary } from "@/services/agents/types";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const PRIOR_BODY = "PRIOR_BODY_SENTINEL_9c1e: 41 are actually ready, about $2,258 last week";
const MARKER = "(prior run — output not included)";
const FAILED_ROW_STATUS = /status\\*"\s*:\s*\\*"didn't run/;

function priorRuns(): AgentRunSummary[] {
  return ["operator", "research", "pm"].map((slug, i) => ({
    id: `00000000-0000-4000-8000-00000000010${i}`,
    agent_slug: slug,
    tenant_id: TENANT,
    finished_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    status: i === 1 ? "dispatch_error" : "success",
    output_text: `${PRIOR_BODY} (${slug})`,
  }));
}

async function promptFor(slug: string, trigger: string, payload: unknown): Promise<string> {
  captured.length = 0;
  const scan = vi.fn(async () => priorRuns());
  const ctx = {
    tenant_id: TENANT,
    runId: `run-${slug}-${trigger}-${Math.random().toString(36).slice(2)}`,
    trigger,
    draft_mode: true,
    agent: {
      slug,
      body_markdown: `You are the ${slug} agent.`,
      metadata_praxis: { memory_layer: false, tools: [] as string[] },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: scan,
  } as unknown as AgentContext;
  await runGeneric(ctx, payload);
  expect(scan).toHaveBeenCalled();
  expect(captured.length).toBeGreaterThan(0);
  return captured.join("\n");
}

const TURN_1 = { prior_messages: [], current_message: "how many are ready right now?" };
const TURN_2 = {
  prior_messages: [
    { role: "user", content: "how many are ready right now?" },
    { role: "assistant", content: "Let me check the live data." },
  ],
  current_message: "and what was revenue last week?",
};

describe("operator web chat hides prior-run bodies on every turn", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it.each([
    ["turn 1", TURN_1],
    ["turn 2", TURN_2],
  ])("operator chat %s: agent names + marker, no prior body or run health", async (_label, payload) => {
    const prompt = await promptFor("operator", "chat", payload);
    expect(prompt).not.toContain("PRIOR_BODY_SENTINEL_9c1e");
    expect(prompt).not.toContain("$2,258");
    expect(prompt).toContain(MARKER);
    expect(prompt).toMatch(/\\"agent_slug\\":\s*\\"research\\"/);
    expect(prompt).toContain("not available");
    expect(prompt).not.toMatch(FAILED_ROW_STATUS);
    expect(prompt).toContain(payload.current_message);
  }, 180_000);

  it("operator slack keeps hiding bodies (unchanged)", async () => {
    const prompt = await promptFor("operator", "slack", { slack: { text: "what's new?" } });
    expect(prompt).not.toContain("PRIOR_BODY_SENTINEL_9c1e");
    expect(prompt).toContain(MARKER);
  }, 180_000);

  it.each([
    ["pm", "chat"],
    ["operator", "teams"],
    ["operator", "manual"],
  ])("%s on %s keeps prior-run bodies (unchanged)", async (slug, trigger) => {
    const payload = trigger === "chat" ? TURN_2 : "summarise what changed";
    const prompt = await promptFor(slug, trigger, payload);
    expect(prompt).toContain("PRIOR_BODY_SENTINEL_9c1e");
    expect(prompt).not.toContain(MARKER);
    expect(prompt).toMatch(FAILED_ROW_STATUS);
  }, 180_000);
});
