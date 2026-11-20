
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "support-lead.reply", agent_run_id: null, body: {} } as Record<string, unknown> | null },
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
      return Promise.resolve({ data: { changed: true, status: "approved" }, error: null });
    },
  }),
}));

vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn() }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));

import { decideOnDecision } from "../decide-service";

beforeEach(() => {
  rpcCalls.length = 0;
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: "support-lead.reply", agent_run_id: null, body: {} };
});

describe("decideOnDecision staff routing", () => {
  it("staff_override:true routes to decide_decision_as_staff", async () => {
    await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-staff" }, staff_override: true });
    expect(rpcCalls.map((c) => c.fn)).toContain("decide_decision_as_staff");
    expect(rpcCalls.map((c) => c.fn)).not.toContain("decide_decision_as_actor");
  });

  it("customer path (no staff_override) routes to decide_decision_as_actor", async () => {
    await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-cust" } });
    expect(rpcCalls.map((c) => c.fn)).toContain("decide_decision_as_actor");
    expect(rpcCalls.map((c) => c.fn)).not.toContain("decide_decision_as_staff");
  });

  it("approver_source 'cgo' routes to decide_decision_as_cgo, with the owner as actor", async () => {
    await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-owner" }, approver_source: "cgo" });
    const fns = rpcCalls.map((c) => c.fn);
    expect(fns).toContain("decide_decision_as_cgo");
    expect(fns).not.toContain("decide_decision_as_actor");
    expect(fns).not.toContain("decide_decision_as_staff");
    expect(rpcCalls.find((c) => c.fn === "decide_decision_as_cgo")?.args).toMatchObject({
      p_decision_id: "d-1",
      p_tenant_id: "t-1",
      p_actor_user_id: "u-owner",
      p_action: "approve",
    });
  });

  it("staff_override together with approver_source 'cgo' is refused before any flip", async () => {
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u-staff" }, staff_override: true, approver_source: "cgo" });
    expect(r).toMatchObject({ ok: false, code: "not_authorized", changed: false });
    expect(rpcCalls).toHaveLength(0);
  });
});
