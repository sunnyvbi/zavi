import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const LIVE_RULE_MARKERS = [
  "http://127.0.0.1:3000/",
  "Do not call `app_verify`",
  "A live dev server serves `/home/user/repo` on port 3000",
];
const PRIOR_RULE =
  "2. After editing, BUILD + typecheck locally in the sandbox (`npm install` if needed, then `npm run build` and/or `npm run typecheck`). Fix what breaks.";

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

function payload(stage: string, extraTarget: Record<string, unknown> = {}) {
  return {
    stage,
    idea: "An invoice tracker for plumbers",
    company_name: "PipeBooks",
    target: { github_full_name: "Praxis-build/invoices-bbbb", ...extraTarget },
    prd: "PRD for PipeBooks",
  };
}

async function codegenRules(runId: string, p: Record<string, unknown>): Promise<string> {
  captured.length = 0;
  await runGeneric(makeCtx(runId), p);
  expect(captured.length).toBeGreaterThan(0);
  const sp = captured[0]!.systemPrompt;
  const joined = Array.isArray(sp) ? sp.join("") : (sp ?? "");
  const at = joined.indexOf("### Codegen rules");
  expect(at).toBeGreaterThan(-1);
  return joined.slice(at, joined.indexOf("\n3. Do NOT open a PR", at));
}

function expectPriorRule(rules: string) {
  expect(rules).toContain(PRIOR_RULE);
  for (const m of LIVE_RULE_MARKERS) expect(rules).not.toContain(m);
}

describe("codegen rule 2: the curl-3000 check only rides runs that boot a dev server", () => {
  const saved = process.env.INSTANT_PREVIEW_ENABLED;
  beforeEach(() => {
    captured.length = 0;
    delete process.env.INSTANT_PREVIEW_ENABLED;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INSTANT_PREVIEW_ENABLED;
    else process.env.INSTANT_PREVIEW_ENABLED = saved;
  });

  it("a first-build scaffold with preview on gets the live dev-server rule", async () => {
    const rules = await codegenRules("run-rule-scaffold", payload("scaffold"));
    for (const m of LIVE_RULE_MARKERS) expect(rules).toContain(m);
    expect(rules).not.toContain(PRIOR_RULE);
  }, 180_000);

  it("the first-build build stage also gets the live dev-server rule, since the preview serves its repo too", async () => {
    const rules = await codegenRules("run-rule-build", payload("build"));
    for (const m of LIVE_RULE_MARKERS) expect(rules).toContain(m);
    expect(rules).not.toContain(PRIOR_RULE);
  }, 180_000);

  it("a build stage into the user's own repo keeps the prior build + typecheck rule", async () => {
    expectPriorRule(
      await codegenRules("run-rule-build-user-repo", payload("build", { github_target_mode: "user_repo" })),
    );
  }, 180_000);

  it("a scaffold with the preview kill-switch off keeps the prior rule", async () => {
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    expectPriorRule(await codegenRules("run-rule-preview-off", payload("scaffold")));
  }, 180_000);

  it("a scaffold into the user's own repo, which never boots the first-build preview, keeps the prior rule", async () => {
    expectPriorRule(
      await codegenRules("run-rule-user-repo", payload("scaffold", { github_target_mode: "user_repo" })),
    );
  }, 180_000);
});
