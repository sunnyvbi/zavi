import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state, rpcAnswer } = vi.hoisted(() => ({
  rpcAnswer: { changed: true, status: "approved" } as { changed: boolean; status: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: state.row, error: null });
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: { ...rpcAnswer }, error: null });
    },
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => "owner" }));
const send = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/../workers/client", () => ({ inngest: { send } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/analytics/action-events", () => ({ trackApprovalCardDecided: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => flag.on }));
const bc = vi.hoisted(() => ({ result: { kind: "approved", changed: true } as unknown, calls: [] as unknown[] }));
vi.mock("../budget-choice", async (orig) => ({
  ...(await orig<typeof import("../budget-choice")>()),
  approveRaiseWithBudget: vi.fn(async (a: unknown) => {
    bc.calls.push(a);
    return bc.result;
  }),
}));
const mg = vi.hoisted(() => ({ verdict: { kind: "go" } as unknown, calls: 0 }));
vi.mock("@/services/growth/move-group", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-group")>()),
  checkPairedLeg: vi.fn(async () => {
    mg.calls += 1;
    return mg.verdict;
  }),
  runAloneConfirm: vi.fn(async () => ({ message: "m", daily_add: 30, currency: "USD", open_legs: 1, why: "cut_untapped" })),
}));
const mc = vi.hoisted(() => ({ verdict: "go" as unknown }));
vi.mock("@/services/growth/move-card", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-card")>()),
  checkMoveAfter: vi.fn(async () => mc.verdict),
}));
const counter = vi.hoisted(() => ({ fit: { kind: "fits" } as unknown }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readRaiseFit: vi.fn(async () => counter.fit) }));

import { decideOnDecision } from "../decide-service";

const CUT = "11111111-1111-4111-8111-111111111111";
const RAISE = { campaign_id: "c1", daily_budget_usd: 70, expected_current_daily_budget_usd: 40, origin: "user_initiated_chat" };
const PAIRED = { ...RAISE, founder_chat_order: true, move_group: "run-root" };
const STAMPED = { ...PAIRED, move_after: { cut_ids: [CUT], by: "owner-1", at: "2026-10-23T10:00:00Z", budget_to_usd: null, daily_limit_to_usd: null } };
const row = (body: Record<string, unknown>, cls = "google_ads.update_campaign_budget_review") => ({ id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: cls, agent_run_id: "run-root", body });
const flipped = () => rpcCalls.some((c) => c.fn === "decide_decision_as_actor" || c.fn === "decide_decision_as_staff");
const approve = (extra: Record<string, unknown> = {}) => decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "owner-1" }, surface: "web", ...extra });

beforeEach(() => {
  rpcCalls.length = 0;
  bc.calls.length = 0;
  bc.result = { kind: "approved", changed: true };
  send.mockClear();
  rpcAnswer.changed = true;
  rpcAnswer.status = "approved";
  flag.on = true;
  mg.verdict = { kind: "go" };
  mg.calls = 0;
  mc.verdict = "go";
  counter.fit = { kind: "fits" };
  state.row = row({ ...RAISE });
});

describe("flag ON", () => {
  it("must-catch e1da4894: a lone founder raise goes through the atomic RPC, is not flipped again, fires decision.approved once, no pairing check", async () => {
    const r = await approve();
    expect(r).toMatchObject({ ok: true, changed: true, status: "approved" });
    expect(bc.calls).toHaveLength(1);
    expect(bc.calls[0]).toMatchObject({ surface: "web", decision_id: "d-1", actor_user_id: "owner-1" });
    expect(flipped()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ name: "decision.approved" });
    expect(mg.calls).toBe(1);
  });

  it("the person's chosen limits reach the RPC; a non-web door is sent as other", async () => {
    await approve({ raise_budget_to_usd: 27100, raise_daily_limit_to_usd: 1020 });
    expect(bc.calls[0]).toMatchObject({ ask: { raise_budget_to_usd: 27100, raise_daily_limit_to_usd: 1020 } });
    await approve({ surface: undefined });
    expect(bc.calls[1]).toMatchObject({ surface: "other" });
  });

  it("a refusal returns its code and the choice, with no flip and no event", async () => {
    const view = { kind: "over", month_label: "October", projection_usd: 27040, monthly_usd: 27000, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
    bc.result = { kind: "refused", code: "budget_choice_required", detail: "October is projected...", view };
    const r = await approve();
    expect(r).toMatchObject({ ok: false, code: "budget_choice_required", budget_choice: view, detail: "October is projected..." });
    expect(flipped()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed decision.approved send after the flip is retried with the same event id (nothing else dispatches an approved row)", async () => {
    bc.result = { kind: "passthrough" };
    send.mockRejectedValueOnce(new Error("inngest 502"));
    expect(await approve()).toMatchObject({ ok: true, changed: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].id).toBe(send.mock.calls[1][0].id);
  });

  it("a replayed approve on a row still approved (its first event lost) sends decision.approved again; one already dispatching does not", async () => {
    bc.result = { kind: "passthrough" };
    rpcAnswer.changed = false;
    expect(await approve()).toMatchObject({ changed: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ id: "approve:d-1", name: "decision.approved" });
    send.mockClear();
    rpcAnswer.status = "dispatching";
    await approve();
    expect(send).not.toHaveBeenCalled();
  });

  it("passthrough flips through decide_decision_as_actor as before", async () => {
    bc.result = { kind: "passthrough" };
    expect(await approve()).toMatchObject({ ok: true, changed: true });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_actor"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("must-catch: a stamped raise whose cuts did not hold is move_waits_on_cuts, and the RPC is never called", async () => {
    state.row = row({ ...STAMPED });
    mc.verdict = { stop: [CUT] };
    const r = await approve();
    expect(r).toMatchObject({ ok: false, code: "move_waits_on_cuts" });
    expect(bc.calls).toHaveLength(0);
    expect(flipped()).toBe(false);
    mc.verdict = "wait";
    expect(await approve()).toMatchObject({ ok: false, code: "move_waits_on_cuts", detail: "The cuts in this move are still being applied. The raise runs after them." });
  });

  it("a stamped raise skips the paired hold and goes through the RPC once its cuts hold", async () => {
    state.row = row({ ...STAMPED });
    mg.verdict = { kind: "wait", why: "cut_untapped", legs: [] };
    expect(await approve()).toMatchObject({ ok: true });
    expect(mg.calls).toBe(0);
    expect(bc.calls).toHaveLength(1);
  });

  it("must-catch R3: a paired raise WITHOUT move_after (legacy card, Slack tap) keeps today's paired_move_waits; no RPC", async () => {
    state.row = row({ ...PAIRED });
    mg.verdict = { kind: "wait", why: "cut_untapped", legs: [] };
    const r = await approve({ surface: undefined });
    expect(r).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect(mg.calls).toBe(1);
    expect(bc.calls).toHaveLength(0);
  });

  it("must-catch: a stamped raise approved by staff or Autopilot never takes the stamped path: the paired hold runs", async () => {
    state.row = row({ ...STAMPED });
    mg.verdict = { kind: "wait", why: "cut_untapped", legs: [] };
    expect(await approve({ staff_override: true })).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect(mg.calls).toBe(1);
    expect(await approve({ approver_source: "cgo", surface: undefined })).toMatchObject({ ok: false });
    expect(bc.calls).toHaveLength(0);
  });

  it("staff: over budget is budget_choice_in_zavi and not flipped; fits flips as staff", async () => {
    counter.fit = { kind: "over", count: { month_start: "2026-10-01", monthly_usd: 27000 }, with_usd: 27040, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };
    expect(await approve({ staff_override: true })).toMatchObject({ ok: false, code: "budget_choice_in_zavi" });
    expect(flipped()).toBe(false);
    counter.fit = { kind: "fits" };
    expect(await approve({ staff_override: true })).toMatchObject({ ok: true });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_staff"]);
    expect(bc.calls).toHaveLength(0);
  });

  it("a cut is never sent through the budget RPC", async () => {
    state.row = row({ campaign_id: "c2", daily_budget_usd: 10, expected_current_daily_budget_usd: 40 });
    expect(await approve()).toMatchObject({ ok: true });
    expect(bc.calls).toHaveLength(0);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_actor"]);
  });

  it("Autopilot (approver_source cgo) keeps its own path", async () => {
    state.row = row({ ...RAISE, origin: "cgo" });
    expect(await approve({ approver_source: "cgo", surface: undefined })).toMatchObject({ ok: true });
    expect(bc.calls).toHaveLength(0);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_cgo"]);
  });
});

describe("flag OFF", () => {
  it("checkPairedLeg runs as today, there is no RPC, and a stamp changes nothing", async () => {
    flag.on = false;
    state.row = row({ ...STAMPED });
    mg.verdict = { kind: "wait", why: "cut_untapped", legs: [] };
    expect(await approve()).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect(mg.calls).toBe(1);
    expect(bc.calls).toHaveLength(0);
    mg.verdict = { kind: "go" };
    expect(await approve()).toMatchObject({ ok: true });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["decide_decision_as_actor"]);
  });
});
