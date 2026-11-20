
import { describe, expect, it, vi } from "vitest";
import {
  buildLangChainTools,
  isReadOnlyToolName,
  readOnlyToolSpecs,
  splitToolName,
  wrapAsLangChainTool,
} from "../tool-bridge";
import { ZAVI_FS_PERMISSIONS } from "../backends/mount";
import { buildSubagents } from "../subagents";
import { groundingMiddleware, MAX_NUDGES } from "../middleware/stack";
import { accumulateUsage, readChunk } from "../engine";
import type { AgentEngineRunSpec, EngineToolSpec } from "../../engine/types";

const TOOLS: EngineToolSpec[] = [
  { name: "memory__search", description: "search memory", jsonSchema: { type: "object" } },
  { name: "meta_ads__list_campaigns", description: "list campaigns", jsonSchema: { type: "object" } },
  { name: "meta_ads__update_ad_set", description: "update an ad set", jsonSchema: { type: "object" } },
  { name: "slack__post_message", description: "post to slack", jsonSchema: { type: "object" } },
];

function makeSpec(dispatchTool: AgentEngineRunSpec["dispatchTool"]): AgentEngineRunSpec {
  return {
    systemPrompt: "sys",
    userPrompt: "hi",
    model: "claude-sonnet-4-6",
    maxTurns: 20,
    tools: TOOLS,
    resume: null,
    abort: new AbortController(),
    dispatchTool,
    onEvent: () => {},
    tenantId: "t-1",
    runId: "r-1",
  } as AgentEngineRunSpec;
}

describe("tool bridge — the funnel is the only executor", () => {
  it("routes EVERY tool call through dispatchTool", async () => {
    const seen: string[] = [];
    const dispatch = vi.fn(async (call: { tool_name: string }) => {
      seen.push(call.tool_name);
      return { is_error: false, content: '{"ok":true}', ms: 1 };
    });
    const tools = buildLangChainTools(makeSpec(dispatch as never));
    expect(tools).toHaveLength(TOOLS.length);

    for (const t of tools) {
      await (t as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({});
    }
    expect(seen.sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(dispatch).toHaveBeenCalledTimes(TOOLS.length);
  });

  it("returns a DENIAL as an ordinary tool result and never throws", async () => {
    const dispatch = vi.fn(async () => ({
      is_error: true,
      content: "DENIED by tenant tool policy.",
      ms: 0,
      denied: true,
    }));
    const t = wrapAsLangChainTool(TOOLS[3], makeSpec(dispatch as never));
    const out = await (t as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({});
    expect(String(out)).toContain("DENIED");
  });

  it("passes the model's ARGUMENTS through to the funnel unchanged", async () => {
    let received: unknown = "NEVER CALLED";
    const dispatch = vi.fn(async (call: { input: unknown }) => {
      received = call.input;
      return { is_error: false, content: "{}", ms: 1 };
    });
    const t = wrapAsLangChainTool(TOOLS[1], makeSpec(dispatch as never));
    await (t as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({
      campaign_id: "23852",
      days: 7,
    });
    expect(received).toEqual({ campaign_id: "23852", days: 7 });
  });

  it("passes the model's own tool_call id through as tool_use_id (ledger key)", async () => {
    let captured: string | undefined;
    const dispatch = vi.fn(async (call: { tool_use_id: string }) => {
      captured = call.tool_use_id;
      return { is_error: false, content: "{}", ms: 1 };
    });
    const t = wrapAsLangChainTool(TOOLS[0], makeSpec(dispatch as never));
    await (t as unknown as { invoke: (i: unknown, c?: unknown) => Promise<unknown> }).invoke(
      {},
      { toolCall: { id: "call_abc123", name: TOOLS[0].name, args: {} } },
    );
    expect(captured).toBe("call_abc123");
  });

  it("splits server__tool names correctly", () => {
    expect(splitToolName("meta_ads__list_campaigns")).toEqual({
      serverId: "meta_ads",
      bare: "list_campaigns",
    });
    expect(splitToolName("bare")).toEqual({ serverId: "", bare: "bare" });
  });
});

describe("read-only classification is deny-by-default", () => {
  it("recognises known read verbs", () => {
    expect(isReadOnlyToolName("meta_ads__list_campaigns")).toBe(true);
    expect(isReadOnlyToolName("memory__search")).toBe(true);
    expect(isReadOnlyToolName("meta_ads__daily_series")).toBe(true);
  });

  it("allows the read tools a LangSmith trace showed being wrongly denied", () => {
    for (const t of [
      "growth__diagnose_funnel",
      "growth__marketplace_intelligence",
      "growth__liquidity_gap",
      "operator_db__catalog",
      "meta_ads__pixel_health",
    ]) {
      expect(isReadOnlyToolName(t), `${t} must be read-only`).toBe(true);
    }
  });

  it("still denies writes on remote servers, which the shared classifier ignores", () => {
    expect(isReadOnlyToolName("composio__HUBSPOT_CREATE_DEAL")).toBe(false);
    expect(isReadOnlyToolName("pipedream__send_email")).toBe(false);
  });

  it("treats an UNRECOGNISED verb as a write", () => {
    expect(isReadOnlyToolName("slack__post_message")).toBe(false);
    expect(isReadOnlyToolName("meta_ads__update_ad_set")).toBe(false);
    expect(isReadOnlyToolName("meta_ads__nuke_everything")).toBe(false);
  });

  it("internal tools follow their declared effect, not their server or name", () => {
    expect(isReadOnlyToolName("growth__propose_creative_brief")).toBe(false);
    expect(isReadOnlyToolName("connectors__request")).toBe(false);
    expect(isReadOnlyToolName("jira__count")).toBe(true);
    expect(isReadOnlyToolName("reddit__thread_read")).toBe(true);
    expect(isReadOnlyToolName("growth__list_everything_new")).toBe(false);
    expect(isReadOnlyToolName("meta_ads__get_new_thing")).toBe(false);
  });

  it("filters spec lists to read-only", () => {
    expect(readOnlyToolSpecs(TOOLS).map((t) => t.name)).toEqual([
      "memory__search",
      "meta_ads__list_campaigns",
    ]);
  });
});

describe("subagents cannot reach a write tool", () => {
  const spec = makeSpec(async () => ({ is_error: false, content: "{}", ms: 1 }));
  const subs = buildSubagents(spec);

  it("defines exactly the four designed subagents", () => {
    expect(subs.map((s) => s.name).sort()).toEqual([
      "campaign-drafter",
      "creative-analyst",
      "data-reconciler",
      "researcher",
    ]);
  });

  it("gives NO subagent a write tool", () => {
    for (const s of subs) {
      const names = ((s.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
      for (const n of names) {
        expect(isReadOnlyToolName(n), `${s.name} holds write tool ${n}`).toBe(true);
      }
    }
  });

  it("gives campaign-drafter NO tools at all — it must not be able to reach Meta", () => {
    const drafter = subs.find((s) => s.name === "campaign-drafter")!;
    expect(drafter.tools ?? []).toHaveLength(0);
  });
});

describe("filesystem permissions", () => {
  it("denies writes to /memory/ and /skills/ BEFORE the catch-all allow", () => {
    const rules = ZAVI_FS_PERMISSIONS;
    const catchAll = rules.findIndex((r) => r.paths.includes("/**") && r.mode === "allow");
    const memDeny = rules.findIndex(
      (r) => r.mode === "deny" && r.paths.some((p) => p.startsWith("/memory/")),
    );
    const skillDeny = rules.findIndex(
      (r) => r.mode === "deny" && r.paths.some((p) => p.startsWith("/skills/")),
    );
    expect(memDeny).toBeGreaterThanOrEqual(0);
    expect(skillDeny).toBeGreaterThanOrEqual(0);
    expect(memDeny).toBeLessThan(catchAll);
    expect(skillDeny).toBeLessThan(catchAll);
  });

  it("keeps the catch-all LAST", () => {
    const last = ZAVI_FS_PERMISSIONS[ZAVI_FS_PERMISSIONS.length - 1];
    expect(last.paths).toContain("/**");
  });
});

describe("grounding middleware", () => {
  type Hooked = {
    afterModel: {
      canJumpTo: string[];
      hook: (s: unknown) => Promise<
        { messages?: Array<{ content: string }>; jumpTo?: string } | undefined
      >;
    };
  };
  const hookOf = (mw: unknown) => (mw as unknown as Hooked).afterModel.hook;

  it("declares canJumpTo model — without it the graph has no edge to route along", () => {
    const mw = groundingMiddleware([{ id: "x", check: () => null }]);
    expect((mw as unknown as Hooked).afterModel.canJumpTo).toContain("model");
  });

  it("nudges AND jumps back to the model instead of failing or silently ending", async () => {
    const mw = groundingMiddleware([
      { id: "evidence", check: (t) => (t.includes("obviously") ? "Cite a source." : null) },
    ]);
    const out = await hookOf(mw)({ messages: [{ content: "ROAS is obviously up" }] });
    expect(out?.messages?.[0].content).toContain("Cite a source.");
    expect(out?.jumpTo).toBe("model");
  });

  it("passes clean text through untouched", async () => {
    const mw = groundingMiddleware([{ id: "evidence", check: () => null }]);
    const out = await hookOf(mw)({
      messages: [{ content: "ROAS is 2.1 per meta_ads__daily_series" }],
    });
    expect(out).toBeUndefined();
  });

  it("stops nudging after the budget — with jumpTo this is what prevents an infinite loop", async () => {
    const mw = groundingMiddleware([{ id: "always", check: () => "fix it" }]);
    const call = () => hookOf(mw)({ messages: [{ content: "bad" }] });
    for (let i = 0; i < MAX_NUDGES; i++) expect(await call()).toBeDefined();
    expect(await call()).toBeUndefined();
  });

  it("survives a verifier that throws", async () => {
    const mw = groundingMiddleware([
      { id: "boom", check: () => { throw new Error("verifier exploded"); } },
    ]);
    await expect(hookOf(mw)({ messages: [{ content: "x" }] })).resolves.toBeUndefined();
  });
});

describe("usage accumulation — the 15x cost-bleed guard", () => {
  const ZERO = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  it("sums across turns, including cache fields", () => {
    let u = ZERO;
    u = accumulateUsage(u, {
      input_tokens: 100,
      output_tokens: 20,
      input_token_details: { cache_read: 50, cache_creation: 10 },
    });
    u = accumulateUsage(u, { input_tokens: 5, output_tokens: 3 });
    expect(u).toEqual({
      input_tokens: 105,
      output_tokens: 23,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    });
  });

  it("contributes zero for a malformed blob rather than throwing", () => {
    expect(accumulateUsage(ZERO, null)).toEqual(ZERO);
    expect(accumulateUsage(ZERO, "nonsense")).toEqual(ZERO);
    expect(accumulateUsage(ZERO, { input_tokens: NaN, output_tokens: -5 })).toEqual(ZERO);
  });
});

describe("stream chunk normalization", () => {
  it("handles the 3-tuple emitted when subgraphs are on", () => {
    expect(readChunk([["sub", "x"], "messages", { a: 1 }])).toEqual({
      mode: "messages",
      payload: { a: 1 },
    });
  });

  it("handles the 2-tuple emitted with multiple stream modes", () => {
    expect(readChunk(["messages", { a: 1 }])).toEqual({ mode: "messages", payload: { a: 1 } });
  });

  it("handles a bare payload", () => {
    expect(readChunk({ a: 1 })).toEqual({ mode: "values", payload: { a: 1 } });
  });
});
