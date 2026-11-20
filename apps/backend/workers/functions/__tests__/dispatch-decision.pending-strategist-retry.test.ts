
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown> & { id: string; status: string };
const db = vi.hoisted(() => ({
  decisions: [] as Array<Record<string, unknown> & { id: string; status: string }>,
  emits: [] as Array<Record<string, unknown>>,
  failRetryRead: false,
  failDeferWrite: false,
}));

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const orders: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
  let patch: Record<string, unknown> | null = null;
  let cols: string | null = null;
  let max = Infinity;
  const run = () => {
    if (table !== "decisions") return { data: null, error: null };
    if (cols?.includes("dispatch_attempts") && !patch && db.failRetryRead) return { data: null, error: { message: "boom" } };
    if (patch && "dispatch_retry_after" in patch && db.failDeferWrite) return { data: null, error: { message: "write lost" } };
    for (const r of db.decisions) r.dispatch_eligible_at = r.dispatch_retry_after ?? r.emitted_at ?? null;
    let hit = db.decisions.filter((r) => filters.every((f) => f(r)));
    if (patch) for (const r of hit) Object.assign(r, patch, { dispatch_eligible_at: (patch.dispatch_retry_after ?? r.dispatch_retry_after ?? r.emitted_at) as unknown });
    for (const o of [...orders].reverse()) {
      hit = [...hit].sort((a, b) => {
        const x = a[o.col] as string | null | undefined;
        const y = b[o.col] as string | null | undefined;
        if (x == null || y == null) return x == null && y == null ? 0 : (x == null) === o.nullsFirst ? -1 : 1;
        return (x < y ? -1 : x > y ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    return { data: hit.slice(0, max).map((r) => ({ ...r })), error: null };
  };
  const b: Record<string, unknown> = {
    select: (c?: string) => ((cols = c ?? "*"), b),
    update: (p: Record<string, unknown>) => ((patch = p), b),
    insert: () => b,
    upsert: () => b,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    neq: () => b,
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    or: (expr: string) => {
      const m = /^(\w+)\.is\.null,\1\.(lte|lt)\."([^"]+)"$/.exec(expr);
      if (!m) throw new Error(`unexpected or(): ${expr}`);
      const [, col, op, iso] = m;
      filters.push((r) => r[col!] == null || (op === "lt" ? String(r[col!]) < iso! : String(r[col!]) <= iso!));
      return b;
    },
    is: () => b,
    gte: () => b,
    lte: () => b,
    gt: () => b,
    lt: () => b,
    order: (col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => (
      orders.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst === true }), b
    ),
    limit: async (n: number) => ((max = n), run()),
    maybeSingle: async () => {
      const { data, error } = run();
      return { data: Array.isArray(data) ? data[0] ?? null : data, error };
    },
    single: async () => {
      const { data, error } = run();
      return { data: Array.isArray(data) ? data[0] ?? null : data, error };
    },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "emit_decision") return { data: null, error: null };
      db.emits.push(args);
      return { data: `final-${db.emits.length}`, error: null };
    },
  }),
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}), send: vi.fn(async () => ({})) } }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}), LOG_META_KEYS: [] }));
vi.mock("@/services/channels/exec-kill-switch", () => ({
  platformWriteEnabled: async () => true,
  execPlatform: () => "meta_ads",
  execPlatformLabel: () => "Meta Ads",
}));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));
vi.mock("@/services/meta-ads/strategist-gate/review-state", () => ({ findFinalCreateFor: vi.fn(async () => null) }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveAdDecision: vi.fn(async () => false) }));
const resolveBid = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/meta-ads/write/_ad-set-bid", () => ({ resolveCreateAdSetBid: resolveBid }));
const alertFounder = vi.hoisted(() => vi.fn(async () => ({ sent: 1, urgent_ids: [] as string[] })));
vi.mock("@/services/growth/cgo-blockers", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-blockers")>()),
  alertFounderSafely: alertFounder,
}));

import {
  __testOnly_executeDispatch as executeDispatch,
  scanAutoCronRows,
  autoCronDispatchBatch,
  DRAIN_ROTATE_MS,
  DISPATCH_RETRY_MAX_AGE_MS,
  DISPATCH_RETRY_MAX_ATTEMPTS,
  DISPATCH_RETRY_BASE_MS,
} from "../dispatch-decision";
import { buildPendingStrategistBody } from "@/services/meta-ads/strategist-gate/pending-body";
import { ExpectedToolError } from "@/services/tools/types";
import { blockerSeverity, type Blocker } from "@/services/growth/cgo-blockers";

const CREATE = {
  campaign_id: "camp-1",
  name: "Broad",
  daily_budget_usd: 20,
  optimization_goal: "LINK_CLICKS",
  billing_event: "IMPRESSIONS",
  targeting: { geo_locations: { countries: ["US"] } },
  rationale: "Broad test.",
};
const metaDown = () => new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 503 down", { http_status: 503 });
const metaThrottled = () =>
  new ExpectedToolError("meta_ads_query_failed", "Meta Ads request failed: 400 {}", { http_status: 400, graph_code: 17 });
const bidRefused = () =>
  new ExpectedToolError("meta_ads_bid_conflict", "this campaign uses LOWEST_COST_WITH_BID_CAP for all its ad sets");

function park(extra: Record<string, unknown> = {}, id = "pending-1") {
  db.decisions.push({
    id,
    tenant_id: "t-1",
    agent_run_id: null,
    decision_class: "perfmkt.create_ad_set_pending_strategist",
    handler: "perfmkt.create_ad_set_pending_strategist",
    body: buildPendingStrategistBody(CREATE as never, {}) as unknown as Record<string, unknown>,
    status: "proposed",
    autonomy_at_emit: "auto",
    emitted_at: "2026-10-01T00:00:00.000Z",
    approved_by: null,
    approved_by_source: null,
    dispatch_attempts: 0,
    dispatch_retry_since: null,
    dispatch_retry_after: null,
    ...extra,
  });
  return db.decisions[db.decisions.length - 1]!;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const alertedWith = () => (alertFounder.mock.calls[0] as unknown as [string, string, Blocker[]] | undefined)?.[2]?.[0];

beforeEach(() => {
  db.decisions.length = 0;
  db.emits.length = 0;
  db.failRetryRead = false;
  db.failDeferWrite = false;
  alertFounder.mockClear();
  resolveBid.mockReset();
  resolveBid.mockImplementation(async (_t: string, body: unknown) => body);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parked Meta create: a brief bid-read failure keeps it pending", () => {
  it("a Meta 503 puts the row back to proposed, counted and backed off; once eligible the drain sends the card", async () => {
    const row = park();
    resolveBid.mockRejectedValueOnce(metaDown());
    const before = Date.now();
    expect(await executeDispatch("pending-1")).toEqual({ ok: false, error: "retry_later" });
    expect(row.status).toBe("proposed");
    expect(row.dispatch_attempts).toBe(1);
    expect(typeof row.dispatch_retry_since).toBe("string");
    const after = new Date(String(row.dispatch_retry_after)).getTime();
    expect(after - before).toBeGreaterThanOrEqual(DISPATCH_RETRY_BASE_MS - 1000);
    expect(after - before).toBeLessThanOrEqual(DISPATCH_RETRY_BASE_MS + 5000);
    expect(String(row.dispatch_error)).toMatch(/stays pending/);
    expect(db.emits).toHaveLength(0);

    expect(await scanAutoCronRows(true)).toEqual([]);
    expect((await scanAutoCronRows(true, new Date(after + 1000))).map((r) => r.id)).toEqual(["pending-1"]);
    const r2 = await executeDispatch("pending-1");
    expect(r2.ok).toBe(true);
    expect(row.status).toBe("acted");
    expect(db.emits).toHaveLength(1);
    expect(db.emits[0]!.p_decision_class).toBe("meta_ads.create_ad_set");
    expect(alertFounder).not.toHaveBeenCalled();
  });

  it("throttling (code 17 on a 400) is brief; the first-failure time is kept and the backoff doubles", async () => {
    const since = hoursAgo(1);
    const row = park({ dispatch_attempts: 2, dispatch_retry_since: since });
    resolveBid.mockRejectedValueOnce(metaThrottled());
    const before = Date.now();
    expect((await executeDispatch("pending-1")).error).toBe("retry_later");
    expect(row.status).toBe("proposed");
    expect(row.dispatch_attempts).toBe(3);
    expect(row.dispatch_retry_since).toBe(since);
    expect(new Date(String(row.dispatch_retry_after)).getTime() - before).toBeGreaterThanOrEqual(4 * DISPATCH_RETRY_BASE_MS - 1000);
  });

  it("a network failure with no HTTP answer (ECONNRESET) is brief", async () => {
    const row = park();
    resolveBid.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    expect((await executeDispatch("pending-1")).error).toBe("retry_later");
    expect(row.status).toBe("proposed");
  });
});

describe("parked Meta create: a real refusal ends it", () => {
  it("a bid the campaign cannot take settles dispatch_failed and emits nothing", async () => {
    const row = park();
    resolveBid.mockRejectedValueOnce(bidRefused());
    const r = await executeDispatch("pending-1");
    expect(r.ok).toBe(false);
    expect(row.status).toBe("dispatch_failed");
    expect(String(row.dispatch_error)).toMatch(/LOWEST_COST_WITH_BID_CAP.*nothing was sent to approvals/);
    expect(row.dispatch_attempts).toBe(0);
    expect(db.emits).toHaveLength(0);
    expect(await scanAutoCronRows(true)).toEqual([]);
  });

  it("a token Meta no longer accepts is final, not retried", async () => {
    const row = park();
    resolveBid.mockRejectedValueOnce(new ExpectedToolError("meta_ads_token_expired", "reconnect"));
    await executeDispatch("pending-1");
    expect(row.status).toBe("dispatch_failed");
  });
});

describe("parked Meta create: the retries are hard-bounded", () => {
  it("a row past 24 hours is never run, even if Meta would answer now: no stale card", async () => {
    const row = park({ dispatch_attempts: 143, dispatch_retry_since: new Date(Date.now() - DISPATCH_RETRY_MAX_AGE_MS - 60_000).toISOString() });
    const r = await executeDispatch("pending-1");
    expect(r.ok).toBe(false);
    expect(resolveBid).not.toHaveBeenCalled();
    expect(db.emits).toHaveLength(0);
    expect(row.status).toBe("dispatch_failed");
    expect(row.dispatch_error).toBe(
      "Zavi tried 143 times over 24 hours and Meta did not answer, so this ad set was not created. Nothing was spent. Ask Zavi to propose it again.",
    );
    expect(await scanAutoCronRows(true, new Date(Date.now() + 10 * DISPATCH_RETRY_MAX_AGE_MS))).toEqual([]);
  });

  it("the 200th try is the last: it runs, fails, and stops", async () => {
    const row = park({ dispatch_attempts: DISPATCH_RETRY_MAX_ATTEMPTS - 1, dispatch_retry_since: hoursAgo(2) });
    resolveBid.mockRejectedValueOnce(metaDown());
    await executeDispatch("pending-1");
    expect(resolveBid).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("dispatch_failed");
    expect(String(row.dispatch_error)).toMatch(/^Zavi tried 200 times over 2 hours and Meta did not answer/);
  });

  it("a row with 200 failed tries is never run again", async () => {
    const row = park({ dispatch_attempts: DISPATCH_RETRY_MAX_ATTEMPTS, dispatch_retry_since: hoursAgo(2) });
    await executeDispatch("pending-1");
    expect(resolveBid).not.toHaveBeenCalled();
    expect(row.status).toBe("dispatch_failed");
    expect(db.emits).toHaveLength(0);
  });

  it("an unreadable retry state runs nothing and releases the claim (no guess)", async () => {
    const row = park();
    db.failRetryRead = true;
    expect((await executeDispatch("pending-1")).error).toBe("retry_state_unreadable");
    expect(resolveBid).not.toHaveBeenCalled();
    expect(row.status).toBe("proposed");
  });

  it("a defer write that does not land fails the row rather than leaving it dispatching", async () => {
    const row = park();
    db.failDeferWrite = true;
    resolveBid.mockRejectedValueOnce(metaDown());
    await executeDispatch("pending-1");
    expect(row.status).toBe("dispatch_failed");
    expect(String(row.dispatch_error)).toMatch(/could not put it back in the queue/);
    expect(alertFounder).not.toHaveBeenCalled();
  });
});

describe("parked Meta create: the founder is told when retries run out", () => {
  it("no chat or Slack thread (a scheduled row): the Needs-you-now alert still fires with the plain message", async () => {
    park({ dispatch_attempts: DISPATCH_RETRY_MAX_ATTEMPTS - 1, dispatch_retry_since: hoursAgo(5) });
    resolveBid.mockRejectedValueOnce(metaDown());
    await executeDispatch("pending-1");
    expect(alertFounder).toHaveBeenCalledTimes(1);
    expect((alertFounder.mock.calls[0] as unknown as [string])[0]).toBe("t-1");
    const b = alertedWith()!;
    expect(b.id).toBe("retries_exhausted:pending-1");
    expect(b.what).toBe(
      "Zavi tried 200 times over 5 hours and Meta did not answer, so this ad set was not created. Nothing was spent. Ask Zavi to propose it again.",
    );
    expect(blockerSeverity(b)).toBe("urgent");
    expect(b.at_risk_now).toBe(false);
  });

  it("a row stopped before running (past 24h) alerts too", async () => {
    park({ dispatch_attempts: 150, dispatch_retry_since: hoursAgo(25) });
    await executeDispatch("pending-1");
    expect(alertedWith()?.what).toMatch(/^Zavi tried 150 times over 25 hours/);
  });

  it("a real refusal does not use the retries-exhausted alert", async () => {
    park();
    resolveBid.mockRejectedValueOnce(bidRefused());
    await executeDispatch("pending-1");
    expect(alertFounder).not.toHaveBeenCalled();
  });
});

describe("the drain is not starved by failing rows", () => {
  it("60 throttled rows and 1 healthy row: the healthy one is in the first batch", async () => {
    for (let i = 0; i < 60; i++) park({ emitted_at: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z` }, `throttled-${i}`);
    resolveBid.mockRejectedValue(metaThrottled());
    for (let i = 0; i < 60; i++) expect((await executeDispatch(`throttled-${i}`)).error).toBe("retry_later");
    park({ emitted_at: "2026-10-12T00:00:00.000Z" }, "healthy");

    const batch = await scanAutoCronRows(true);
    expect(batch.map((r) => r.id)).toEqual(["healthy"]);

    park({ emitted_at: "2026-10-12T01:00:00.000Z" }, "healthy-2");
    const later = await scanAutoCronRows(true, new Date(Date.now() + 3 * 3_600_000));
    expect(later).toHaveLength(50);
    expect(later.slice(0, 2).map((r) => r.id)).toEqual(["healthy", "healthy-2"]);
  });
});

describe("the drain is one fair queue: rows a gate holds rotate out", () => {
  const held = (i: number) =>
    park(
      { decision_class: "growth.save_business_controls", handler: null, emitted_at: `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` },
      `held-${i}`,
    );

  it("60 held rows and a new auto row: held rows visited once go behind newer work", async () => {
    for (let i = 0; i < 60; i++) held(i);
    const pass1 = await scanAutoCronRows(false);
    expect(pass1).toHaveLength(50);
    await autoCronDispatchBatch(pass1);
    const rotated = db.decisions.filter((r) => r.id.startsWith("held-") && r.dispatch_retry_after);
    expect(rotated).toHaveLength(50);
    expect(rotated.every((r) => r.status === "proposed" && r.dispatch_attempts === 0)).toBe(true);
    const until = new Date(String(rotated[0]!.dispatch_retry_after)).getTime();
    expect(until - Date.now()).toBeGreaterThan(DRAIN_ROTATE_MS - 60_000);

    park({ emitted_at: new Date(Date.now() - 1000).toISOString() }, "new-row");
    const pass2 = await scanAutoCronRows(false);
    expect(pass2.map((r) => r.id)).toContain("new-row");
    expect(pass2.filter((r) => rotated.some((x) => x.id === r.id))).toEqual([]);
    expect(pass2).toHaveLength(11);
    await autoCronDispatchBatch(pass2);
    expect(db.decisions.find((r) => r.id === "new-row")!.status).toBe("acted");
  });

  it("a visit never shortens a longer retry backoff", async () => {
    const row = park();
    resolveBid.mockRejectedValue(metaThrottled());
    row.dispatch_attempts = 3;
    row.dispatch_retry_since = hoursAgo(1);
    await autoCronDispatchBatch(await scanAutoCronRows(false));
    const after = new Date(String(row.dispatch_retry_after)).getTime() - Date.now();
    expect(after).toBeGreaterThan(70 * 60_000);
  });
});
