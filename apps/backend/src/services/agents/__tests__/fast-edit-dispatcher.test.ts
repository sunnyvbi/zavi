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

import fs from "node:fs";
import path from "node:path";
import { runGeneric } from "@/services/agents/generic-dispatcher";
import { siteDataContractNote } from "@/services/agents/fast-build-prompt";
import type { AgentContext } from "@/services/agents/types";

function makeCtx(runId: string): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId,
    trigger: "manual",
    draft_mode: true,
    agent: {
      slug: "engineer",
      metadata_praxis: { memory_layer: false, tools: [] as string[] },
    },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    emitProgress: async () => {},
    emitDecision: async () => {},
    scanRecentRuns: async () => [],
  } as unknown as AgentContext;
}

const REQUEST = "change the hero title to Rent e-bikes fast";
const REPO = "praxis-built/alpha-abc123";

async function run(p: Record<string, unknown>): Promise<{ prompt: string; maxTurns?: number }> {
  captured.length = 0;
  await runGeneric(makeCtx(`run-${Math.random()}`), p);
  expect(captured.length).toBeGreaterThan(0);
  const sp = captured[0]!.systemPrompt;
  return { prompt: Array.isArray(sp) ? sp.join("") : (sp ?? ""), maxTurns: captured[0]!.maxTurns };
}

const refine = {
  stage: "build",
  refine_mode: true,
  customer_origin: true,
  small_edit: true,
  site_id: "aaaaaaaa-0000-4000-8000-000000000001",
  site_backend: "dedicated",
  idea: REQUEST,
  company_name: "your product",
  prior_refines: [],
  target: { github_full_name: REPO, repo_url: `https://github.com/${REPO}`, default_branch: "main" },
};

describe("site fast edit prompt", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("a fast_edit site refine gets the short Vite edit prompt under the 15-turn cap, not the Next.js refine prompt", async () => {
    const fast = await run({ ...refine, fast_edit: true });
    expect(fast.prompt).toContain("## FAST SITE EDIT: one small change (Vite + React)");
    expect(fast.prompt).toContain(REQUEST);
    expect(fast.prompt).toContain(`"repo": "${REPO}"`);
    expect(fast.prompt).toContain("Do not run `npm install`, a build, a typecheck or a dev server");
    expect(fast.prompt).toContain("Do not create, delete or rename files. Do not touch `package.json`");
    expect(fast.prompt).toContain("`supabase/migrations`");
    expect(fast.prompt).toContain("<pr_proposal>");
    expect(fast.prompt).not.toContain("## PRODUCT-REFINE MODE");
    expect(fast.prompt).not.toContain("npm run build");
    expect(fast.maxTurns).toBe(15);

    const full = await run(refine);
    expect(full.prompt).toContain("## SITE CHANGE: edit the founder's live site (Vite + React + Supabase)");
    expect(full.prompt).not.toContain("## FAST SITE EDIT");
    expect(full.prompt).not.toContain("## PRODUCT-REFINE MODE");
    expect(full.maxTurns).not.toBe(15);
    expect(fast.prompt.length).toBeLessThan(full.prompt.length);
  }, 180_000);

  it("a change scoped to a picked element carries it after the request, as untrusted data, on both lanes", async () => {
    const selected_element = { selector: "main > section:nth-of-type(1) > h1", tag: "h1", text: "Rent bikes", path: "/" };
    for (const lane of [{ fast_edit: true }, {}]) {
      const r = await run({ ...refine, ...lane, selected_element });
      expect(r.prompt).toContain(REQUEST);
      expect(r.prompt).toContain("<untrusted_selected_element>");
      expect(r.prompt).toContain("CSS selector in the rendered page: main > section:nth-of-type(1) > h1");
      expect(r.prompt.indexOf(REQUEST)).toBeLessThan(r.prompt.indexOf("<untrusted_selected_element>"));
    }
    const plain = await run({ ...refine, fast_edit: true });
    expect(plain.prompt).not.toContain("untrusted_selected_element");
  });

  it("a fix pass after a failed check takes the site change prompt with the failure, even when the node carried fast_edit", async () => {
    const fix = await run({ ...refine, fast_edit: true, repair_mode: true, repair_attempt: 1, failure_signal: "the new text is not in the published page" });
    expect(fix.prompt).toContain("## SITE CHANGE");
    expect(fix.prompt).toContain("### FIX PASS #1");
    expect(fix.prompt).toContain("the new text is not in the published page");
    expect(fix.prompt).not.toContain("## FAST SITE EDIT");
    expect(fix.prompt).not.toContain("## PRODUCT-REFINE MODE");
    expect(fix.maxTurns).not.toBe(15);
  }, 180_000);

  it("a dedicated site refine keeps supabase-js and numbered migrations", async () => {
    const r = await run(refine);
    expect(r.prompt).toContain("supabase-js v2 and its own Supabase project");
    expect(r.prompt).toContain("`supabase/migrations/NNN_name.sql`");
    expect(r.prompt).not.toContain("zavi.data");
  }, 180_000);

  it("a pooled site refine gets the Zavi SDK contract: no SQL, no database client, no Next.js / enable_database", async () => {
    const r = await run({ ...refine, site_backend: "pooled" });
    expect(r.prompt).toContain("## SITE CHANGE: edit the founder's live site (Vite + React + Zavi)");
    expect(r.prompt).toContain("zavi.data");
    expect(r.prompt).toContain("never add `supabase/`, `.sql` files, `@supabase/supabase-js`");
    expect(r.prompt).toContain("never remove or rename an existing one");
    expect(r.prompt).not.toContain("supabase/migrations/NNN");
    expect(r.prompt).not.toContain("supabase-js v2");
    expect(r.prompt).not.toContain("praxis__enable_database");
    expect(r.prompt).not.toContain("## PRODUCT-REFINE MODE");
    const fix = await run({ ...refine, site_backend: "pooled", repair_mode: true, repair_attempt: 2, failure_signal: "collection bookings missing" });
    expect(fix.prompt).toContain("Vite + React + Zavi");
    expect(fix.prompt).toContain("collection bookings missing");
  }, 180_000);

  it("a pooled fast edit never touches zavi-site.json or adds supabase", async () => {
    const fast = await run({ ...refine, site_backend: "pooled", fast_edit: true });
    expect(fast.prompt).toContain("## FAST SITE EDIT");
    expect(fast.prompt).toContain("on the Zavi SDK");
    expect(fast.prompt).toContain("`zavi-site.json`");
    expect(fast.prompt).toContain("Never add `supabase/`");
    expect(fast.prompt).not.toContain("`supabase/migrations`");
  }, 180_000);

  it("any other engineer run on a site's repo (e.g. a chat) carries that site's data contract", () => {
    const pooled = siteDataContractNote("pooled");
    expect(pooled).toContain("## THIS REPO IS A ZAVI SITE");
    expect(pooled).toContain("zavi.data");
    expect(pooled).toContain("never add `supabase/`");
    const dedicated = siteDataContractNote("dedicated");
    expect(dedicated).toContain("`supabase/migrations/NNN_name.sql`");
    expect(dedicated).not.toContain("zavi.data");
    const src = fs.readFileSync(path.join(process.cwd(), "src/services/agents/generic-dispatcher.ts"), "utf8");
    expect(src).toMatch(/\} else if \(siteBackend\) \{[\s\S]{0,400}siteDataContractNote\(siteBackend\)/);
  });

  it("a site payload without a resolved backend is refused, never given the dedicated prompt", async () => {
    const { site_backend: _drop, ...unresolved } = refine;
    captured.length = 0;
    await expect(runGeneric(makeCtx(`run-${Math.random()}`), unresolved)).rejects.toMatchObject({
      code: "site_backend_unresolved",
      retryable: true,
    });
    expect(captured.length).toBe(0);
  }, 180_000);

  it("fast_edit without a site never takes the fast prompt", async () => {
    const { site_id: _drop, ...noSite } = refine;
    const r = await run({ ...noSite, fast_edit: true });
    expect(r.prompt).toContain("## PRODUCT-REFINE MODE");
    expect(r.prompt).not.toContain("## FAST SITE EDIT");
  }, 180_000);
});
