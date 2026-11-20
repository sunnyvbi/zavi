
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
  discoverToolsForTenant: async (_t: string, declared: string[]) => ({
    tools: declared.map((name) => ({ name, description: name, input_schema: { type: "object", properties: {} }, execute: async () => ({}) })),
    disconnected_connectors: [],
  }),
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

vi.mock("@/services/email-learnings/note", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/email-learnings/note")>();
  return {
    ...real,
    emailLearningsNoteForRun: vi.fn(async (a: { resolvedToolNames: readonly string[] }) =>
      real.canDraftEmail(a.resolvedToolNames) ? `${real.NOTE_HEAD}\n- "LESSON-MARKER"` : null,
    ),
  };
});

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(trigger: string, tools: string[], slug = "email_marketing", payload?: Record<string, unknown>): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: `run-learn-${trigger}-${slug}`,
    trigger,
    draft_mode: true,
    citedNotes: new Map(),
    ...(payload ? { payload } : {}),
    agent: {
      slug,
      body_markdown: "# Agent",
      metadata_praxis: { memory_layer: false, tools, model: "claude-sonnet-4-6" },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

const copies = (s: string) => s.split("LESSON-MARKER").length - 1;
const lastMarker = (s: string) => s.lastIndexOf("LESSON-MARKER") > s.lastIndexOf("Run context");

beforeEach(() => {
  seen.prompts = [];
});

describe("What we learned reaches the SDK prompt of every run that can draft an email", () => {
  it.each(["channel_recipe", "chat", "slack"])("an email-drafting run on %s: exactly one copy, last", async (trigger) => {
    await runGeneric(makeCtx(trigger, ["email__propose_campaign"]), "Draft a new email for one of my lists");
    expect(seen.prompts.length, "SDK was never called").toBeGreaterThan(0);
    expect(copies(seen.prompts[0])).toBe(1);
    expect(lastMarker(seen.prompts[0])).toBe(true);
  });

  it("a growth-lead run holding the propose tool gets it too", async () => {
    await runGeneric(makeCtx("channel_recipe", ["email__propose_campaign"], "growth-lead"), "Plan the winback email");
    expect(copies(seen.prompts[0])).toBe(1);
  });

  it("a run cgo briefed: the note comes after the brief and its reply contract (it stays last)", async () => {
    const payload = {
      channel_slug: "email_marketing",
      cgo_brief: {
        goal: { objective: "More trial signups", target_metric: "signups", current_value: 10, target_value: 20, number_trusted: true, due_date: null },
        judged_on: "signups from email",
        problem: "Few signups from the newsletter",
        boundaries: ["One email."],
      },
    };
    await runGeneric(makeCtx("channel_recipe", ["email__propose_campaign"]), payload);
    const p = seen.prompts[0];
    expect(copies(p)).toBe(1);
    expect(p).toContain("Reply to cgo");
    expect(p.lastIndexOf("LESSON-MARKER")).toBeGreaterThan(p.lastIndexOf("Reply to cgo"));
  });

  it("must catch: a run that cannot draft an email gets none", async () => {
    await runGeneric(makeCtx("chat", ["web_search"], "research"), "what changed this week?");
    expect(seen.prompts.length, "SDK was never called").toBeGreaterThan(0);
    expect(copies(seen.prompts[0])).toBe(0);
  });
});
