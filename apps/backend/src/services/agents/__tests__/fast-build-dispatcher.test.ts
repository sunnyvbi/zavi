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
vi.mock("deepagents", () => ({ createDeepAgent: () => { throw new Error("not used in this test"); } }));
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
  captured: [] as { systemPrompt?: string | string[]; maxTurns?: number }[],
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: BOUNDARY,
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: {
    prompt: AsyncIterable<unknown> | string;
    options: { systemPrompt?: string | string[]; maxTurns?: number };
  }) {
    if (typeof args.prompt !== "string") for await (const _ of args.prompt) void _;
    captured.push({ systemPrompt: args.options?.systemPrompt, maxTurns: args.options?.maxTurns });
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

const IDEA = "A class booking site for a small studio";
const REPO = "praxis-built/studio-abc123";

async function run(p: Record<string, unknown>): Promise<{ prompt: string; maxTurns?: number }> {
  captured.length = 0;
  await runGeneric(makeCtx(`run-${Math.random()}`), p);
  expect(captured.length).toBeGreaterThan(0);
  const sp = captured[0]!.systemPrompt;
  return { prompt: Array.isArray(sp) ? sp.join("") : (sp ?? ""), maxTurns: captured[0]!.maxTurns };
}

const site = { stage: "build", fast_single_pass: true, site_id: "site-1", site_backend: "dedicated", idea: IDEA, company_name: "Studio Co", target: { github_full_name: REPO } };

describe("fast single pass prompt", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("uses the fast prompt instead of the scaffold/build baselines, with turn cap 60", async () => {
    const fast = await run(site);
    expect(fast.prompt).toContain("## FAST SITE BUILD: one pass (Vite + React + Supabase)");
    expect(fast.prompt).toContain(IDEA);
    expect(fast.prompt).toContain(REPO);
    for (const baseline of [
      "PRODUCT-BUILDER CODEGEN BASELINES",
      "## PRODUCT-BUILDER CODEGEN MODE",
      "### DESIGN BASELINE (non-negotiable",
      "### BLESSED TEMPLATES BASELINE",
      "### STRUCTURE & DEPTH BASELINE",
    ]) {
      expect(fast.prompt).not.toContain(baseline);
    }
    expect(fast.maxTurns).toBe(60);

    const today = await run({ stage: "build", idea: IDEA, company_name: "Studio Co", target: { github_full_name: REPO } });
    expect(today.prompt).toContain("PRODUCT-BUILDER CODEGEN BASELINES");
    expect(fast.prompt.length).toBeLessThan(today.prompt.length - 50_000);
    expect(today.maxTurns).not.toBe(60);
  }, 180_000);

  it("a site fix pass keeps the fast prompt and carries the failure", async () => {
    const fix = await run({ ...site, repair_mode: true, repair_attempt: 1, failure_signal: "smoke: login journey failed" });
    expect(fix.prompt).toContain("### FIX PASS #1");
    expect(fix.prompt).toContain("smoke: login journey failed");
    expect(fix.prompt).not.toContain("## PRODUCT-REFINE MODE");
    expect(fix.maxTurns).toBe(60);
  }, 180_000);

  it("the one screenshot-review fix pass is time-bounded by its own smaller turn cap; a functional fix pass is not", async () => {
    const visual = await run({ ...site, repair_mode: true, repair_attempt: 1, vision_fix: true, failure_signal: "a screenshot review reported the menu overlapping at phone width" });
    expect(visual.prompt).toContain("### FIX PASS #1");
    expect(visual.maxTurns).toBe(20);
    const functional = await run({ ...site, repair_mode: true, repair_attempt: 2, failure_signal: "smoke: login journey failed" });
    expect(functional.maxTurns).toBe(60);
  }, 180_000);

  it("adds the default-on site quality rules to the fast prompt and the site identity rule to the old-flow codegen prompt", async () => {
    const fast = await run({ ...site, reference_images: ["https://img/a.png"] });
    expect(fast.prompt).toMatch(/\n9\. Every page fits a 375px-wide phone/);
    expect(fast.prompt).toMatch(/\n10\. Give the site its identity in `index.html`/);
    expect(fast.prompt).toContain("public/reference/<name>.jpg");
    const old = await run({ stage: "build", idea: IDEA, company_name: "Studio Co", target: { github_full_name: REPO } });
    expect(old.prompt).toMatch(/\n5\. Give the site its identity in `app\/layout\.tsx` metadata/);
    expect(old.prompt).toContain("app/icon.svg");
    expect(old.prompt).toContain("app/not-found.tsx");
    expect(old.prompt).not.toContain("Every page fits a 375px-wide phone");
  }, 180_000);

  it("the first pass asks for the site's photos (the brief's plan when it has one); a fix pass does not", async () => {
    const plain = await run(site);
    expect(plain.prompt).toContain("### Images and icons");
    expect(plain.prompt).toContain("add_site_images");
    const planned = await run({
      ...site,
      design_brief: { imagery: { subjects: ["a groomer drying a spaniel in a bright van"], style: "warm daylight" } },
    });
    expect(planned.prompt).toContain("a groomer drying a spaniel in a bright van");
    const none = await run({ ...site, design_brief: { imagery: { subjects: [], style: "" } } });
    expect(none.prompt).toContain("The founder asked for no photos");
    const fix = await run({ ...site, repair_mode: true, repair_attempt: 1, failure_signal: "smoke: login journey failed" });
    expect(fix.prompt).not.toContain("### Images and icons");
  }, 180_000);

  it("passes founder reference images (https only, max 3)", async () => {
    const r = await run({ ...site, reference_images: ["https://img/a.png", "http://insecure/b.png", "https://img/c.png"] });
    expect(r.prompt).toContain("### Founder's reference images");
    expect(r.prompt).toContain("https://img/a.png");
    expect(r.prompt).not.toContain("http://insecure/b.png");
  }, 180_000);
});
