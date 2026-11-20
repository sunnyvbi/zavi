import { describe, it, expect, vi } from "vitest";

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

const { BOUNDARY, captured } = vi.hoisted(() => ({
  BOUNDARY: "__TEST_DYNAMIC_BOUNDARY__",
  captured: [] as { systemPrompt?: string | string[] }[],
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: BOUNDARY,
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: {
    prompt: AsyncIterable<unknown> | string;
    options: { systemPrompt?: string | string[] };
  }) {
    if (typeof args.prompt !== "string") for await (const _ of args.prompt) void _;
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

vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/mcp/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/mcp/discovery")>()),
  discoverToolsForTenant: vi.fn(async () => ({ tools: [], disconnected_connectors: [] })),
}));
import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";

const IDEA = "A landing page for my plumbing invoice tracker";
const RULE = "The idea outranks the company profile, memory notes and the PRD on what the product is.";

function ctx(): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "run-idea-outranks",
    trigger: "manual",
    draft_mode: true,
    agent: { slug: "product-builder", metadata_praxis: { memory_layer: false, tools: [] as string[] } },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

async function codegenPrompt(stage: string): Promise<string> {
  captured.length = 0;
  await runGeneric(ctx(), {
    stage,
    idea: IDEA,
    company_name: "Pawsome Co",
    target: { github_full_name: "Praxis-build/pawsome-co-aaaa" },
    prd: "PRD: Pawsome Co dog-walking marketplace landing page",
  });
  expect(captured.length).toBeGreaterThan(0);
  const sp = captured[0]!.systemPrompt;
  return Array.isArray(sp) ? sp.join("") : (sp ?? "");
}

describe("product-builder codegen prompt: the founder's idea outranks the company record", () => {
  for (const stage of ["scaffold", "build"]) {
    it(`${stage}: the rule heads the idea block, ahead of the idea and the PRD`, async () => {
      const prompt = await codegenPrompt(stage);
      const rule = prompt.indexOf(RULE);
      expect(rule).toBeGreaterThan(-1);
      expect(prompt.indexOf("### The product to build")).toBeLessThan(rule);
      expect(rule).toBeLessThan(prompt.indexOf(IDEA));
      expect(rule).toBeLessThan(prompt.indexOf("PRD: Pawsome Co"));
      expect(prompt).not.toContain("brand-new product for **Pawsome Co**");
      expect(prompt).not.toContain("Use the company name `Pawsome Co` for the footer copyright line");
      expect(prompt).toMatch(/footer copyright line with the product's own name from the idea; use the workspace name `Pawsome Co` only when the idea is about that same business/);
      expect(prompt).toMatch(/header, headlines, page title, metadata or footer/);
    }, 180_000);
  }
});
