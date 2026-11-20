import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { id: string; tenant_id: string; decision_class: string; body: Record<string, unknown>; status: string; agent_run_id: string | null; dispatch_error: string | null };
const db = vi.hoisted(() => ({ rows: [] as Row[], actions: [] as Array<Record<string, unknown>>, editOk: true, rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>, seq: 0, emitFailAt: 0, emits: 0, editFailAt: 0, edits: 0 }));
const fakeRpc = vi.hoisted(() => async (fn: string, args: Record<string, unknown>) => {
      db.rpcs.push({ fn, args: structuredClone(args) });
      if (fn === "edit_decision_body_if_proposed") {
        if (++db.edits === db.editFailAt) return { data: { ok: false, reason: "write failed" }, error: null };
        const r = db.rows.find((x) => x.id === args.p_decision_id);
        if (!db.editOk || !r || r.status !== "proposed") return { data: { ok: false, reason: "not_proposed" }, error: null };
        r.body = structuredClone(args.p_body as Record<string, unknown>);
        return { data: { ok: true }, error: null };
      }
      if (fn === "emit_decision") {
        if (++db.emits === db.emitFailAt) return { data: null, error: { message: "insert failed" } };
        const id = `00000000-0000-4000-8000-0000000000${String(++db.seq).padStart(2, "0")}`;
        db.rows.push({ id, tenant_id: "t-1", decision_class: String(args.p_decision_class), body: structuredClone(args.p_body as Record<string, unknown>), status: "proposed", agent_run_id: (args.p_agent_run_id as string) ?? null, dispatch_error: null });
        return { data: id, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    });

const pathGet = (r: Record<string, unknown>, col: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) return (r[m[1]] as Record<string, unknown> | null)?.[m[2]];
  return r[col];
};
const subset = (have: unknown, want: unknown): boolean => {
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => subset(h, w)));
  if (want && typeof want === "object") return !!have && typeof have === "object" && Object.entries(want).every(([k, v]) => subset((have as Record<string, unknown>)[k], v));
  return have === want;
};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown> = {}) => fakeRpc(fn, { ...args, p_tenant_id: tid }),
  tenantClient: () => ({
    from: (table: string) => {
      const f: Array<(r: Record<string, unknown>) => boolean> = [];
      const rows = () => ((table === "channel_actions" ? db.actions : db.rows) as Row[]).filter((r) => f.every((x) => x(r as never))).map((r) => ({ ...r, body: structuredClone(r.body) }));
      const self: Record<string, unknown> = {
        select: () => self,
        eq: (c: string, v: unknown) => (f.push((r) => pathGet(r, c) === v), self),
        in: (c: string, v: unknown[]) => (f.push((r) => v.includes(pathGet(r, c))), self),
        or: (expr: string) => {
          const parts = expr.split(",").map((p) => /^(.+?)\.eq\.(.+)$/.exec(p)!).map((m) => [m[1], m[2].replace(/^"|"$/g, "")]);
          f.push((r) => parts.some(([c, v]) => pathGet(r, c) === v));
          return self;
        },
        contains: (c: string, v: unknown) => (f.push((r) => subset(r[c], v)), self),
        limit: () => self,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: rows(), error: null }),
      };
      return self;
    },
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: fakeRpc }),
}));
const decide = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, refuse: new Map<string, Record<string, unknown>>() }));
vi.mock("@/services/approvals/decide-service", () => ({
  decideOnDecision: vi.fn(async (a: Record<string, unknown>) => {
    decide.calls.push(a);
    const refused = decide.refuse.get(String(a.decision_id));
    if (refused) return { ok: false, changed: false, ...refused };
    const r = db.rows.find((x) => x.id === a.decision_id);
    if (r && r.status === "proposed") r.status = a.action === "reject" ? "rejected" : "approved";
    return { ok: true, code: "ok", changed: true, status: r?.status };
  }),
}));
const live = vi.hoisted(() => ({ holds: new Set<string>(), filing: "quiet" as string }));
vi.mock("../move-group", async (orig) => ({
  ...(await orig<typeof import("../move-group")>()),
  cutStillHolds: vi.fn(async (_t: string, leg: { body: Record<string, unknown> }) => live.holds.has(String(leg.body.campaign_id ?? leg.body.ad_set_id ?? leg.body.object_id))),
  readOrderLiveness: vi.fn(async () => live.filing),
}));
const counter = vi.hoisted(() => ({ month: null as unknown }));
vi.mock("@/services/decisions/ad-month-counter", async (orig) => {
  const real = await orig<typeof import("@/services/decisions/ad-month-counter")>();
  const { raiseFromCard } = await import("@/services/growth/ad-budget-shortfall");
  return {
    ...real,
    readMonthCount: vi.fn(async () => counter.month),
    readRaiseFit: vi.fn(async (_t: string, cls: string, body: unknown) => {
      const r = raiseFromCard(cls, body);
      if (r === null) return { kind: "unreadable", why: "card" };
      if (r === "not_a_raise" || r === "non_usd" || r.platform === "chatgpt") return { kind: "not_a_raise" };
      const m = counter.month as Awaited<ReturnType<typeof real.readMonthCount>>;
      if (!m) return { kind: "no_budget" };
      if ("unreadable" in m) return { kind: "unreadable", why: m.unreadable };
      const raise = { platform: r.platform, object_id: r.object_id, delta_daily_usd: r.new_daily_usd - r.current_daily_usd };
      return { ...real.fitDailyChange(m.count, m.view, m.live_held_daily_usd, raise.delta_daily_usd), token: m.token, raise, live_held_daily_usd: m.live_held_daily_usd, view: m.view };
    }),
  };
});
const judge = vi.hoisted(() => ({ cands: [] as unknown[] }));
vi.mock("../ad-spend-controller", async (orig) => ({ ...(await orig<typeof import("../ad-spend-controller")>()), founderCutCandidates: vi.fn(async () => ({ cands: judge.cands, step: 0.2 })) }));
vi.mock("@/services/tools/google-ads/write/_currency-guard", async (orig) => ({ ...(await orig<typeof import("@/services/tools/google-ads/write/_currency-guard")>()), readGoogleAccountCurrency: async () => "USD" }));
const alerts = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../cgo-blockers", () => ({ alertFounderSafely: alerts }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => "owner" }));
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => true }));

import { advanceMove, approveMove, cutsVerdict, findMoneyView, moveFit, moveKeyOf, moveView, planMove, rejectMove, rewireCutIds, tellRaiseFailed, type MoveLine } from "../move-card";
import { countMonth } from "@/services/decisions/ad-month-counter";
import { resetFindMoneyCache } from "../founder-cut-candidates";

const T = "t-1";
const OWNER = "owner-1";
const RAISE = "aaaaaaaa-0000-4000-8000-000000000001";
const CUT = "aaaaaaaa-0000-4000-8000-000000000002";
const PAUSE_OTHER = "aaaaaaaa-0000-4000-8000-000000000003";
const founderBody = (o: Record<string, unknown>, group = "run-root") => ({ origin: "user_initiated_chat", founder_chat_order: true, move_group: group, ...o });
const raiseRow = (o: Partial<Row> = {}): Row => ({ id: RAISE, tenant_id: T, decision_class: "google_ads.update_campaign_budget_review", body: founderBody({ campaign_id: "c1", campaign_name: "Atlanta", daily_budget_usd: 70, expected_current_daily_budget_usd: 40 }), status: "proposed", agent_run_id: "run-root", dispatch_error: null, ...o });
const cutRow = (o: Partial<Row> = {}): Row => ({ id: CUT, tenant_id: T, decision_class: "google_ads.update_campaign_budget_review", body: founderBody({ campaign_id: "c2", campaign_name: "Dallas", daily_budget_usd: 10, expected_current_daily_budget_usd: 40 }), status: "proposed", agent_run_id: "run-root", dispatch_error: null, ...o });
const row = (id: string) => db.rows.find((r) => r.id === id)!;
const approvedIds = () => decide.calls.filter((c) => c.action === "approve").map((c) => c.decision_id);
const view = { id: "b-1", status: "active", monthly_usd: 27000, month_cap_usd: 27000, spent_usd: 18000, held_usd: 0, creator_held_usd: 0, creator_spent_usd: 0, left_usd: 9000, daily_limit_usd: null, next_month_start: "2026-11-01", days_left: 8, days_in_month: 31, margin: 1.1, started_on: "2026-08-01", created_at: "2026-08-01T00:00:00Z", stopped_at: null, month_start: "2026-10-01" };
const month = (projected: number) => ({ token: "tok", view, live_held_daily_usd: 0, count: countMonth("b-1", view as never, { spent_usd: 18000, creator_usd: 0, month_cap_usd: 27000, days_left: 8, running_daily_usd: 0, projected_usd: projected, over: false, daily: [], cannot_lower: [] }, 0) });

beforeEach(() => {
  db.rows = [raiseRow(), cutRow()];
  db.actions = [];
  db.editOk = true;
  db.rpcs = [];
  db.seq = 0;
  db.emitFailAt = 0;
  db.emits = 0;
  db.editFailAt = 0;
  db.edits = 0;
  judge.cands = [];
  decide.calls = [];
  decide.refuse.clear();
  live.holds = new Set();
  live.filing = "quiet";
  counter.month = month(27000);
  alerts.mockClear();
});

describe("pure", () => {
  it("moveKeyOf: a founder leg's group, a raise: group without the founder mark, else null", () => {
    expect(moveKeyOf(founderBody({}))).toBe("run-root");
    expect(moveKeyOf({ move_group: `raise:${RAISE}` })).toBe(`raise:${RAISE}`);
    expect(moveKeyOf({ move_group: "run-root" })).toBeNull();
    expect(moveKeyOf({ move_group: "raise:not-a-uuid" })).toBeNull();
  });
  const line = (id: string, side: MoveLine["side"], delta: number | null, state: MoveLine["state"] = "open"): MoveLine => ({ id, exec_class: "x", body: {}, status: "proposed", state, side, daily_delta: delta, agent_run_id: null, dispatch_error: null });
  it("planMove: cuts first, must-catch Oct 20: a line of another move is not_in_move; non-open, unknown amount", () => {
    const lines = [line("r", "adds", 30), line("c", "lowers", -30)];
    expect(planMove(lines, ["r", "c"])).toMatchObject({ ok: true, net_daily_usd: 0, cuts: [{ id: "c" }], adds: [{ id: "r" }] });
    expect(planMove(lines, ["r", "pause-of-2bdc4968"])).toEqual({ ok: false, code: "not_in_move", line: "pause-of-2bdc4968" });
    expect(planMove([line("r", "adds", 30, "applied")], ["r"])).toEqual({ ok: false, code: "not_open", line: "r" });
    expect(planMove([line("r", "adds", null)], ["r"])).toEqual({ ok: false, code: "amount_unknown", line: "r" });
    expect(planMove(lines, [])).toEqual({ ok: false, code: "nothing_ticked" });
  });
  it("cutsVerdict: wait / go / stop, a failed cut that holds live goes, an applied cut put back stops", () => {
    expect(cutsVerdict([{ id: "c", status: "approved" }], ["c"], new Set())).toBe("wait");
    expect(cutsVerdict([{ id: "c", status: "acted" }], ["c"], new Set(["c"]))).toBe("go");
    expect(cutsVerdict([{ id: "c", status: "dispatch_failed" }], ["c"], new Set(["c"]))).toBe("go");
    expect(cutsVerdict([{ id: "c", status: "acted" }], ["c"], new Set())).toEqual({ stop: ["c"] });
    expect(cutsVerdict([{ id: "c", status: "rejected" }], ["c"], new Set(["c"]))).toEqual({ stop: ["c"] });
  });
  it("rewireCutIds swaps only the old id and clears blocked", () => {
    expect(rewireCutIds({ cut_ids: ["a", "b"], by: "u", at: "t", budget_to_usd: null, daily_limit_to_usd: null, blocked: { code: "cut_failed", at: "t" } }, "a", "z")).toEqual({ cut_ids: ["z", "b"], by: "u", at: "t", budget_to_usd: null, daily_limit_to_usd: null });
  });
});

describe("approveMove", () => {
  it("must-catch Atlanta (order): stamps the raise move_after BEFORE approving the cut, and approves only the cut", async () => {
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    expect(r).toEqual({ ok: true, approved: [CUT], waiting: [RAISE] });
    expect(approvedIds()).toEqual([CUT]);
    expect(row(RAISE).body.move_after).toMatchObject({ cut_ids: [CUT], by: OWNER });
    const editAt = db.rpcs.findIndex((x) => x.fn === "edit_decision_body_if_proposed");
    expect(editAt).toBe(0);
  });

  it("must-catch R5: the stamp sends the FULL body with only move_after added; a failed write approves nothing", async () => {
    const before = structuredClone(row(RAISE).body);
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    const { move_after, ...rest } = db.rpcs[0].args.p_body as Record<string, unknown>;
    expect(rest).toEqual(before);
    expect(move_after).toBeTruthy();
    db.rows = [raiseRow(), cutRow()];
    db.editOk = false;
    decide.calls = [];
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] })).toMatchObject({ ok: false, code: "rpc_error" });
    expect(decide.calls).toHaveLength(0);
  });

  it("must-catch (Codex P1-4): after the cut acted, a re-tap with only the raise ticked re-checks the cut live; it no longer holds, so nothing is approved", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "acted";
    decide.calls = [];
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE] });
    expect(r).toMatchObject({ ok: false, code: "move_waits_on_cuts" });
    expect(decide.calls).toHaveLength(0);
  });

  it("must-catch net-fits / gross-doesn't: cap tight, +$30 raise and -$30 cut needs no choice; advanceMove approves the raise with no limit raise", async () => {
    counter.month = month(27000);
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: CUT, ticked_ids: [RAISE, CUT] })).toMatchObject({ ok: true });
    row(CUT).status = "acted";
    live.holds.add("c2");
    await advanceMove(T, CUT);
    const call = decide.calls.find((c) => c.decision_id === RAISE)!;
    expect(call).toMatchObject({ action: "approve", surface: "web", actor: { user_id: OWNER } });
    expect(call.raise_budget_to_usd).toBeUndefined();
  });

  it("a gross-over move that is net over too needs the choice before anything is written", async () => {
    db.rows[1] = cutRow({ body: founderBody({ campaign_id: "c2", daily_budget_usd: 35, expected_current_daily_budget_usd: 40 }) });
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    expect(r).toMatchObject({ ok: false, code: "budget_choice_required", budget_choice: { kind: "over", raise_to_usd: 27200 } });
    expect(db.rpcs).toHaveLength(0);
    expect(decide.calls).toHaveLength(0);
    const ok = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT], raise_budget_to_usd: 27200 });
    expect(ok).toMatchObject({ ok: true, approved: [CUT] });
    expect(row(RAISE).body.move_after).toMatchObject({ budget_to_usd: 27200 });
  });

  it("must-catch Atlanta (end state, R4): the cut fails; advanceMove leaves the raise proposed and alerts once; Retry files the clone, rewires, approves only the clone", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "dispatch_failed";
    await advanceMove(T, CUT);
    expect(row(RAISE).status).toBe("proposed");
    expect(alerts).toHaveBeenCalledTimes(1);
    expect((alerts.mock.calls[0] as unknown[])[2]).toMatchObject([{ id: `move_cut_failed:${RAISE}` }]);
    expect(row(RAISE).body.move_after).toMatchObject({ blocked: { code: "cut_failed" } });

    decide.calls = [];
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], retry_ids: [CUT] });
    const clone = db.rows.find((x) => x.body.retry_of === CUT)!;
    expect(r).toEqual({ ok: true, approved: [clone.id], waiting: [RAISE] });
    expect(approvedIds()).toEqual([clone.id]);
    expect(row(RAISE).status).toBe("proposed");
    expect(row(RAISE).body.move_after).toMatchObject({ cut_ids: [clone.id] });
    expect((row(RAISE).body.move_after as Record<string, unknown>).blocked).toBeUndefined();
    clone.status = "acted";
    live.holds.add("c2");
    await advanceMove(T, clone.id);
    expect(approvedIds()).toContain(RAISE);
  });

  it("must-catch R4 (second Retry): an approved clone is found by retry_of; nothing new is filed or approved", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "dispatch_failed";
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], retry_ids: [CUT] });
    const emits = () => db.rpcs.filter((x) => x.fn === "emit_decision").length;
    expect(emits()).toBe(1);
    decide.calls = [];
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], retry_ids: [CUT] })).toMatchObject({ ok: true, approved: [] });
    expect(emits()).toBe(1);
    expect(decide.calls).toHaveLength(0);
  });

  it("must-catch R4: a clone still proposed is reused; the rewire is idempotent", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "dispatch_failed";
    decide.refuse.set("00000000-0000-4000-8000-000000000001", { code: "rpc_error" });
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], retry_ids: [CUT] });
    decide.refuse.clear();
    const edits = db.rpcs.filter((x) => x.fn === "edit_decision_body_if_proposed").length;
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], retry_ids: [CUT] });
    expect(r).toMatchObject({ ok: true, approved: ["00000000-0000-4000-8000-000000000001"] });
    expect(db.rpcs.filter((x) => x.fn === "emit_decision")).toHaveLength(1);
    expect(db.rpcs.filter((x) => x.fn === "edit_decision_body_if_proposed")).toHaveLength(edits);
  });

  it("must-catch R5: a rewire that fails approves no clone", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "dispatch_failed";
    db.editOk = false;
    decide.calls = [];
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], retry_ids: [CUT] })).toMatchObject({ ok: false, code: "rpc_error" });
    expect(decide.calls).toHaveLength(0);
  });

  it("must-catch R4 (finish only when asked): cuts done, no finish and the raise unticked is nothing_ticked; finish approves it", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "acted";
    live.holds.add("c2");
    decide.calls = [];
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [] })).toMatchObject({ ok: false, code: "nothing_ticked" });
    expect(decide.calls).toHaveLength(0);
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [], finish: true })).toEqual({ ok: true, approved: [RAISE], waiting: [] });
    expect(approvedIds()).toEqual([RAISE]);
  });

  it("advanceMove: a fresh fit that needs more than recorded leaves the raise proposed, stamps blocked and alerts once", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    row(CUT).status = "acted";
    live.holds.add("c2");
    decide.refuse.set(RAISE, { code: "budget_raise_changed", detail: "more" });
    await advanceMove(T, CUT);
    expect(row(RAISE).status).toBe("proposed");
    expect(row(RAISE).body.move_after).toMatchObject({ blocked: { code: "budget_raise_changed" } });
    expect((alerts.mock.calls[0] as unknown[])[2]).toMatchObject([{ id: `move_needs_choice:${RAISE}` }]);
  });

  it("a raise that ended dispatch_failed: Retry files a clone with move_group and move_after, without budget_choice, and finishes it", async () => {
    db.rows = [raiseRow({ status: "dispatch_failed", body: { ...raiseRow().body, budget_choice: { hold_idem: "x" }, move_after: { cut_ids: [CUT], by: OWNER, at: "t", budget_to_usd: 27100, daily_limit_to_usd: null } } }), cutRow({ status: "acted" })];
    live.holds.add("c2");
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: CUT, ticked_ids: [], retry_ids: [RAISE] });
    const clone = db.rows.find((x) => x.body.retry_of === RAISE)!;
    expect(clone.body).toMatchObject({ move_group: "run-root", move_after: { cut_ids: [CUT] } });
    expect(clone.body.budget_choice).toBeUndefined();
    expect(r).toEqual({ ok: true, approved: [clone.id], waiting: [] });
    expect(decide.calls.find((c) => c.decision_id === clone.id)).toMatchObject({ raise_budget_to_usd: 27100 });
  });

  it("duplicate tap: the same ticks after the stamp and the cut approve make no edit and no approve", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    const rpcs = db.rpcs.length;
    decide.calls = [];
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] })).toEqual({ ok: true, approved: [], waiting: [RAISE] });
    expect(db.rpcs.length).toBe(rpcs);
    expect(decide.calls).toHaveLength(0);
  });

  it("refuses while the order is still filing, and never groups another move's pause", async () => {
    live.filing = "running";
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] })).toMatchObject({ ok: false, code: "move_still_filing" });
    live.filing = "quiet";
    db.rows.push({ id: PAUSE_OTHER, tenant_id: T, decision_class: "meta_ads.set_status_review", body: founderBody({ object_id: "p1", status: "PAUSED" }, "2bdc4968"), status: "proposed", agent_run_id: "2bdc4968", dispatch_error: null });
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, PAUSE_OTHER] })).toEqual({ ok: false, code: "not_in_move", line_id: PAUSE_OTHER });
  });
});

describe("a neutral leg is never a prerequisite (F5)", () => {
  const RENAME = "aaaaaaaa-0000-4000-8000-000000000004";
  const renameRow = (o: Partial<Row> = {}): Row => ({ id: RENAME, tenant_id: T, decision_class: "google_ads.update_campaign", body: founderBody({ campaign_id: "c1", new_name: "Atlanta 2" }), status: "proposed", agent_run_id: "run-root", dispatch_error: null, ...o });
  it("must-catch: rename + raise approves both now; the raise is not stamped and never waits on the rename", async () => {
    db.rows = [raiseRow(), renameRow()];
    counter.month = month(26000);
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, RENAME] });
    expect(r).toMatchObject({ ok: true, waiting: [] });
    expect(approvedIds()).toEqual([RENAME, RAISE]);
    expect(row(RAISE).body.move_after).toBeUndefined();
  });
  it("must-catch: rename approved, then the raise is refused -> never says nothing was approved", async () => {
    db.rows = [raiseRow(), renameRow()];
    counter.month = month(26000);
    decide.refuse.set(RAISE, { ok: false, code: "rpc_error", detail: "Zavi could not check your budget just now. Nothing was approved." });
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, RENAME] });
    decide.refuse.delete(RAISE);
    expect(r).toMatchObject({ ok: false, done: [RENAME] });
    const detail = String((r as { detail?: string }).detail);
    expect(detail).toMatch(/^One change in this move was approved; the rest was not\./);
    expect(detail).not.toMatch(/Nothing was approved/);
  });
  it("cut + rename + raise: only the cut is a prerequisite; an older stamp naming a neutral leg is not blocked by it", async () => {
    db.rows = [raiseRow(), cutRow(), renameRow()];
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT, RENAME] });
    expect(row(RAISE).body.move_after).toMatchObject({ cut_ids: [CUT] });
    row(CUT).status = "acted";
    live.holds.add("c2");
    (row(RAISE).body.move_after as Record<string, unknown>).cut_ids = [CUT, RENAME];
    await advanceMove(T, CUT);
    expect(approvedIds()).toContain(RAISE);
  });
});

describe("a move with a leg on the channel-card rail (F2)", () => {
  it("must-catch: approve-move refuses move_mixed_rails before any stamp or approve; moveView falls back to the per-card UI", async () => {
    db.actions = [{ id: "ca-1", tenant_id: T, exec_class: "google_ads.set_status", exec_payload: founderBody({ campaign_id: "c3", status: "PAUSED" }), status: "pending", exec_status: null, run_id: "run-root" }];
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] })).toMatchObject({ ok: false, code: "move_mixed_rails" });
    expect(db.rpcs).toHaveLength(0);
    expect(decide.calls).toHaveLength(0);
    expect(await moveView(T, RAISE, row(RAISE).body)).toBeNull();
  });
});

describe("rejectMove and moveView", () => {
  it("must-catch: reject after a partial move cancels the open lines, keeps the applied cuts, says so once", async () => {
    db.rows = [raiseRow(), cutRow({ status: "acted" })];
    const r = await rejectMove(T, OWNER, RAISE);
    expect(r).toMatchObject({ ok: true, rejected: [RAISE], closed: [] });
    expect(r.ok && r.kept[0]).toContain("c2");
    expect(decide.calls).toEqual([expect.objectContaining({ decision_id: RAISE, action: "reject" })]);
    expect((alerts.mock.calls[0] as unknown[])[2]).toMatchObject([{ id: "move_rejected_partial:run-root" }]);
  });

  it("must-catch F3: a raise approved meanwhile is not counted as rejected; it is returned as already decided", async () => {
    db.rows = [raiseRow(), cutRow({ status: "acted" })];
    const { decideOnDecision } = await import("@/services/approvals/decide-service");
    (decideOnDecision as unknown as { mockImplementationOnce: (f: unknown) => void }).mockImplementationOnce(async (a: Record<string, unknown>) => {
      decide.calls.push(a);
      row(RAISE).status = "approved";
      return { ok: true, code: "ok", changed: false, status: "approved" };
    });
    const r = await rejectMove(T, OWNER, RAISE);
    expect(r).toMatchObject({ ok: true, rejected: [], closed: [{ id: RAISE, status: "approved" }] });
    expect(alerts).not.toHaveBeenCalled();
  });

  it("moveView: cuts first, a stamped raise waits on its cuts, a single line is no move", async () => {
    await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE, CUT] });
    const v = await moveView(T, RAISE, row(RAISE).body);
    expect(v).toMatchObject({ key: "run-root", still_filing: false, lines: [{ id: CUT, side: "lowers", daily_delta_usd: -30 }, { id: RAISE, side: "adds", daily_delta_usd: 30, waits_on_cuts: true }] });
    db.rows = [raiseRow()];
    expect(await moveView(T, RAISE, row(RAISE).body)).toBeNull();
  });
});

describe("tellRaiseFailed (F4)", () => {
  it("must-catch: a failure that may have reached the platform never says spend did not go up", async () => {
    await tellRaiseFailed(T, { id: RAISE, decision_class: "x", body: {} }, "unknown");
    const b = ((alerts.mock.calls[0] as unknown[])[2] as Array<Record<string, unknown>>)[0];
    expect(b).toMatchObject({ id: `move_raise_failed:${RAISE}`, what: "Zavi could not confirm whether the raise went through. Check the ad account before you retry." });
    expect(JSON.stringify(b)).not.toContain("did not go up");
  });
  it("a raise refused before any platform call may say spend did not go up", async () => {
    await tellRaiseFailed(T, { id: RAISE, decision_class: "x", body: {} }, "never");
    expect(((alerts.mock.calls[0] as unknown[])[2] as Array<Record<string, unknown>>)[0]).toMatchObject({ meanwhile: "your spend did not go up" });
  });
});

describe("find the money elsewhere (Task 3.2)", () => {
  const AUTO = "aaaaaaaa-0000-4000-8000-000000000009";
  const autoRaise = (): Row => ({ id: AUTO, tenant_id: T, decision_class: "google_ads.update_campaign_budget", body: { campaign_id: "c1", name: "Atlanta", daily_budget_usd: 70, expected_current_daily_budget_usd: 40, rationale: "winner", over_cap: false }, status: "proposed", agent_run_id: "cgo-run", dispatch_error: null });
  const cand = (id: string, daily: number) => ({ o: { platform: "google", level: "campaign", id, campaign_id: id, name: id, daily_budget_usd: daily }, why: "clearly worse than its peers", ratio: 3, median: 10 });
  const g = (object_id: string, to_usd: number) => ({ platform: "google" as const, object_id, to_usd });
  const filed = () => db.rows.filter((r) => r.body.found_for_raise === AUTO);
  beforeEach(() => {
    resetFindMoneyCache();
    db.rows = [autoRaise()];
    judge.cands = [cand("g1", 100), cand("g2", 50), cand("g3", 30)];
  });

  it("must-catch: picks matching a fresh read are filed as founder legs of raise:<id>; the raise joins first (no founder mark), is stamped, then the cuts are approved", async () => {
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g1", 80), g("g2", 40)] });
    const ids = filed().map((x) => x.id);
    expect(r).toEqual({ ok: true, approved: ids, waiting: [AUTO] });
    expect(db.rpcs.map((x) => x.fn)).toEqual(["edit_decision_body_if_proposed", "emit_decision", "emit_decision", "edit_decision_body_if_proposed"]);
    expect(db.rpcs[0].args.p_body).toMatchObject({ move_group: `raise:${AUTO}` });
    expect((db.rpcs[0].args.p_body as Record<string, unknown>).founder_chat_order).toBeUndefined();
    expect(db.rpcs[1].args).toMatchObject({ p_agent_run_id: null, p_decision_class: "google_ads.update_campaign_budget_review", p_body: { campaign_id: "g1", daily_budget_usd: 80, expected_current_daily_budget_usd: 100, over_cap: false, founder_chat_order: true, move_group: `raise:${AUTO}`, found_for_raise: AUTO } });
    expect(String((db.rpcs[1].args.p_body as Record<string, unknown>).rationale)).toMatch(/^Cut you picked in Zavi to fund a raise: /);
    expect(row(AUTO).body.move_after).toMatchObject({ cut_ids: ids, by: OWNER });
    expect(approvedIds()).toEqual(ids);
    for (const r2 of filed()) r2.status = "acted";
    live.holds = new Set(["g1", "g2"]);
    counter.month = month(27000 - 30 * 8);
    await advanceMove(T, ids[1]);
    expect(decide.calls.find((c) => c.decision_id === AUTO)).toMatchObject({ action: "approve", actor: { user_id: OWNER } });
  });

  it("a founder's raise in its order: the cuts join that order's group; the raise body is not rewritten for it", async () => {
    db.rows = [raiseRow({ body: { ...raiseRow().body, rationale: "founder asked", over_cap: false } })];
    judge.cands = [cand("g1", 100), cand("g2", 50)];
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: RAISE, ticked_ids: [RAISE], new_cuts: [g("g1", 80), g("g2", 40)] });
    expect(r).toMatchObject({ ok: true, waiting: [RAISE] });
    expect(db.rpcs[0].fn).toBe("emit_decision");
    expect(db.rows.filter((x) => x.body.found_for_raise === RAISE).every((x) => x.body.move_group === "run-root")).toBe(true);
  });

  it("must-catch: a pick whose amount moved is 409 candidates_changed with the fresh list; nothing is filed", async () => {
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g1", 79)] });
    expect(r).toMatchObject({ ok: false, code: "candidates_changed", candidates: [{ object_id: "g1", to_usd: 80 }, { object_id: "g2" }, { object_id: "g3" }] });
    expect(db.rpcs).toHaveLength(0);
    expect(decide.calls).toHaveLength(0);
  });

  it("must-catch: the 2nd of 3 filings fails: says what was filed, stamps nothing, approves nothing; reload shows it as an open, unticked line", async () => {
    db.emitFailAt = 2;
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g1", 80), g("g2", 40), g("g3", 24)] });
    const [id1] = filed().map((x) => x.id);
    expect(r).toMatchObject({ ok: false, code: "move_cut_file_failed", filed: [id1] });
    expect(String((r as { detail?: string }).detail)).toMatch(/^Zavi filed one of the cuts you picked, then could not file the rest/);
    expect(row(AUTO).body.move_after).toBeUndefined();
    expect(decide.calls).toHaveLength(0);
    const v = await moveView(T, AUTO, row(AUTO).body);
    expect(v).toMatchObject({ key: `raise:${AUTO}`, lines: [{ id: id1, side: "lowers", status: "proposed", suggested: true }, { id: AUTO, side: "adds", waits_on_cuts: false, suggested: false }] });
  });

  it("must-catch (Codex F4): the 2nd cut's approve fails after both were filed: done names the 1st, filed names both, never 'nothing was approved'", async () => {
    decide.refuse.set("00000000-0000-4000-8000-000000000002", { code: "rpc_error", detail: "Zavi could not approve this just now. Nothing was approved." });
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g1", 80), g("g2", 40)] });
    const ids = filed().map((x) => x.id);
    expect(ids).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
    expect(r).toMatchObject({ ok: false, code: "move_cut_refused", done: [ids[0]], filed: ids });
    expect(String((r as { detail?: string }).detail)).toMatch(/^One change in this move was approved; the rest was not\./);
    expect(String((r as { detail?: string }).detail)).not.toMatch(/Nothing was approved/);
  });

  it("a refusal after filing with nothing approved still names the filed cuts (the raise's stamp write fails)", async () => {
    db.editFailAt = 2;
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g1", 80), g("g2", 40)] });
    expect(r).toMatchObject({ ok: false, code: "rpc_error", filed: filed().map((x) => x.id) });
    expect((r as { detail?: string }).detail).toBe("Zavi could not save the move. None is approved yet: the cuts you picked are filed on the card.");
    expect(decide.calls).toHaveLength(0);
  });

  it("picks that do not free enough need the choice before anything is written; with it the move goes ahead", async () => {
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g2", 40)] });
    expect(r).toMatchObject({ ok: false, code: "budget_choice_required", budget_choice: { kind: "over", raise_to_usd: 27200 } });
    expect(db.rpcs).toHaveLength(0);
    const ok = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g2", 40)], raise_budget_to_usd: 27200 });
    expect(ok).toMatchObject({ ok: true, waiting: [AUTO] });
    expect(row(AUTO).body.move_after).toMatchObject({ budget_to_usd: 27200 });
  });

  it("must-catch: an unreadable month files nothing and says it can't check", async () => {
    counter.month = { unreadable: "google was last read 2026-10-20" };
    const r = await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [AUTO], new_cuts: [g("g1", 80)] });
    expect(r).toMatchObject({ ok: false, code: "budget_unreadable" });
    expect(String((r as { detail?: string }).detail)).toMatch(/can't check your ad budget/);
    expect(db.rpcs).toHaveLength(0);
  });

  it("a Retry or Finish never comes with new cuts", async () => {
    expect(await approveMove({ tenant_id: T, actor_user_id: OWNER, anchor_id: AUTO, ticked_ids: [], finish: true, new_cuts: [g("g1", 80)] })).toMatchObject({ ok: false, code: "invalid_new_cuts" });
    expect(db.rpcs).toHaveLength(0);
  });

  it("moveFit: the picks' counter savings lower the net and the projection, not the daily limit", async () => {
    expect(await moveFit(T, AUTO, [AUTO], [g("g1", 80), g("g2", 40)])).toEqual({ ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } });
    expect(await moveFit(T, AUTO, [AUTO], [g("g2", 40)])).toMatchObject({ ok: true, net_daily_usd: 20, budget_choice: { kind: "over", raise_to_usd: 27200 } });
    expect(await moveFit(T, AUTO, [AUTO], [g("g2", 41)])).toMatchObject({ ok: false, code: "candidates_changed" });
  });

  it("findMoneyView: the raise as a one-line move and the candidates; not an open raise is null", async () => {
    const v = await findMoneyView(T, AUTO);
    expect(v).toMatchObject({ kind: "candidates", why: null, budget_choice: { kind: "over" }, move: { key: `raise:${AUTO}`, still_filing: false, lines: [{ id: AUTO, side: "adds" }] } });
    expect(v!.candidates.map((x) => [x.object_id, x.to_usd, x.frees_daily_usd])).toEqual([["g1", 80, 20], ["g2", 40, 10], ["g3", 24, 6]]);
    row(AUTO).status = "approved";
    expect(await findMoneyView(T, AUTO)).toBeNull();
  });
});
