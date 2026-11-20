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

import { runGeneric, isFreshProductBuildPayload, isInfraFailureSignal } from "@/services/agents/generic-dispatcher";
import type { AgentContext, AgentRunSummary } from "@/services/agents/types";

const OLD_APP = "LAPTOP_RENTAL_PRIOR_BUILD_7f3a laptop rental checkout with laptop inventory";
const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function priorRuns(): AgentRunSummary[] {
  return ["pm", "engineer", "qa"].map((slug, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    agent_slug: slug,
    tenant_id: TENANT,
    finished_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    status: "success",
    output_text: `${OLD_APP} (${slug})`,
  }));
}

function makeCtx(slug: string, runId: string, trigger: string) {
  const scan = vi.fn(async () => priorRuns());
  const ctx = {
    tenant_id: TENANT,
    runId,
    trigger,
    draft_mode: true,
    agent: { slug, metadata_praxis: { memory_layer: false, tools: [] as string[] } },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: scan,
  } as unknown as AgentContext;
  return { ctx, scan };
}

const conductorId = "11111111-2222-4333-8444-555555555555";

function buildPayload(stage: string, extra: Record<string, unknown> = {}) {
  return {
    stage,
    idea: "A house rental marketplace for Goa villas",
    company_name: "Casa Goa",
    target: { github_full_name: "Praxis-build/house-rental-abcd" },
    prd: "PRD: house rental listings, bookings, host dashboard",
    build_conductor_run_id: conductorId,
    ...extra,
  };
}

async function promptFor(slug: string, runId: string, p: unknown, trigger = "a2a"): Promise<string> {
  captured.length = 0;
  cachedSegments.length = 0;
  const { ctx, scan } = makeCtx(slug, runId, trigger);
  await runGeneric(ctx, p);
  expect(scan).toHaveBeenCalled();
  expect(captured.length).toBeGreaterThan(0);
  return captured.join("\n");
}

describe("recent_runs isolation for fresh product builds", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it.each([
    ["pm", "spec"],
    ["engineer", "scaffold"],
    ["engineer", "build"],
    ["qa", "qa"],
  ])("%s %s run of a fresh build never sees another build's output", async (slug, stage) => {
    const prompt = await promptFor(slug, `run-fresh-${stage}`, buildPayload(stage));
    expect(prompt).toContain("house rental");
    expect(prompt).not.toContain("LAPTOP_RENTAL_PRIOR_BUILD_7f3a");
    expect(prompt).not.toMatch(/laptop/i);
  }, 180_000);

  it("a refine run still gets the tenant's recent_runs", async () => {
    const prompt = await promptFor(
      "engineer",
      "run-refine",
      buildPayload("build", { refine_mode: true, user_request: "make the header blue" }),
    );
    expect(prompt).toContain("LAPTOP_RENTAL_PRIOR_BUILD_7f3a");
    expect(prompt.match(/LAPTOP_RENTAL_PRIOR_BUILD_7f3a/g)!.length).toBeGreaterThanOrEqual(3);
  }, 180_000);

  it("a non-build run keeps recent_runs", async () => {
    for (const slug of ["pm", "research"]) {
      const prompt = await promptFor(slug, `run-plain-${slug}`, "summarise yesterday", "manual");
      expect(prompt).toContain("LAPTOP_RENTAL_PRIOR_BUILD_7f3a");
    }
  }, 180_000);

  it("classifies payloads", () => {
    expect(isFreshProductBuildPayload(buildPayload("spec"))).toBe(true);
    expect(isFreshProductBuildPayload(buildPayload("qa"))).toBe(true);
    expect(isFreshProductBuildPayload(buildPayload("build", { refine_mode: true }))).toBe(false);
    expect(isFreshProductBuildPayload(buildPayload("deploy"))).toBe(false);
    expect(isFreshProductBuildPayload({ task: "x" })).toBe(false);
    expect(isFreshProductBuildPayload("spec")).toBe(false);
    expect(isFreshProductBuildPayload(null)).toBe(false);
  });
});

const CODE_ERROR = "Type error: TS2322 Type 'string' is not assignable to type 'number' in app/listings/page.tsx:42";
const INFRA_ERROR = "Sandbox sbx_9f2 not found: the workspace went offline during the stage";
const INFRA_NOTE = "failed for an infrastructure reason unrelated to the code";

describe("fresh-build codegen repair shows the previous failure", () => {
  it.each(["scaffold", "build"])("%s repair with a code error renders the failure block in the dynamic part", async (stage) => {
    const prompt = await promptFor(
      "engineer",
      `run-repair-code-${stage}`,
      buildPayload(stage, { repair_mode: true, repair_attempt: 2, failure_signal: CODE_ERROR }),
    );
    expect(prompt).toContain("REPAIR ATTEMPT #2");
    expect(prompt).toMatch(/previous_failure[\s\S]{0,3000}TS2322/);
    expect(prompt).not.toContain(INFRA_NOTE);
    expect(prompt).not.toContain("LAPTOP_RENTAL_PRIOR_BUILD_7f3a");
    expect(cachedSegments.length).toBeGreaterThan(0);
    for (const seg of cachedSegments) {
      expect(seg).not.toContain("TS2322");
      expect(seg).not.toContain("REPAIR ATTEMPT");
    }
  }, 180_000);

  it("a repair after an infrastructure outage gets the infra note, not the error to fix", async () => {
    const prompt = await promptFor(
      "engineer",
      "run-repair-infra",
      buildPayload("scaffold", { repair_mode: true, repair_attempt: 1, failure_signal: INFRA_ERROR }),
    );
    expect(prompt).toContain("REPAIR ATTEMPT #1");
    expect(prompt).toContain(INFRA_NOTE);
    expect(prompt).not.toContain("previous_failure");
    expect(prompt).not.toContain("fix THIS, then rebuild");
  }, 180_000);

  it("a non-repair codegen run has no repair text", async () => {
    const prompt = await promptFor("engineer", "run-no-repair", buildPayload("scaffold"));
    expect(prompt).toContain("## PRODUCT-BUILDER CODEGEN MODE");
    expect(prompt).not.toContain("REPAIR ATTEMPT");
    expect(prompt).not.toContain(INFRA_NOTE);
  }, 180_000);

  it("a refine repair still renders the failure block", async () => {
    const prompt = await promptFor(
      "engineer",
      "run-refine-repair",
      buildPayload("build", { refine_mode: true, repair_mode: true, repair_attempt: 3, failure_signal: CODE_ERROR }),
    );
    expect(prompt).toContain("REPAIR ATTEMPT #3");
    expect(prompt).toContain("TS2322");
  }, 180_000);

  it("classifies failure signals", () => {
    expect(isInfraFailureSignal(INFRA_ERROR)).toBe(true);
    expect(isInfraFailureSignal("connect ECONNREFUSED 10.0.0.4:49983")).toBe(true);
    expect(isInfraFailureSignal("read ECONNRESET")).toBe(true);
    expect(isInfraFailureSignal("sandbox command timed out after 600s")).toBe(true);
    expect(isInfraFailureSignal(CODE_ERROR)).toBe(false);
    expect(isInfraFailureSignal("sandbox typecheck failed: TS2304 Cannot find name 'db'")).toBe(false);
    expect(isInfraFailureSignal("Module not found: Can't resolve '@/lib/db'")).toBe(false);
    expect(isInfraFailureSignal('stage "build" failed')).toBe(false);
  });
});
