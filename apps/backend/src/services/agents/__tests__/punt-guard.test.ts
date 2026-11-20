import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/mcp/tool-effects", () => ({ internalToolEffects: () => new Map() }));
vi.mock("@/services/tools/operator-db/catalog", () => ({ getDeclaredDialect: vi.fn(async () => null) }));

import {
  applyPuntGuard,
  isPuntGuardEnabled,
  isFounderFacingRun,
  isWriteToolCall,
  capabilityToolNames,
  skippedDataLookup,
  skippedWebSearch,
  RECORD_LOOKUP_RETRY_NOTE,
  WEB_SEARCH_RETRY_NOTE,
  tenantHasBusinessDb,
  mergeAttemptUsage,
  PUNT_RETRY_FLAG,
  type PuntGuardOutcome,
} from "../punt-guard";
import { puntGuardNoteFromPayload } from "../punt-detector";
import type { AgentContext, DispatcherResult } from "../types";

const PUNT = "I can't trigger a live test run from here. Go to zaviagent.com/start yourself.";
const GOOD = "I ran the site check on vercel.com: 82/100. Top fix: add a meta description.";

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: "t1",
    runId: "r1",
    trigger: "slack",
    agent: { slug: "operator" },
    ...over,
  } as unknown as AgentContext;
}

function res(text: string, over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: text,
    parsed: null,
    parse_ok: true,
    raw_response_text: text,
    prompt_snapshot: "",
    usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.05 },
    tool_calls: [],
    resolved_tool_names: ["web_fetch__fetch", "memory__search", "praxis__handoff", "stripe__refund"],
    ...over,
  } as DispatcherResult;
}

function harness(opts: { enabled?: boolean; writes?: string[]; budgetOk?: boolean } = {}) {
  const logs: Array<[PuntGuardOutcome, string]> = [];
  const writes = new Set(opts.writes ?? []);
  return {
    logs,
    deps: {
      isEnabled: async () => opts.enabled ?? true,
      reserveBudget: vi.fn(async () => opts.budgetOk ?? true),
      isWriteTool: (n: string) => writes.has(n),
      log: (o: PuntGuardOutcome, c: string) => logs.push([o, c]),
    },
  };
}

describe("applyPuntGuard", () => {
  it("retries once with a capability note built from the run's own tools, and bills both attempts", async () => {
    const h = harness();
    const rerun = vi.fn(async (p: Record<string, unknown>) => {
      expect(p[PUNT_RETRY_FLAG]).toBe(true);
      const note = puntGuardNoteFromPayload(p)!;
      expect(note).toContain("web_fetch__fetch");
      expect(note).toContain("praxis__handoff");
      expect(note).not.toContain("stripe__refund");
      expect(p.ask).toBe("test vercel.com");
      return res(GOOD, { usage: { input_tokens: 200, output_tokens: 20, cost_usd: 0.07 } });
    });
    const out = await applyPuntGuard({
      ctx: ctx(),
      payload: { ask: "test vercel.com" },
      result: res(PUNT),
      rerun,
      deps: h.deps,
    });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(out.output_text).toBe(GOOD);
    expect(out.usage.input_tokens).toBe(300);
    expect(out.usage.output_tokens).toBe(30);
    expect(out.usage.cost_usd).toBeCloseTo(0.12);
    expect(h.logs).toEqual([["recovered", "cant_from_here"]]);
  });

  it("a second punt is published as-is, with no further retry", async () => {
    const h = harness();
    const rerun = vi.fn(async () => res("You'll need to open the page yourself."));
    const out = await applyPuntGuard({ ctx: ctx(), payload: {}, result: res(PUNT), rerun, deps: h.deps });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(out.output_text).toBe("You'll need to open the page yourself.");
    expect(out.usage.input_tokens).toBe(200);
    expect(h.logs).toEqual([["published_as_is", "do_it_yourself"]]);
  });

  it("never retries a payload that is already the retry", async () => {
    const h = harness();
    const rerun = vi.fn();
    const out = await applyPuntGuard({
      ctx: ctx(),
      payload: { [PUNT_RETRY_FLAG]: true },
      result: res(PUNT),
      rerun,
      deps: h.deps,
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(out.output_text).toBe(PUNT);
  });

  it("does not retry when the first attempt executed a write", async () => {
    const h = harness({ writes: ["memory__write"] });
    const rerun = vi.fn();
    const first = res(PUNT, {
      tool_calls: [{ name: "memory__write", input_preview: "", output_preview: "", ms: 1, status: "ok" }],
    });
    const out = await applyPuntGuard({ ctx: ctx(), payload: {}, result: first, rerun, deps: h.deps });
    expect(rerun).not.toHaveBeenCalled();
    expect(out).toBe(first);
    expect(h.logs).toEqual([["skipped_wrote", "cant_from_here"]]);
  });

  it("does not retry when a side effect shipped", async () => {
    const h = harness();
    const rerun = vi.fn();
    await applyPuntGuard({
      ctx: ctx(),
      payload: {},
      result: res(PUNT, { side_effect: { kind: "shipped" } }),
      rerun,
      deps: h.deps,
    });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("kill switch off: no retry", async () => {
    const h = harness({ enabled: false });
    const rerun = vi.fn();
    const out = await applyPuntGuard({ ctx: ctx(), payload: {}, result: res(PUNT), rerun, deps: h.deps });
    expect(rerun).not.toHaveBeenCalled();
    expect(out.output_text).toBe(PUNT);
    expect(h.logs).toEqual([["skipped_disabled", "cant_from_here"]]);
  });

  it("non-founder-facing runs (cron, internal a2a, batch child) are never retried", async () => {
    for (const c of [
      ctx({ trigger: "cron" }),
      ctx({ trigger: "a2a" }),
      ctx({ trigger: "chat", batch_id: "b1" }),
      ctx({ trigger: "slack", draft_mode: true } as Partial<AgentContext>),
    ]) {
      const h = harness();
      const rerun = vi.fn();
      await applyPuntGuard({ ctx: c, payload: {}, result: res(PUNT), rerun, deps: h.deps });
      expect(rerun).not.toHaveBeenCalled();
      expect(h.logs).toEqual([]);
    }
  });

  it("an honest reply is left alone and the kill switch is not even read", async () => {
    const isEnabled = vi.fn(async () => true);
    const rerun = vi.fn();
    const out = await applyPuntGuard({
      ctx: ctx(),
      payload: {},
      result: res("You'll need to approve the card before it goes live."),
      rerun,
      deps: { isEnabled },
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(out.output_text).toContain("approve");
  });

  it("bespoke dispatchers are logged, never re-run", async () => {
    const h = harness();
    const out = await applyPuntGuard({ ctx: ctx(), payload: {}, result: res(PUNT), rerun: null, deps: h.deps });
    expect(out.output_text).toBe(PUNT);
    expect(h.logs).toEqual([["skipped_bespoke", "cant_from_here"]]);
  });

  it("a retry that throws keeps the first reply", async () => {
    const h = harness();
    const out = await applyPuntGuard({
      ctx: ctx(),
      payload: {},
      result: res(PUNT),
      rerun: async () => {
        throw new Error("boom");
      },
      deps: h.deps,
    });
    expect(out.output_text).toBe(PUNT);
    expect(h.logs).toEqual([["retry_threw_usage_unknown", "cant_from_here"]]);
  });

  it("budget reservation rejected: no rerun, first result returned", async () => {
    const h = harness({ budgetOk: false });
    const rerun = vi.fn();
    const out = await applyPuntGuard({ ctx: ctx(), payload: {}, result: res(PUNT), rerun, deps: h.deps });
    expect(h.deps.reserveBudget).toHaveBeenCalledTimes(1);
    expect(rerun).not.toHaveBeenCalled();
    expect(out.output_text).toBe(PUNT);
    expect(h.logs).toEqual([["budget_blocked", "cant_from_here"]]);
  });

  it("budget reservation accepted: rerun called once", async () => {
    const h = harness({ budgetOk: true });
    const rerun = vi.fn(async () => res(GOOD));
    await applyPuntGuard({ ctx: ctx(), payload: {}, result: res(PUNT), rerun, deps: h.deps });
    expect(h.deps.reserveBudget).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it("keeps the first attempt's tool receipts and publishes them to provenance", async () => {
    const h = harness();
    const t1 = { name: "web_fetch__fetch" } as never;
    const t2 = { name: "web_search__search" } as never;
    const prov = { current: [] as readonly unknown[] };
    const c = ctx({ provenanceToolCalls: prov } as Partial<AgentContext>);
    const out = await applyPuntGuard({
      ctx: c,
      payload: {},
      result: res(PUNT, { tool_calls: [t1] }),
      rerun: async () => res(GOOD, { tool_calls: [t2] }),
      deps: h.deps,
    });
    expect(out.tool_calls).toEqual([t1, t2]);
    expect(prov.current).toEqual([t1, t2]);

    const empty = await applyPuntGuard({
      ctx: ctx(),
      payload: {},
      result: res(PUNT, { tool_calls: [t1] }),
      rerun: async () => res("", { tool_calls: [] }),
      deps: h.deps,
    });
    expect(empty.output_text).toBe(PUNT);
    expect(empty.tool_calls).toEqual([t1]);
  });
});

describe("helpers", () => {
  it("founder-facing surfaces", () => {
    expect(isFounderFacingRun(ctx({ trigger: "chat" }))).toBe(true);
    expect(isFounderFacingRun(ctx({ trigger: "email" }))).toBe(true);
    expect(
      isFounderFacingRun(
        ctx({ trigger: "a2a", slackRouting: { channel_id: "C", thread_ts: "1", original_ts: "1", event_id: "e" } }),
      ),
    ).toBe(true);
    expect(isFounderFacingRun(ctx({ trigger: "manual" }))).toBe(false);
  });

  it("usage: cost_usd is dropped (re-derived from summed tokens) unless both attempts reported it", () => {
    const m = mergeAttemptUsage(
      { input_tokens: 1, output_tokens: 2, cost_usd: 0.1 },
      { input_tokens: 3, output_tokens: 4 },
    );
    expect(m).toMatchObject({ input_tokens: 4, output_tokens: 6 });
    expect(m.cost_usd).toBeUndefined();
  });

  it("write detection: declared effects win; undeclared names use read verbs; unknown built-ins count as writes", () => {
    const effects = new Map([
      ["memory__search", "read" as const],
      ["praxis__handoff", "write" as const],
    ]);
    expect(isWriteToolCall("mcp__server__memory__search", effects)).toBe(false);
    expect(isWriteToolCall("praxis__handoff", effects)).toBe(true);
    expect(isWriteToolCall("composio__gmail__send_email", effects)).toBe(true);
    expect(isWriteToolCall("composio__gmail__list_threads", effects)).toBe(false);
    expect(isWriteToolCall("WebFetch", effects)).toBe(false);
    expect(isWriteToolCall("Bash", effects)).toBe(true);
  });

  it("capability tools come only from the run's resolved list", () => {
    expect(capabilityToolNames(["mcp__server__web_search__search", "github__read_file", "apify__rag_web_browser"])).toEqual([
      "web_search__search",
      "apify__rag_web_browser",
    ]);
    expect(capabilityToolNames(undefined)).toEqual([]);
  });

  it("kill switch reads system_config: default ON, off only on explicit false, ON on error", async () => {
    const sb = (blob: unknown, error: unknown = null) =>
      ({
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: blob === undefined ? null : { blob }, error }) }) }),
        }),
      }) as never;
    expect(await isPuntGuardEnabled(sb({}))).toBe(true);
    expect(await isPuntGuardEnabled(sb(undefined))).toBe(true);
    expect(await isPuntGuardEnabled(sb({ punt_guard_enabled: false }))).toBe(false);
    expect(await isPuntGuardEnabled(sb({ punt_guard_enabled: "false" }))).toBe(true);
    expect(await isPuntGuardEnabled(sb({}, { message: "down" }))).toBe(true);
  });
});

describe("punt guard wiring", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const runner = readFileSync(join(__dirname, "../runner.ts"), "utf-8");
  const chat = readFileSync(join(__dirname, "../chat-dispatcher.ts"), "utf-8");

  it("runner: non-chat generic path retries before the post-processor; bespoke path never re-runs", () => {
    const fn = runner.slice(runner.indexOf("export async function runDispatch"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const guardIdx = body.indexOf("rerun: (p) => runGeneric(ctx, p)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(body.indexOf("await postProcess(")).toBeGreaterThan(guardIdx);
    expect(body).toMatch(/applyPuntGuard\(\{ ctx, payload, result: await bespoke\(ctx, payload\), rerun: null \}\)/);
  });

  it("chat: retry decision sits before the reply bubble is recorded", () => {
    const guardIdx = chat.indexOf("result = await applyPuntGuard(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(chat.indexOf('rpc("record_agent_chat_reply"')).toBeGreaterThan(guardIdx);
  });
});

describe("the retry is one run, never a best-of-N fan-out (review F2)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "generic-dispatcher.ts"),
    "utf8",
  ) as string;
  it("runGeneric routes a punt retry straight to runGenericOnce before any best-of-N read", () => {
    const fn = src.slice(src.indexOf("export async function runGeneric("));
    const guard = fn.indexOf("isPuntRetry(payload)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf("resolveBestOfNPolicy()"));
  });
});

describe("asked_for_record: the run had the database and never queried it", () => {
  const ASK =
    "I can't give you the exact cause yet. **Recommended next action:** send the Jeep's listing ID so I can check its location and area tag.";
  const CODE_ONLY = [
    { name: "ToolSearch", status: "ok" },
    { name: "mcp__server__github__grep", status: "ok" },
    { name: "mcp__server__github__read_file", status: "ok" },
  ];
  const WITH_DB = ["github__grep", "github__read_file", "operator_db__catalog", "operator_db__query"];

  it("retries once with the database lookup note", async () => {
    const h = harness();
    const rerun = vi.fn(async (p: Record<string, unknown>) => {
      expect(puntGuardNoteFromPayload(p)).toBe(RECORD_LOOKUP_RETRY_NOTE);
      return res("Listing 104401's map pin is in Fremont while its address says Miami.");
    });
    const out = await applyPuntGuard({
      ctx: ctx(),
      payload: { ask: "why is this car here" },
      result: res(ASK, { tool_calls: CODE_ONLY, resolved_tool_names: WITH_DB } as Partial<DispatcherResult>),
      rerun,
      deps: { ...h.deps, hasBusinessDb: async () => true },
    });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(out.output_text).toContain("Fremont");
    expect(h.logs).toEqual([["recovered", "asked_for_record"]]);
  });

  it("leaves an honest ask alone when the tenant has no business database connected", async () => {
    const h = harness();
    const rerun = vi.fn();
    const out = await applyPuntGuard({
      ctx: ctx(),
      payload: {},
      result: res(ASK, { tool_calls: CODE_ONLY, resolved_tool_names: WITH_DB } as Partial<DispatcherResult>),
      rerun,
      deps: { ...h.deps, hasBusinessDb: async () => false },
    });
    expect(rerun).not.toHaveBeenCalled();
    expect(out.output_text).toBe(ASK);
  });

  it("fails closed: the default connection check returns false when none is declared", async () => {
    expect(await tenantHasBusinessDb("t1")).toBe(false);
  });

  it("leaves it alone when the run already queried the database", () => {
    const calls = [...CODE_ONLY, { name: "mcp__server__operator_db__query", status: "ok" }];
    expect(skippedDataLookup(res(ASK, { tool_calls: calls, resolved_tool_names: WITH_DB } as Partial<DispatcherResult>))).toBe(false);
  });

  it("leaves it alone when no database is connected to the run", () => {
    expect(
      skippedDataLookup(res(ASK, { tool_calls: CODE_ONLY, resolved_tool_names: ["github__grep"] } as Partial<DispatcherResult>)),
    ).toBe(false);
  });

  it("leaves a plain clarifying question alone (nothing was investigated)", () => {
    expect(
      skippedDataLookup(res(ASK, { tool_calls: [{ name: "ToolSearch", status: "ok" }], resolved_tool_names: WITH_DB } as Partial<DispatcherResult>)),
    ).toBe(false);
  });

  it("leaves an answer that names the record alone", () => {
    const answer = "Listing ID 104401 has a Fremont map pin with a Miami address.";
    expect(
      skippedDataLookup(res(answer, { tool_calls: CODE_ONLY, resolved_tool_names: WITH_DB } as Partial<DispatcherResult>)),
    ).toBe(false);
  });
});

describe("skipped_web_search: a chat research question answered from memory", () => {
  const ASK = "what are the top creator platforms for my product?";
  const MEMORY = "1. Zavi creators 2. Billo 3. Insense. Billo is cheapest.";
  const WEB = ["web_search__search", "web_fetch__fetch", "growth__search_human_members"];
  const chat = () => ctx({ trigger: "chat", agent: { slug: "ugc" } } as Partial<AgentContext>);
  const first = (over: Partial<DispatcherResult> = {}) =>
    res(MEMORY, { tool_calls: [], resolved_tool_names: WEB, ...over } as Partial<DispatcherResult>);
  const searched = (text: string) =>
    res(text, {
      tool_calls: [{ name: "mcp__server__web_search__search", status: "ok" }],
      resolved_tool_names: WEB,
    } as Partial<DispatcherResult>);

  it("nudges once with the search note when a chat research ask made zero searches", async () => {
    const h = harness();
    const rerun = vi.fn(async (p: Record<string, unknown>) => {
      expect(puntGuardNoteFromPayload(p)).toBe(WEB_SEARCH_RETRY_NOTE);
      expect(p.current_message).toBe(ASK);
      return searched("Per G2 and each vendor's pricing page: Billo, Insense, Trend. Zavi creators is built in.");
    });
    const out = await applyPuntGuard({ ctx: chat(), payload: { current_message: ASK }, result: first(), rerun, deps: h.deps });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(out.output_text).toContain("Billo");
    expect(out.tool_calls?.map((t) => t.name)).toEqual(["mcp__server__web_search__search"]);
    expect(h.logs).toEqual([["recovered", "skipped_web_search"]]);
  });

  it("only once: a retry that still did not search is published as-is", async () => {
    const h = harness();
    const rerun = vi.fn(async () => res("Still from memory.", { tool_calls: [], resolved_tool_names: WEB } as Partial<DispatcherResult>));
    const out = await applyPuntGuard({ ctx: chat(), payload: { current_message: ASK }, result: first(), rerun, deps: h.deps });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(out.output_text).toBe("Still from memory.");
    expect(h.logs).toEqual([["published_as_is", "skipped_web_search"]]);
  });

  it("does not fire when the run already searched (built-in or apify count too)", async () => {
    for (const name of [
      "mcp__server__web_search__search",
      "mcp__praxis-server__web_search__search",
      "WebSearch",
      "mcp__server__apify__rag_web_browser",
      "mcp__praxis-server__apify__rag_web_browser",
    ]) {
      const rerun = vi.fn();
      await applyPuntGuard({
        ctx: chat(),
        payload: { current_message: ASK },
        result: first({ tool_calls: [{ name, status: "ok" }] } as Partial<DispatcherResult>),
        rerun,
        deps: harness().deps,
      });
      expect(rerun).not.toHaveBeenCalled();
    }
  });

  it("SDK-path tool names unwrap to server__tool; a bare mcp__server__tool keeps its server", () => {
    expect(isWriteToolCall("mcp__praxis-server__web_search__search", new Map())).toBe(false);
    expect(isWriteToolCall("mcp__stripe__refund", new Map())).toBe(true);
  });

  it("a blocked web_fetch is not a search: still nudges", async () => {
    const rerun = vi.fn(async () => searched("Answer from search."));
    await applyPuntGuard({
      ctx: chat(),
      payload: { current_message: "is ChatGPT ads a fit for us?" },
      result: first({ tool_calls: [{ name: "mcp__server__web_fetch__fetch", status: "tool_error" }] } as Partial<DispatcherResult>),
      rerun,
      deps: harness().deps,
    });
    expect(rerun).toHaveBeenCalledTimes(1);
  });

  it("does not fire on non-chat triggers (slack, cron, channel runs)", async () => {
    for (const trigger of ["slack", "cron", "channel_recipe"]) {
      const rerun = vi.fn();
      await applyPuntGuard({
        ctx: ctx({ trigger, agent: { slug: "ugc" } } as Partial<AgentContext>),
        payload: { current_message: ASK },
        result: first(),
        rerun,
        deps: harness().deps,
      });
      expect(rerun).not.toHaveBeenCalled();
    }
  });

  it("does not fire on a non-research ask", async () => {
    const rerun = vi.fn();
    await applyPuntGuard({
      ctx: chat(),
      payload: { current_message: "how many signups did we get this week vs last week?" },
      result: first(),
      rerun,
      deps: harness().deps,
    });
    expect(rerun).not.toHaveBeenCalled();
  });

  it("reads the founder's raw words, not the context-wrapped message", () => {
    const wrapped = { current_message: "RECENT ACTIONS: compared the best tools for X\n\npost it", current_user_text_raw: "post it" };
    expect(skippedWebSearch(chat(), wrapped, first())).toBe(false);
    expect(skippedWebSearch(chat(), { current_message: "post it", current_user_text_raw: ASK }, first())).toBe(true);
  });

  it("does not fire when web_search was not granted, or on a clarifying card", () => {
    expect(skippedWebSearch(chat(), { current_message: ASK }, first({ resolved_tool_names: ["web_fetch__fetch"] }))).toBe(false);
    expect(
      skippedWebSearch(chat(), { current_message: ASK }, first({ clarify_envelope: {} } as unknown as Partial<DispatcherResult>)),
    ).toBe(false);
    expect(skippedWebSearch(chat(), { current_message: ASK }, first())).toBe(true);
  });
});
