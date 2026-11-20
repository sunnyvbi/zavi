import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";
import { callExtensionBrowserTaskTool } from "../internal/extension-browser-task";
import { isSideEffectingTool } from "../tool-effect-classifier";
import { effectOf } from "../tool-effects";
import { classifyToolRisk } from "../tool-risk-registry";
import { DEFAULT_TIER_AGENT_MIN, isToolServerBlockedForAgent } from "@/services/billing/tiers";
import type { ToolEffectDeps } from "../tool-effect-ledger";
import { ALL_BROWSER_TOOL_NAMES } from "@/services/sandbox/browser-mcp/types";
import type { McpCallResult } from "../types";

function mockServers(rows: unknown[]) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }),
      }),
    }),
  });
}

let prev: string | undefined;
beforeEach(() => {
  _clearToolCacheForTests();
  prev = process.env.ALL_AGENTS_ALL_TOOLS;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ALL_AGENTS_ALL_TOOLS;
  else process.env.ALL_AGENTS_ALL_TOOLS = prev;
});

const NAME = "extension__browser_task";

describe("extension__browser_task discovery", () => {
  it.each(["1", "0"])("operator resolves it without declaring it (ALL_AGENTS_ALL_TOOLS=%s)", async (flag) => {
    process.env.ALL_AGENTS_ALL_TOOLS = flag;
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"], "operator");
    const t = res.tools.find((x) => x.name === NAME);
    expect(t).toBeDefined();
    expect(t!.input_schema.required).toEqual(["goal"]);
    expect(res.disconnected_connectors).not.toContain("extension");
  });

  it.each(["1", "0"])("no other agent resolves it, even declaring it (ALL_AGENTS_ALL_TOOLS=%s)", async (flag) => {
    process.env.ALL_AGENTS_ALL_TOOLS = flag;
    mockServers([]);
    for (const slug of ["research", "cgo", "meta_ads", "engineer", "c-abcdefgh12", undefined]) {
      const res = await discoverToolsForTenant("t-1", ["memory__search", NAME], slug);
      expect(res.tools.map((x) => x.name)).not.toContain(NAME);
      expect(res.disconnected_connectors).not.toContain("extension");
    }
  });

  it("operator still gets no raw browser_* tool (least-privilege guard untouched)", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "1";
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", [], "operator");
    const raw = new Set<string>(ALL_BROWSER_TOOL_NAMES as readonly string[]);
    expect(res.tools.map((t) => t.name).filter((n) => raw.has(n))).toEqual([]);
  });

  it("is a declared write on an internal server: ledgered, risk class external", () => {
    expect(effectOf("extension", "browser_task")).toBe("write");
    expect(isSideEffectingTool("extension", "browser_task")).toBe(true);
    expect(classifyToolRisk("extension", "browser_task")).toBe("write_external");
  });

  it("inherits operator's tier: operator is free, the tool is not a gated agent slug, no custom-agent block", () => {
    expect(DEFAULT_TIER_AGENT_MIN.operator).toBe("free");
    expect(Object.keys(DEFAULT_TIER_AGENT_MIN)).not.toContain("extension");
    expect(isToolServerBlockedForAgent("operator", "extension")).toBe(false);
  });
});

describe("extension__browser_task handler", () => {
  const RESULT = {
    status: "done" as const,
    answer: "Budget set.",
    actions_taken: ["Clicked Budget"],
    final_url: "https://x.example/a",
    screenshots: [],
  };

  it.each(["research", "cgo", "meta_ads", undefined])("refuses agent %s before anything runs", async (slug) => {
    const run = vi.fn(async () => RESULT);
    const r = await callExtensionBrowserTaskTool({ tenant_id: "t1", run_id: "run-1", agent_slug: slug, tool_use_id: "toolu_1" }, "browser_task", { goal: "do it" }, { run, ledgerOn: true });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("tool_not_available");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs for operator and renders page words inside the untrusted block", async () => {
    const run = vi.fn(async () => RESULT);
    const r = await callExtensionBrowserTaskTool({ tenant_id: "t1", run_id: "run-1", agent_slug: "operator", tool_use_id: "toolu_1" }, "browser_task", { goal: "do it" }, { run, ledgerOn: true });
    expect(r.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "t1", run_id: "run-1", tool_use_id: "toolu_1", goal: "do it" }));
    expect(JSON.parse(r.content).page_content).toContain("Clicked Budget");
  });

  function ledger() {
    const store = new Map<string, { input_hash: string; result?: McpCallResult }>();
    const deps: ToolEffectDeps = {
      lookupCommitted: vi.fn(async (r, t) => {
        const row = store.get(`${r}:${t}`);
        return row?.result ? { result: row.result, input_hash: row.input_hash } : null;
      }),
      claimPending: vi.fn(async (i) => {
        const k = `${i.run_id}:${i.tool_use_id}`;
        if (store.has(k)) return false;
        store.set(k, { input_hash: i.input_hash });
        return true;
      }),
      commit: vi.fn(async (r, t, res) => {
        const row = store.get(`${r}:${t}`);
        if (row) row.result = res;
      }),
    };
    return deps;
  }

  it("with the global ledger off, a replay of the same tool_use_id never works the tab twice", async () => {
    const l = ledger();
    const run = vi.fn(async () => RESULT);
    const ctx = { tenant_id: "t1", run_id: "run-1", agent_slug: "operator", tool_use_id: "toolu_1" };
    const a = await callExtensionBrowserTaskTool(ctx, "browser_task", { goal: "do it" }, { run, ledger: l, ledgerOn: false });
    const b = await callExtensionBrowserTaskTool(ctx, "browser_task", { goal: "do it" }, { run, ledger: l, ledgerOn: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(b.content).toBe(a.content);
  });

  it("with the global ledger on, it does not claim the key a second time (callMcpTool already did)", async () => {
    const l = ledger();
    const run = vi.fn(async () => RESULT);
    await callExtensionBrowserTaskTool({ tenant_id: "t1", run_id: "run-1", agent_slug: "operator", tool_use_id: "toolu_1" }, "browser_task", { goal: "do it" }, { run, ledger: l, ledgerOn: true });
    expect(l.claimPending).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("F3: a live tab task keeps its ledger claim (heartbeat)", () => {
  const RESULT = { status: "done" as const, answer: "ok", actions_taken: [], final_url: null, screenshots: [] };
  const LEASE = 15 * 60_000;

  function leasedLedger() {
    const rows = new Map<string, { input_hash: string; created_at: number; result?: McpCallResult }>();
    const deps: ToolEffectDeps = {
      lookupCommitted: vi.fn(async (r, t) => {
        const row = rows.get(`${r}:${t}`);
        return row?.result ? { result: row.result, input_hash: row.input_hash } : null;
      }),
      claimPending: vi.fn(async (i) => {
        const k = `${i.run_id}:${i.tool_use_id}`;
        const row = rows.get(k);
        if (!row) return rows.set(k, { input_hash: i.input_hash, created_at: Date.now() }), true;
        if (!row.result && row.created_at < Date.now() - LEASE) {
          if (i.takeover === false) return "stale";
          return (row.created_at = Date.now()), true;
        }
        return false;
      }),
      commit: vi.fn(async (r, t, res) => {
        const row = rows.get(`${r}:${t}`);
        if (row) row.result = res;
      }),
    };
    const renew = vi.fn(async (r: string, t: string) => {
      const row = rows.get(`${r}:${t}`);
      if (row && !row.result) row.created_at = Date.now();
    });
    return { deps, renew };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  async function scenario(heartbeatsWork: boolean) {
    vi.useFakeTimers({ now: 0 });
    const l = leasedLedger();
    let finish!: () => void;
    const run = vi
      .fn(async () => RESULT)
      .mockImplementationOnce(() => new Promise<typeof RESULT>((r) => (finish = () => r(RESULT))));
    const ctx = { tenant_id: "t1", run_id: "run-1", agent_slug: "operator", tool_use_id: "toolu_1" };
    const renew = heartbeatsWork ? l.renew : vi.fn(async () => {});
    const first = callExtensionBrowserTaskTool(ctx, "browser_task", { goal: "do it" }, { run, ledger: l.deps, ledgerOn: false, renew });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const replay = await callExtensionBrowserTaskTool(ctx, "browser_task", { goal: "do it" }, { run, ledger: l.deps, ledgerOn: false, renew });
    finish();
    await first;
    return { run, replay, renew };
  }

  it("renewed claim: a replay 20 minutes in is answered busy, no second controller", async () => {
    const { run, replay, renew } = await scenario(true);
    expect(renew).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(replay.content)).toMatchObject({ blocked_reason: "busy" });
  });

  it("claim whose heartbeats stopped: past the lease it is NOT taken over; outcome_unknown with the approved line", async () => {
    const { run, replay } = await scenario(false);
    expect(run).toHaveBeenCalledTimes(1);
    const body = JSON.parse(replay.content);
    expect(body).toMatchObject({ status: "blocked", blocked_reason: "outcome_unknown" });
    expect(body.founder_message).toBe(
      "I'm not sure my last step went through, so I stopped. Please check the page before asking me to continue.",
    );
  });

  it("renewPendingClaim touches only that call's PENDING row", async () => {
    const calls: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["update", "eq"]) chain[m] = (...a: unknown[]) => (calls.push([m, a]), chain);
    chain.select = async () => ({ data: [{ id: "x" }], error: null });
    mocks.serviceClientMock.mockReturnValue({ from: (t: string) => (calls.push(["from", t]), chain) });
    const { renewPendingClaim } = await import("../tool-effect-ledger");
    expect(await renewPendingClaim("run-1", "toolu_1")).toBe(true);
    expect(calls.filter(([m]) => m === "eq").map(([, a]) => a)).toEqual([
      ["run_id", "run-1"],
      ["tool_use_id", "toolu_1"],
      ["status", "pending"],
    ]);
    expect(calls[0]).toEqual(["from", "agent_tool_effects"]);
  });
});
