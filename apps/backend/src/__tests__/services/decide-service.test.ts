import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const ACTOR = "10000000-0000-0000-0000-000000000001";
const DECISION = "20000000-0000-0000-0000-000000000099";

const m = vi.hoisted(() => {
  const state: {
    decisionRow: Record<string, unknown> | null;
    rpcResult: { data: unknown; error: unknown };
    allowlistResult: { data: unknown; error: unknown };
    role: string | null;
    roleThrows: boolean;
  } = {
    decisionRow: null,
    rpcResult: { data: { changed: true, status: "approved" }, error: null },
    allowlistResult: { data: { ok: true }, error: null },
    role: "owner",
    roleThrows: false,
  };

  const maybeSingle = vi.fn(async () => ({ data: state.decisionRow, error: null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) =>
    name === "allowlist_class_for_tenant" ? state.allowlistResult : state.rpcResult,
  );
  const serviceClient = vi.fn(() => ({ from, rpc }));

  const inngestSend = vi.fn(async (_e: unknown) => ({ ids: ["evt"] }));
  const logDecisionNotTaken = vi.fn(async (_a: unknown) => true);
  const stampOutcome = vi.fn(async (_id: string, _t: string) => undefined);
  const bindActionOutcome = vi.fn(async (_a: unknown) => undefined);
  const loadTenantRoleFor = vi.fn(async (_u: string, _t: string) => {
    if (state.roleThrows) throw new Error("role read failed");
    return state.role;
  });

  return { state, maybeSingle, eq, select, from, rpc, serviceClient, inngestSend, logDecisionNotTaken, stampOutcome, bindActionOutcome, loadTenantRoleFor };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: m.loadTenantRoleFor }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.inngestSend } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: m.logDecisionNotTaken }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: m.stampOutcome }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: m.bindActionOutcome }));

import { decideOnDecision } from "../../services/approvals/decide-service";

beforeEach(() => {
  m.state.decisionRow = {
    tenant_id: TENANT,
    status: "proposed",
    decision_class: "engineer.ship-pr",
    agent_run_id: "30000000-0000-0000-0000-000000000077",
  };
  m.state.rpcResult = { data: { changed: true, status: "approved" }, error: null };
  m.state.allowlistResult = { data: { ok: true }, error: null };
  m.state.role = "owner";
  m.state.roleThrows = false;
  m.maybeSingle.mockClear();
  m.rpc.mockClear();
  m.inngestSend.mockClear();
  m.logDecisionNotTaken.mockClear();
  m.stampOutcome.mockClear();
  m.bindActionOutcome.mockClear();
  m.loadTenantRoleFor.mockClear();
});

function decideFlipCalls() {
  return m.rpc.mock.calls.filter(
    (c) => c[0] === "decide_decision_as_actor" || c[0] === "decide_decision_as_staff",
  );
}

function allowlistRpcCalls() {
  return m.rpc.mock.calls.filter((c) => c[0] === "allowlist_class_for_tenant");
}

describe("decideOnDecision — approve", () => {
  it("real flip → calls explicit-actor RPC + fires decision.approved", async () => {
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: true, code: "ok", changed: true, status: "approved" });
    expect(m.rpc).toHaveBeenCalledWith("decide_decision_as_actor", {
      p_decision_id: DECISION,
      p_tenant_id: TENANT,
      p_actor_user_id: ACTOR,
      p_action: "approve",
    });
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
    expect(m.inngestSend.mock.calls[0][0]).toMatchObject({ name: "decision.approved", data: { decision_id: DECISION, tenant_id: TENANT } });
    expect(m.logDecisionNotTaken).not.toHaveBeenCalled();
  });

  it("idempotent no-op (already approved) → no Inngest fan-out", async () => {
    m.state.rpcResult = { data: { changed: false, status: "approved" }, error: null };
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: true, changed: false, status: "approved" });
    expect(m.inngestSend).not.toHaveBeenCalled();
  });
});

describe("decideOnDecision — reject", () => {
  it("real flip → counterfactual + outcome stamp, NO Inngest approve", async () => {
    m.state.rpcResult = { data: { changed: true, status: "rejected" }, error: null };
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "reject", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: true, changed: true, status: "rejected" });
    expect(m.logDecisionNotTaken).toHaveBeenCalledTimes(1);
    expect(m.logDecisionNotTaken.mock.calls[0][0]).toMatchObject({
      tenant_id: TENANT,
      rejection_type: "founder_override",
      decision_class: "engineer.ship-pr",
      reason_code: "operator_reject",
    });
    expect(m.stampOutcome).toHaveBeenCalledWith(DECISION, TENANT);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("reject flip → writes the suppression ledger (so it is never re-proposed)", async () => {
    m.state.rpcResult = { data: { changed: true, status: "rejected" }, error: null };
    await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "reject", actor: { user_id: ACTOR } });
    const supp = m.rpc.mock.calls.filter((c) => c[0] === "suppress_decision");
    expect(supp).toHaveLength(1);
    expect(supp[0][1]).toMatchObject({ p_decision_id: DECISION, p_source: "reject" });
  });

  it("APPROVE never suppresses (approving is not a 'no')", async () => {
    m.state.rpcResult = { data: { changed: true, status: "approved" }, error: null };
    await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(m.rpc.mock.calls.filter((c) => c[0] === "suppress_decision")).toHaveLength(0);
  });

  it("idempotent replay (changed:false) does NOT re-write the ledger", async () => {
    m.state.decisionRow = { ...m.state.decisionRow!, status: "rejected" };
    m.state.rpcResult = { data: { changed: false, status: "rejected" }, error: null };
    await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "reject", actor: { user_id: ACTOR } });
    expect(m.rpc.mock.calls.filter((c) => c[0] === "suppress_decision")).toHaveLength(0);
  });

  it("suppression RPC ERRORS → reject still succeeds (FAIL-SAFE)", async () => {
    m.state.rpcResult = { data: { changed: true, status: "rejected" }, error: null };
    const original = m.rpc.getMockImplementation();
    m.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "suppress_decision") return { data: null, error: { message: "boom" } };
      return original ? original(name, args) : m.state.rpcResult;
    });
    try {
      const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "reject", actor: { user_id: ACTOR } });
      expect(r).toMatchObject({ ok: true, changed: true, status: "rejected" });
    } finally {
      if (original) m.rpc.mockImplementation(original);
    }
  });
});

describe("decideOnDecision — hard gates", () => {
  it("decision belongs to another tenant → cross_tenant, no RPC, no side effects", async () => {
    m.state.decisionRow = { tenant_id: OTHER_TENANT, status: "proposed", decision_class: "x", agent_run_id: null };
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: false, code: "cross_tenant", changed: false });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("missing decision → not_found, no RPC", async () => {
    m.state.decisionRow = null;
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: false, code: "not_found", changed: false });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("RPC raises not_member → mapped to not_member, no side effects", async () => {
    m.state.rpcResult = { data: null, error: { message: "not_member: actor is not a member of tenant X" } };
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: false, code: "not_member", changed: false });
    expect(m.inngestSend).not.toHaveBeenCalled();
  });
});

describe("decideOnDecision — always_allow (approve & always allow this kind)", () => {
  it("always_allow=true on an eligible approve flip → calls allowlist RPC + returns allowlisted:true", async () => {
    m.state.decisionRow = {
      tenant_id: TENANT,
      status: "proposed",
      decision_class: "send_email",
      agent_run_id: null,
    };
    m.state.allowlistResult = { data: { ok: true }, error: null };
    const r = await decideOnDecision({
      decision_id: DECISION,
      tenant_id: TENANT,
      action: "approve",
      actor: { user_id: ACTOR },
      always_allow: true,
    });
    expect(r).toMatchObject({ ok: true, changed: true, allowlisted: true });
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
    const al = allowlistRpcCalls();
    expect(al.length).toBe(1);
    expect(al[0][1]).toEqual({
      p_tenant_id: TENANT,
      p_decision_class: "send_email",
      p_actor_user_id: ACTOR,
    });
  });

  it("allowlist RPC returns {ok:false} (not owner / not eligible) → allowlisted:false, approve still changed", async () => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "send_email", agent_run_id: null };
    m.state.allowlistResult = { data: { ok: false, reason: "not_owner" }, error: null };
    const r = await decideOnDecision({
      decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR }, always_allow: true,
    });
    expect(r).toMatchObject({ ok: true, changed: true, allowlisted: false });
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("allowlist RPC ERRORS → allowlisted:false, approve flip + fan-out still succeed (FAIL-SAFE)", async () => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "send_email", agent_run_id: null };
    m.state.allowlistResult = { data: null, error: { message: "boom" } };
    const r = await decideOnDecision({
      decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR }, always_allow: true,
    });
    expect(r).toMatchObject({ ok: true, changed: true, allowlisted: false });
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("always_allow=false → allowlist RPC NOT called, allowlisted:false", async () => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "send_email", agent_run_id: null };
    const r = await decideOnDecision({
      decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR }, always_allow: false,
    });
    expect(r).toMatchObject({ ok: true, changed: true, allowlisted: false });
    expect(allowlistRpcCalls().length).toBe(0);
  });

  it("always_allow omitted → allowlist RPC NOT called", async () => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "send_email", agent_run_id: null };
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r.allowlisted).toBe(false);
    expect(allowlistRpcCalls().length).toBe(0);
  });

  it("always_allow=true but idempotent no-op (already approved) → allowlist NOT called", async () => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "send_email", agent_run_id: null };
    m.state.rpcResult = { data: { changed: false, status: "approved" }, error: null };
    const r = await decideOnDecision({
      decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR }, always_allow: true,
    });
    expect(r).toMatchObject({ ok: true, changed: false, allowlisted: false });
    expect(allowlistRpcCalls().length).toBe(0);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });
});

describe("decideOnDecision — Gap 3 / S8a owner-only browser.action approval", () => {
  const asBrowserAction = () => {
    m.state.decisionRow = {
      tenant_id: TENANT,
      status: "proposed",
      decision_class: "browser.action",
      agent_run_id: "30000000-0000-0000-0000-000000000077",
    };
  };

  it("owner approving a browser.action → flips (role check passes)", async () => {
    asBrowserAction();
    m.state.role = "owner";
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: true, code: "ok", changed: true });
    expect(decideFlipCalls().length).toBe(1);
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("admin approving a browser.action → flips", async () => {
    asBrowserAction();
    m.state.role = "admin";
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r.ok).toBe(true);
    expect(decideFlipCalls().length).toBe(1);
  });

  it("plain member approving a browser.action → not_authorized, NO flip, NO fan-out", async () => {
    asBrowserAction();
    m.state.role = "member";
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: false, code: "not_authorized", changed: false });
    expect(decideFlipCalls().length).toBe(0);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("role read throwing → not_authorized (fail-closed), NO flip", async () => {
    asBrowserAction();
    m.state.roleThrows = true;
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r.code).toBe("not_authorized");
    expect(decideFlipCalls().length).toBe(0);
  });

  it("member REJECTING a browser.action → allowed (reject is never role-gated)", async () => {
    asBrowserAction();
    m.state.role = "member";
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "reject", actor: { user_id: ACTOR } });
    expect(r.ok).toBe(true);
    expect(decideFlipCalls().length).toBe(1);
  });

  it("staff_override approving a browser.action as non-owner → allowed (gate skipped)", async () => {
    asBrowserAction();
    m.state.role = "member";
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR }, staff_override: true });
    expect(r.ok).toBe(true);
    expect(m.loadTenantRoleFor).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledWith("decide_decision_as_staff", expect.any(Object));
  });

  it("a NON-browser.action class approval by a member is NOT role-gated (unchanged)", async () => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "engineer.ship-pr", agent_run_id: "x" };
    m.state.role = "member";
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r.ok).toBe(true);
  });
});

describe("decideOnDecision — role ladder: a viewer decides nothing", () => {
  beforeEach(() => {
    m.state.decisionRow = { tenant_id: TENANT, status: "proposed", decision_class: "engineer.ship-pr", agent_run_id: "x" };
    m.state.role = "viewer";
  });

  it.each(["approve", "reject"] as const)("viewer %s → not_authorized, NO flip, NO fan-out", async (action) => {
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action, actor: { user_id: ACTOR } });
    expect(r).toMatchObject({ ok: false, code: "not_authorized", changed: false });
    expect(decideFlipCalls().length).toBe(0);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("role read throwing → not_authorized for ANY class (fail-closed)", async () => {
    m.state.roleThrows = true;
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR } });
    expect(r.code).toBe("not_authorized");
    expect(decideFlipCalls().length).toBe(0);
  });

  it("staff_override is not a viewer path (gate skipped)", async () => {
    const r = await decideOnDecision({ decision_id: DECISION, tenant_id: TENANT, action: "approve", actor: { user_id: ACTOR }, staff_override: true });
    expect(r.ok).toBe(true);
    expect(m.loadTenantRoleFor).not.toHaveBeenCalled();
  });
});
