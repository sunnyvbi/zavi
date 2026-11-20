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

const { settingOff } = vi.hoisted(() => ({ settingOff: new Set<string>() }));
vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string, tenant?: string | null) =>
      settingOff.has(key) ? false : actual.getBoolSetting(key as never, tenant),
    ),
  };
});

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { previewServesBuildRepo } from "@/services/build/first-build-preview";
import type { AgentContext } from "@/services/agents/types";

const SAFE_RULE = "never run `npm run build`, `next build` or `npm start` inside `/home/user/repo`";
const BUILD_COPY = "cd /tmp/verify && npm run build";
const UNSAFE_RULE = "2. After editing, BUILD + typecheck locally in the sandbox (`npm install` if needed, then `npm run build`";

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

function payload(stage: string, extra: Record<string, unknown> = {}) {
  return {
    stage,
    idea: "A booking site for a dog grooming salon",
    company_name: "Paws & Suds",
    target: { github_full_name: "Praxis-build/paws-aaaa" },
    prd: "PRD for Paws & Suds",
    ...extra,
  };
}

async function prompt(runId: string, p: Record<string, unknown>): Promise<string> {
  captured.length = 0;
  await runGeneric(makeCtx(runId), p);
  expect(captured.length).toBeGreaterThan(0);
  const sp = captured[0]!.systemPrompt;
  return Array.isArray(sp) ? sp.join("\n") : String(sp ?? "");
}

describe("DEL-1323 B22: the build stage never runs next build inside the repo the live preview serves", () => {
  beforeEach(() => {
    captured.length = 0;
    settingOff.clear();
    delete process.env.INSTANT_PREVIEW_ENABLED;
  });

  it("'Building the interface' (stage build) builds a copy in /tmp and never tells the model to run npm run build in the served repo", async () => {
    const text = await prompt("run-b22-build", payload("build"));
    expect(text).toContain("## PRODUCT-BUILDER CODEGEN MODE");
    expect(text).toContain("- **build (this stage):**");
    expect(text).toContain(SAFE_RULE);
    expect(text).toContain(BUILD_COPY);
    expect(text).toContain("Do not call `app_verify`");
    expect(text).not.toContain(UNSAFE_RULE);
  }, 180_000);

  it("a build-stage repair attempt on the same preview is safe too", async () => {
    const text = await prompt("run-b22-repair", payload("build", { repair_mode: true, repair_attempt: 1 }));
    expect(text).toContain(SAFE_RULE);
    expect(text).not.toContain(UNSAFE_RULE);
  }, 180_000);

  it("scaffold keeps the safe rule it already had", async () => {
    const text = await prompt("run-b22-scaffold", payload("scaffold"));
    expect(text).toContain(SAFE_RULE);
    expect(text).not.toContain(UNSAFE_RULE);
  }, 180_000);

  it("a build on the founder's own repo has no Zavi preview on it and keeps the plain build rule", async () => {
    const text = await prompt(
      "run-b22-user-repo",
      payload("build", { target: { github_full_name: "acme/site", github_target_mode: "user_repo" } }),
    );
    expect(text).toContain(UNSAFE_RULE);
    expect(text).not.toContain(SAFE_RULE);
  }, 180_000);

  it("with the instant preview switched off there is no dev server, so the plain build rule stays", async () => {
    process.env.INSTANT_PREVIEW_ENABLED = "0";
    const text = await prompt("run-b22-no-preview", payload("build"));
    expect(text).toContain(UNSAFE_RULE);
    expect(text).not.toContain(SAFE_RULE);
  }, 180_000);

  it("with build_preview_safe_verify off the build stage is exactly as before, and scaffold is unchanged", async () => {
    settingOff.add("build_preview_safe_verify");
    const build = await prompt("run-b22-off-build", payload("build"));
    expect(build).toContain(UNSAFE_RULE);
    expect(build).not.toContain(SAFE_RULE);
    const repair = await prompt("run-b22-off-scaffold-repair", payload("scaffold", { repair_mode: true }));
    expect(repair).toContain(UNSAFE_RULE);
    const scaffold = await prompt("run-b22-off-scaffold", payload("scaffold"));
    expect(scaffold).toContain(SAFE_RULE);
  }, 180_000);
});

describe("codegen is told to copy the founder's reference images into the repo, never hotlink the signed URLs", () => {
  beforeEach(() => {
    captured.length = 0;
    settingOff.clear();
    delete process.env.INSTANT_PREVIEW_ENABLED;
  });

  it("scaffold and build carry the signed URLs with the 7-day download rule; no references means no block", async () => {
    const url = "https://store.example/object/sign/idea/a.jpg?token=abc";
    for (const stage of ["scaffold", "build"]) {
      const text = await prompt(`run-refs-${stage}`, payload(stage, { reference_images: [url, 42, "http://insecure/x.jpg"] }));
      const block = text.slice(text.indexOf("### Founder's reference images"));
      expect(text).toContain("### Founder's reference images");
      expect(block).toContain("expire 7 days after upload");
      expect(block).toContain("never hotlink them");
      expect(block).toContain("public/reference/<name>.jpg");
      expect(block).toContain(url);
      expect(text).not.toContain("http://insecure/x.jpg");
    }
    const plain = await prompt("run-refs-none", payload("scaffold"));
    expect(plain).not.toContain("### Founder's reference images");
  }, 180_000);
});

describe("previewServesBuildRepo", () => {
  it("covers scaffold and build of a Zavi-owned first build only when asked, and never a refine or the founder's repo", () => {
    expect(previewServesBuildRepo({ stage: "scaffold" }, false)).toBe(true);
    expect(previewServesBuildRepo({ stage: "build" }, false)).toBe(false);
    expect(previewServesBuildRepo({ stage: "scaffold", repair_mode: true }, false)).toBe(false);
    expect(previewServesBuildRepo({ stage: "build" }, true)).toBe(true);
    expect(previewServesBuildRepo({ stage: "build", repair_mode: true }, true)).toBe(true);
    expect(previewServesBuildRepo({ stage: "scaffold", repair_mode: true }, true)).toBe(true);
    expect(previewServesBuildRepo({ stage: "build", refine_mode: true }, true)).toBe(false);
    expect(previewServesBuildRepo({ stage: "build", target: { github_target_mode: "user_repo" } }, true)).toBe(false);
    expect(previewServesBuildRepo({ stage: "qa" }, true)).toBe(false);
    expect(previewServesBuildRepo(null, true)).toBe(false);
  });
});
