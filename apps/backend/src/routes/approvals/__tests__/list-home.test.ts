import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();
const logEvent = vi.fn();
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

type Call = { table: string; ops: Array<[string, unknown[]]> };
let calls: Call[] = [];
let seed: (c: Call) => { data?: unknown; error?: unknown; count?: number | null };

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "not", "or", "order", "limit", "gte", "lte"]) {
        chain[m] = (...a: unknown[]) => {
          call.ops.push([m, a]);
          return chain;
        };
      }
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, count: null, ...seed(call) }).then(resolve);
      return chain;
    },
  }),
}));

const TENANT = "11111111-1111-1111-1111-111111111111";
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  id: rid(n),
  agent_run_id: "run-1",
  decision_class: "pm.ticket",
  body: {},
  status: "proposed",
  autonomy_at_emit: "approval",
  handler: null,
  emitted_at: `2026-10-17T10:00:${String(60 - n).padStart(2, "0")}.000Z`,
  home: "needs_you",
  home_channel: null,
  ...extra,
});

const isHead = (c: Call) => c.ops.some(([m, a]) => m === "select" && (a[1] as { head?: boolean } | undefined)?.head === true);
const eqs = (c: Call) => c.ops.filter(([m]) => m === "eq").map(([, a]) => a);

function res() {
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  return {
    out,
    json: (b: Record<string, unknown>) => void (out.body = b),
    status: (s: number) => {
      out.status = s;
      return { json: (b: Record<string, unknown>) => (out.body = b) };
    },
  };
}
async function call(query: Record<string, unknown>) {
  const { approvalsList } = await import("../list");
  const r = res();
  await approvalsList({ query } as never, r as never);
  return r.out;
}

let pageRows: unknown[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  requireAuth.mockResolvedValue({ tenant_id: TENANT, access_token: "t", user_id: "u" });
  pageRows = [row(1), row(2), row(3)];
  seed = (c) => {
    if (c.table === "customer_visible_pending_decisions") {
      if (isHead(c)) {
        const h = eqs(c).find(([k]) => k === "home")?.[1];
        return { count: h === "needs_you" ? 3 : h === "growth" ? 7 : 2 };
      }
      const lim = c.ops.find(([m]) => m === "limit")?.[1][0] as number;
      return { data: pageRows.slice(0, lim) };
    }
    if (c.table === "agent_runs") return { data: [{ id: "run-1", agent_slug: "pm", payload: { thread_id: "th-1" }, stop_requested: false }] };
    return { data: [] };
  };
});

describe("GET /api/approvals?home=", () => {
  it("pages one home: filtered on home + tenant, newest first, limit+1 read, next_cursor set", async () => {
    const out = await call({ home: "needs_you", limit: "2" });
    expect(out.status).toBe(200);
    const page = calls.find((c) => c.table === "customer_visible_pending_decisions" && !isHead(c))!;
    expect(eqs(page)).toEqual(expect.arrayContaining([["tenant_id", TENANT], ["home", "needs_you"]]));
    expect(page.ops.filter(([m]) => m === "order").map(([, a]) => a[0])).toEqual(["emitted_at", "id"]);
    expect(page.ops.find(([m]) => m === "limit")?.[1][0]).toBe(3);
    const body = out.body as { decisions: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(body.decisions.map((d) => d.id)).toEqual([rid(1), rid(2)]);
    expect(body.decisions[0]).toMatchObject({ agent_slug: "pm", thread_id: "th-1", home: "needs_you", needs_owner_admin: false, action_source: "decision" });
    expect(body.next_cursor).toEqual(expect.any(String));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "approvals.list_served", meta: expect.objectContaining({ home: "needs_you", page_size: 2, count: 2 }) }));
  });

  it("the next page continues strictly after the cursor; the last page has next_cursor null", async () => {
    const first = (await call({ home: "needs_you", limit: "2" })).body as { next_cursor: string };
    calls = [];
    pageRows = [row(3)];
    const out = await call({ home: "needs_you", limit: "2", cursor: first.next_cursor });
    const page = calls.find((c) => c.table === "customer_visible_pending_decisions" && !isHead(c))!;
    const or = page.ops.find(([m]) => m === "or")?.[1][0] as string;
    const t = row(2).emitted_at;
    expect(or).toBe(`emitted_at.lt."${t}",and(emitted_at.eq."${t}",id.lt.${rid(2)})`);
    expect((out.body as { next_cursor: unknown }).next_cursor).toBeNull();
  });

  it("count=1 returns the true total of all three homes, each read with tenant + home", async () => {
    const out = await call({ home: "needs_you", count: "1" });
    expect((out.body as { totals: unknown }).totals).toEqual({ channel: 2, growth: 7, needs_you: 3 });
    const heads = calls.filter(isHead);
    expect(heads).toHaveLength(3);
    for (const h of heads) expect(eqs(h)).toContainEqual(["tenant_id", TENANT]);
  });

  it("every read keeps the tenant filter", async () => {
    await call({ home: "growth", count: "1" });
    for (const c of calls.filter((c) => c.table !== "decision_classes")) expect(eqs(c), c.table).toContainEqual(["tenant_id", TENANT]);
  });

  it("flags an owner/admin-only approve", async () => {
    pageRows = [row(1, { decision_class: "meta_ads.launch_campaign", home: "growth" })];
    const out = await call({ home: "growth" });
    expect((out.body as { decisions: Array<Record<string, unknown>> }).decisions[0].needs_owner_admin).toBe(true);
  });

  it("serves Autopilot's hold as words + evidence only, and the founder's card warnings", async () => {
    pageRows = [
      row(1, {
        decision_class: "google_ads.update_campaign_budget_review",
        home: "growth",
        cgo_hold: { reasons: ["objective_metric_mismatch"], words: ["it is not set up to get conversions"], evidence: "7-day spend $40", at: "x" },
        founder_advice: { warnings: ["it is not set up to get conversions"], at: "x" },
      }),
      row(2),
    ];
    const out = await call({ home: "growth" });
    const [held, plain] = (out.body as { decisions: Array<Record<string, unknown>> }).decisions;
    expect(held.cgo_hold).toEqual({ words: ["it is not set up to get conversions"], evidence: "7-day spend $40" });
    expect(held.founder_advice).toEqual({ warnings: ["it is not set up to get conversions"] });
    expect(JSON.stringify(held)).not.toContain("objective_metric_mismatch");
    expect(plain.cgo_hold).toBeNull();
    const page = calls.find((c) => c.table === "customer_visible_pending_decisions" && !isHead(c))!;
    expect(String(page.ops.find(([m]) => m === "select")?.[1][0])).toContain("cgo_hold, founder_advice");
  });

  it("a channel-home row carries its channel as channel_slug", async () => {
    pageRows = [row(1, { decision_class: "seo.publish", home: "channel", home_channel: "seo" })];
    const out = await call({ home: "channel" });
    expect((out.body as { decisions: Array<Record<string, unknown>> }).decisions[0].channel_slug).toBe("seo");
  });

  it("lists several homes in one page (the Growth page: growth + channel)", async () => {
    await call({ home: "growth,channel", count: "1" });
    const page = calls.find((c) => c.table === "customer_visible_pending_decisions" && !isHead(c))!;
    expect(page.ops.find(([m]) => m === "in")?.[1]).toEqual(["home", ["growth", "channel"]]);
    expect(eqs(page)).toContainEqual(["tenant_id", TENANT]);
  });

  it.each([
    [{ home: "bogus" }, "invalid_home"],
    [{ home: "growth,growth" }, "invalid_home"],
    [{ home: "growth," }, "invalid_home"],
    [{ home: "needs_you", limit: "0" }, "invalid_limit"],
    [{ home: "needs_you", limit: "101" }, "invalid_limit"],
    [{ home: "needs_you", cursor: "not-a-cursor" }, "invalid_cursor"],
    [{ home: "needs_you", cursor: Buffer.from("2026-10-17T10:00:00Z|x),id.gt.0").toString("base64url") }, "invalid_cursor"],
    [{ home: "needs_you", channel: "seo" }, "invalid_query"],
  ])("%j → 400 %s", async (q, code) => {
    const out = await call(q);
    expect(out.status).toBe(400);
    expect((out.body as { error: { code: string } }).error.code).toBe(code);
  });

  it("a read error is a 500 with a log line, never an empty list", async () => {
    seed = (c) => (c.table === "customer_visible_pending_decisions" ? { error: { message: "boom", code: "57014" } } : { data: [] });
    const out = await call({ home: "needs_you" });
    expect(out.status).toBe(500);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "approvals.list_failed" }));
  });

  it("a failed count is a 500 too (a pill must never show a wrong total)", async () => {
    seed = (c) => (c.table === "customer_visible_pending_decisions" && isHead(c) ? { error: { message: "boom" } } : { data: [] });
    const out = await call({ home: "needs_you", count: "1" });
    expect(out.status).toBe(500);
    expect((out.body as { error: { code: string } }).error.code).toBe("count_failed");
  });
});

describe("cursor codec", () => {
  it("round-trips and rejects junk", async () => {
    const { encodeHomeCursor, decodeHomeCursor } = await import("@/services/approvals/list-home");
    const c = { emitted_at: "2026-10-17T10:00:00.123+00:00", id: rid(9) };
    expect(decodeHomeCursor(encodeHomeCursor(c))).toEqual(c);
    expect(decodeHomeCursor("")).toBeNull();
    expect(decodeHomeCursor(Buffer.from(`nope|${rid(9)}`).toString("base64url"))).toBeNull();
  });
});
