import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null, editOk: true },
}));

vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceEnabled: async () => false }));
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
      if (fn === "edit_decision_body_if_proposed") return Promise.resolve({ data: { ok: state.editOk }, error: null });
      return Promise.resolve({ data: { changed: true, status: "approved" }, error: null });
    },
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => "owner" }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/analytics/action-events", () => ({ trackApprovalCardDecided: vi.fn() }));

const CONFIRM = { message: "This turns on “Host Areas”: +$60/day. The 2 pauses in this move are still open, so your daily spend goes up by $60 until you approve them.", daily_add: 60, currency: "USD", open_legs: 2, why: "cut_untapped" as const };
const mg = vi.hoisted(() => ({ verdict: null as unknown, confirm: vi.fn() }));
vi.mock("@/services/growth/move-group", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-group")>()),
  checkPairedLeg: vi.fn(async (_t: string, leg: { body: Record<string, unknown> }) => (leg.body?.move_group ? mg.verdict : { kind: "go" })),
  runAloneConfirm: mg.confirm,
}));

import { decideOnDecision } from "../decide-service";

const BODY = { object_id: "900", level: "adset", status: "ACTIVE", origin: "user_initiated_chat", founder_chat_order: true, move_group: "run-root" };
const flipped = () => rpcCalls.some((c) => c.fn === "decide_decision_as_actor" || c.fn === "decide_decision_as_staff");
const edits = () => rpcCalls.filter((c) => c.fn === "edit_decision_body_if_proposed");
const approve = (extra: Record<string, unknown> = {}) =>
  decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "owner-1" }, offer_run_alone: true, ...extra });

beforeEach(() => {
  rpcCalls.length = 0;
  state.editOk = true;
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "meta_ads.set_status_review", agent_run_id: "run-root", body: { ...BODY } };
  mg.verdict = { kind: "wait", why: "cut_untapped", legs: [] };
  mg.confirm.mockReset().mockResolvedValue(CONFIRM);
});

describe("a person's approve on a held raise", () => {
  it("must-catch: without the flag it returns the confirm (amount and open count), nothing is edited or flipped", async () => {
    const r = await approve();
    expect(r).toMatchObject({ ok: false, code: "paired_move_waits", status: "proposed", run_alone: CONFIRM });
    expect(mg.confirm).toHaveBeenCalledWith("t-1", expect.objectContaining({ id: "d-1" }), mg.verdict);
    expect(edits()).toHaveLength(0);
    expect(flipped()).toBe(false);
  });

  it("must-catch: with run_alone the leg leaves its move, then approves", async () => {
    const r = await approve({ run_alone: true });
    expect(r.ok).toBe(true);
    const e = edits();
    expect(e).toHaveLength(1);
    expect(e[0].args).toMatchObject({ p_decision_id: "d-1", p_tenant_id: "t-1", p_actor_user_id: "owner-1" });
    const body = e[0].args.p_body as Record<string, unknown>;
    expect(body.move_group).toBeUndefined();
    expect(body.run_alone).toMatchObject({ move_group_left: "run-root", by: "owner-1" });
    expect(body).toMatchObject({ object_id: "900", status: "ACTIVE", founder_chat_order: true });
    expect(rpcCalls.map((c) => c.fn)).toEqual(["edit_decision_body_if_proposed", "decide_decision_as_actor"]);
  });

  it("a caller that cannot show the confirm (Slack) gets the refusal with no confirm built", async () => {
    const r = await approve({ offer_run_alone: false });
    expect(r).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect(r.run_alone).toBeUndefined();
    expect(mg.confirm).not.toHaveBeenCalled();
  });

  it("a body edit that does not land approves nothing", async () => {
    state.editOk = false;
    const r = await approve({ run_alone: true });
    expect(r.ok).toBe(false);
    expect(flipped()).toBe(false);
  });

  it("must-not-touch: run_alone on a leg that is free to go edits nothing", async () => {
    mg.verdict = { kind: "go" };
    expect((await approve({ run_alone: true })).ok).toBe(true);
    expect(edits()).toHaveLength(0);
  });
});

describe("only a person may run a leg alone", () => {
  it("a staff approve with run_alone is refused as before, no confirm, no edit", async () => {
    const r = await approve({ run_alone: true, staff_override: true });
    expect(r).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect(r.run_alone).toBeUndefined();
    expect(edits()).toHaveLength(0);
    expect(flipped()).toBe(false);
  });

  it("Autopilot with run_alone never flips a founder's leg", async () => {
    const r = await approve({ run_alone: true, approver_source: "cgo" });
    expect(r.ok).toBe(false);
    expect(edits()).toHaveLength(0);
    expect(rpcCalls.some((c) => c.fn === "decide_decision_as_cgo")).toBe(false);
  });
});
