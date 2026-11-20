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

import {
  runGeneric,
  PRODUCT_BUILDER_DEPENDENCY_BASELINE,
  PRODUCT_BUILDER_DB_SCHEMA_BASELINE,
  PRODUCT_BUILDER_SESSION_UID_RULE,
  PRODUCT_BUILDER_SESSION_SECRET_BASELINE,
  PRODUCT_BUILDER_REDIRECT_BASELINE,
  PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE,
  PRODUCT_BUILDER_VISUAL_BASELINE,
  PRODUCT_BUILDER_DESIGN_BASELINE,
} from "@/services/agents/generic-dispatcher";
import { buildBlessedTemplatesBaseline } from "@/services/agents/codegen-templates";
import type { AgentContext } from "@/services/agents/types";

const FIXED_BLOCKS_IN_ORDER = [
  "### DATA & PERSISTENCE BASELINE",
  PRODUCT_BUILDER_DEPENDENCY_BASELINE,
  PRODUCT_BUILDER_DB_SCHEMA_BASELINE,
  "### AUTH BASELINE",
  PRODUCT_BUILDER_SESSION_UID_RULE,
  PRODUCT_BUILDER_SESSION_SECRET_BASELINE,
  PRODUCT_BUILDER_REDIRECT_BASELINE,
  PRODUCT_BUILDER_IMAGE_DELIVERY_BASELINE,
  PRODUCT_BUILDER_VISUAL_BASELINE,
  PRODUCT_BUILDER_DESIGN_BASELINE,
  buildBlessedTemplatesBaseline(),
];

const SCAFFOLD_STRUCTURE = "### STRUCTURE BASELINE (scaffold";
const BUILD_STRUCTURE = "### STRUCTURE & DEPTH BASELINE";

function makeCtx(runId: string): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId,
    trigger: "manual",
    draft_mode: true,
    agent: {
      slug: "product-builder",
      metadata_praxis: { memory_layer: false, tools: [] as string[] },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

function payload(stage: string, idea: string, repo: string, company: string) {
  return {
    stage,
    idea,
    company_name: company,
    target: { github_full_name: repo },
    prd: `PRD for ${company}: ${idea}`,
  };
}

async function capture(runId: string, p: Record<string, unknown>): Promise<[string, string]> {
  captured.length = 0;
  await runGeneric(makeCtx(runId), p);
  expect(captured.length).toBeGreaterThan(0);
  const sp = captured[0]!.systemPrompt;
  expect(Array.isArray(sp)).toBe(true);
  const parts = sp as string[];
  expect(parts).toHaveLength(3);
  expect(parts[1]).toBe(BOUNDARY);
  return [parts[0]!, parts[2]!];
}

describe("product-builder codegen prompt: fixed baselines ride the cached prefix", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("puts every fixed baseline in the cached segment, keeps per-run values dynamic, and the cached segment is byte-identical across different builds", async () => {
    const [cachedA, dynA] = await capture(
      "run-cache-a",
      payload("scaffold", "A dog-walking marketplace for Pune", "Praxis-build/dogwalk-aaaa", "Pawsome Co"),
    );
    const [cachedB, dynB] = await capture(
      "run-cache-b",
      payload("build", "An invoice tracker for plumbers", "Praxis-build/invoices-bbbb", "PipeBooks"),
    );

    for (const block of FIXED_BLOCKS_IN_ORDER) {
      expect(block.length).toBeGreaterThan(0);
      expect(cachedA).toContain(block);
      expect(dynA).not.toContain(block);
    }
    expect(buildBlessedTemplatesBaseline().length).toBeGreaterThan(1000);

    let cursor = -1;
    for (const block of FIXED_BLOCKS_IN_ORDER) {
      const at = cachedA.indexOf(block, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }

    expect(cachedA).toBe(cachedB);

    for (const v of ["A dog-walking marketplace for Pune", "Praxis-build/dogwalk-aaaa", "Pawsome Co"]) {
      expect(dynA).toContain(v);
      expect(cachedA).not.toContain(v);
    }
    for (const v of ["An invoice tracker for plumbers", "Praxis-build/invoices-bbbb", "PipeBooks"]) {
      expect(dynB).toContain(v);
    }
    expect(dynA).toContain(SCAFFOLD_STRUCTURE);
    expect(dynA).not.toContain(BUILD_STRUCTURE);
    expect(dynB).toContain(BUILD_STRUCTURE);
    expect(dynB).not.toContain(SCAFFOLD_STRUCTURE);
    for (const cached of [cachedA, cachedB]) {
      expect(cached).not.toContain(SCAFFOLD_STRUCTURE);
      expect(cached).not.toContain(BUILD_STRUCTURE);
    }
    expect(dynA).toContain("## PRODUCT-BUILDER CODEGEN MODE");
    expect(dynA).toContain("### Codegen rules");
    expect(dynA).toContain("is injected once above from `PRODUCT_BUILDER_DESIGN_BASELINE`");
    expect(dynA).toContain("- **scaffold (this stage):**");
    expect(dynB).toContain("- **build (this stage):**");

    const full = cachedA + dynA;
    expect(full.indexOf("## PRODUCT-BUILDER CODEGEN BASELINES (Path C)")).toBeLessThan(
      full.indexOf("## PRODUCT-BUILDER CODEGEN MODE"),
    );
    expect(full.match(/### DESIGN BASELINE \(non-negotiable/g)).toHaveLength(1);
    expect(full.match(/### BLESSED TEMPLATES BASELINE/g)).toHaveLength(1);

    const fixedChars = cachedA.length - cachedA.indexOf("\n\n---\n## PRODUCT-BUILDER CODEGEN BASELINES (Path C)");
    console.log(`[cache-placement] fixed codegen chars moved to cached prefix: ${fixedChars} (~${Math.round(fixedChars / 3.5)} tokens)`);
    expect(fixedChars).toBeGreaterThan(60000);
  }, 180_000);

  it("a non-build run of the same agent keeps the cached segment free of product-builder text", async () => {
    captured.length = 0;
    await runGeneric(makeCtx("run-cache-plain"), "summarise yesterday");
    const sp = captured[0]!.systemPrompt;
    const joined = Array.isArray(sp) ? sp.join("") : (sp ?? "");
    expect(joined).not.toContain("PRODUCT-BUILDER CODEGEN BASELINES");
    expect(joined).not.toContain("### BLESSED TEMPLATES BASELINE");
  }, 180_000);
});
