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

const h = vi.hoisted(() => ({
  queryCalls: 0,
  engineCalls: [] as Array<{ provider: string; spec: Record<string, unknown> }>,
  funnelDeps: [] as Array<Record<string, unknown>>,
  engineToolCalls: [] as Array<{ tool_name: string; input: unknown }>,
  fakeSandboxContent: null as string | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__B__",
  createSdkMcpServer: () => ({ name: "stub", instance: {} }),
  tool: (name: string) => ({ name }),
  query: vi.fn(async function* (args: { prompt: AsyncIterable<unknown> | string }) {
    if (typeof args.prompt !== "string") for await (const _ of args.prompt) void _;
    h.queryCalls += 1;
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "s",
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
vi.mock("@/services/agents/setup-schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/setup-schema")>()),
  probeSetupCompleteness: async () => ({
    ok: true,
    missing_vault_keys: [],
    missing_connectors: [],
    missing_required_connectors: [],
    missing_optional_connectors: [],
  }),
}));
vi.mock("@/services/agents/kill-switch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/kill-switch")>()),
  isAgentKilled: async () => false,
}));
vi.mock("@/services/agents/run-stop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/run-stop")>()),
  isRunStopRequested: async () => false,
}));
vi.mock("@/services/agents/engine/pick-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/engine/pick-engine")>()),
  pickEngine: (provider: string) => ({
    provider,
    async *run(spec: Record<string, unknown>) {
      h.engineCalls.push({ provider, spec });
      const dispatchTool = spec.dispatchTool as ((c: unknown) => Promise<unknown>) | undefined;
      for (const c of h.engineToolCalls) {
        const [server_id, bare_tool_name] = c.tool_name.split("__");
        await dispatchTool?.({ ...c, server_id, bare_tool_name, tool_use_id: `tu-${bare_tool_name}` });
      }
      yield {
        type: "terminal",
        resume: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    },
  }),
}));
vi.mock("@/services/agents/engine/dispatch-tool", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/agents/engine/dispatch-tool")>();
  return {
    ...real,
    makeDispatchTool: (deps: Parameters<typeof real.makeDispatchTool>[0]) => {
      h.funnelDeps.push(deps as unknown as Record<string, unknown>);
      if (h.fakeSandboxContent !== null && deps.sandboxMode === "live") {
        const content = h.fakeSandboxContent;
        return real.makeDispatchTool({
          ...deps,
          sandboxExecutor: async () => ({ is_error: false, content, ms: 3 }),
        });
      }
      return real.makeDispatchTool(deps);
    },
  };
});

import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(slug: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: `run-${slug}`,
    trigger: "manual",
    draft_mode: true,
    agent: { slug, body_markdown: `You are the ${slug} test agent.`, metadata_praxis: { memory_layer: false, tools: [] as string[], ...meta } },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
    ...over,
  } as unknown as AgentContext;
}

async function run(ctx: AgentContext, payload: unknown): Promise<{ tool_calls?: Array<Record<string, unknown>> } | null> {
  try {
    return (await runGeneric(ctx, payload)) as unknown as { tool_calls?: Array<Record<string, unknown>> };
  } catch (e) {
    void e;
    return null;
  }
}

const openrouterCall = () => h.engineCalls.find((c) => c.provider === "openrouter");
const altFunnel = () => h.funnelDeps[h.funnelDeps.length - 1];

beforeEach(() => {
  h.queryCalls = 0;
  h.engineCalls.length = 0;
  h.funnelDeps.length = 0;
  h.engineToolCalls.length = 0;
  h.fakeSandboxContent = null;
});

describe("staff ?model= dispatcher wiring (real runGeneric)", () => {
  it("operator on qwen: OpenRouter engine, pinned model + upstream, turn latch, operator gate on the alt funnel", async () => {
    await run(makeCtx("operator"), { staff_model: { key: "qwen" } });
    const c = openrouterCall();
    expect(c).toBeDefined();
    expect(c!.spec.model).toBe("qwen/qwen3.8-27b");
    expect(c!.spec.openRouterUpstream).toBe("DeepInfra");
    expect(typeof c!.spec.onAssistantTurn).toBe("function");
    const deps = altFunnel();
    expect(typeof deps.operatorPreCheck).toBe("function");
    expect(typeof deps.operatorSettle).toBe("function");
    expect(h.queryCalls).toBe(0);
  }, 120_000);

  it("a caller-forged model_id / upstream in the payload is ignored (re-derived from the key)", async () => {
    await run(makeCtx("operator"), { staff_model: { key: "qwen", model_id: "evil/x", upstream: "Evil" } });
    const c = openrouterCall();
    expect(c!.spec.model).toBe("qwen/qwen3.8-27b");
    expect(c!.spec.openRouterUpstream).toBe("DeepInfra");
  }, 120_000);

  it("engineer on qwen: OpenRouter engine + LIVE sandbox executor and sandbox__ tools", async () => {
    await run(
      makeCtx(
        "engineer",
        { worker_sandbox: { repo_full_name: "acme/app", e2b_sandbox_id: "sbx-1" } },
        { requires_sandbox: true, tools: ["view", "run_tests", "emit_artifact"] },
      ),
      { staff_model: { key: "qwen" }, repo_hint: "acme/app" },
    );
    const c = openrouterCall();
    expect(c).toBeDefined();
    expect(c!.spec.model).toBe("qwen/qwen3.8-27b");
    expect(c!.spec.onAssistantTurn).toBeUndefined();
    const deps = altFunnel();
    expect(deps.sandboxMode).toBe("live");
    expect(typeof deps.sandboxExecutor).toBe("function");
    expect(deps.operatorPreCheck).toBeUndefined();
    const names = (c!.spec.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["sandbox__view", "sandbox__run_tests", "sandbox__emit_artifact"]));
  }, 120_000);

  it("engineer on qwen: a passing sandbox run_tests lands a passing test receipt on its trace row", async () => {
    h.engineToolCalls.push({ tool_name: "sandbox__run_tests", input: { command: "npm test" } });
    h.fakeSandboxContent = JSON.stringify({ exit_code: 0, stdout: "Tests: 2 passed", stderr: "" });
    const out = await run(
      makeCtx(
        "engineer",
        { worker_sandbox: { repo_full_name: "acme/app", e2b_sandbox_id: "sbx-1" } },
        { requires_sandbox: true, tools: ["view", "run_tests"] },
      ),
      { staff_model: { key: "qwen" }, repo_hint: "acme/app" },
    );
    expect(typeof altFunnel().onSandboxResult).toBe("function");
    expect(out).not.toBeNull();
    const row = out!.tool_calls!.find((t) => t.name === "sandbox__run_tests");
    expect(row?.test_receipt).toMatchObject({ status: "passed", exit_code: 0 });
  }, 120_000);

  it("product-builder on qwen, website build: sandbox__add_site_images is on the live tool set (as on the Claude path)", async () => {
    await run(
      makeCtx(
        "product-builder",
        { worker_sandbox: { repo_full_name: "acme/site", e2b_sandbox_id: "sbx-2" } },
        { requires_sandbox: true, tools: ["view", "create"] },
      ),
      { staff_model: { key: "qwen" }, repo_hint: "acme/site", site_id: "site-1", site_backend: "pooled", target: { github_full_name: "acme/site" } },
    );
    const c = openrouterCall();
    expect(c).toBeDefined();
    expect(altFunnel().sandboxMode).toBe("live");
    const names = (c!.spec.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["sandbox__view", "sandbox__create", "sandbox__add_site_images"]));
  }, 120_000);

  it("engineer on qwen, no website payload: no add_site_images", async () => {
    await run(
      makeCtx(
        "engineer",
        { worker_sandbox: { repo_full_name: "acme/app", e2b_sandbox_id: "sbx-1" } },
        { requires_sandbox: true, tools: ["view"] },
      ),
      { staff_model: { key: "qwen" }, repo_hint: "acme/app" },
    );
    const names = (openrouterCall()!.spec.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("sandbox__add_site_images");
  }, 120_000);

  it("research with no payload model: no OpenRouter engine, inline Claude path (unchanged)", async () => {
    await run(makeCtx("research"), {});
    expect(openrouterCall()).toBeUndefined();
    expect(h.queryCalls).toBeGreaterThan(0);
  }, 120_000);

  it("operator with no payload model: still pinned to the inline Claude path", async () => {
    await run(makeCtx("operator"), {});
    expect(openrouterCall()).toBeUndefined();
    expect(h.queryCalls).toBeGreaterThan(0);
  }, 120_000);

  it("a Claude variant (opus-high) never touches OpenRouter", async () => {
    await run(makeCtx("operator"), { staff_model: { key: "opus-high" } });
    expect(openrouterCall()).toBeUndefined();
    expect(h.queryCalls).toBeGreaterThan(0);
  }, 120_000);
});
