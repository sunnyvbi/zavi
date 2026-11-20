import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn() }));

import { dispatchCustomAgentDecision, type CustomDecisionDispatchDeps } from "../custom-agent-decisions";

const args = { tenant_id: "t1", run_id: "r1", slug: "c-abcdefghij", decision_id: "d1", decision_class: "meta_ads.budget_change", body: { amount: 25 } };
const facts = { tenant_id: "t1", run_id: "r1", agent_id: "a1", slug: "c-abcdefghij" };

function deps(over: Partial<CustomDecisionDispatchDeps> = {}) {
  const d: CustomDecisionDispatchDeps = {
    resolve: vi.fn(async () => ({ state: "admitted" as const, ...facts })),
    handToHuman: vi.fn(async () => {}),
    insertReceipt: vi.fn(async () => "rcpt-1"),
    settleReceipt: vi.fn(async () => {}),
    dispatch: vi.fn(async () => ({ dispatched: true, reason: "dispatched" })),
    ...over,
  };
  return d;
}

describe("dispatchCustomAgentDecision", () => {
  it("a built-in agent: nothing (no read, no receipt, no dispatch)", async () => {
    const d = deps();
    expect(await dispatchCustomAgentDecision({ ...args, slug: "operator" }, d)).toBe("not_custom");
    expect(d.resolve).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it("a c- slug whose run is not admitted (paused, unverified, check failed): nothing fires, a human gets it", async () => {
    for (const state of ["blocked", "unverified", "error"] as const) {
      const d = deps({ resolve: vi.fn(async () => ({ state }) as never) });
      expect(await dispatchCustomAgentDecision(args, d)).toBe("not_dispatched");
      expect(d.insertReceipt).not.toHaveBeenCalled();
      expect(d.dispatch).not.toHaveBeenCalled();
      expect(d.handToHuman).toHaveBeenCalledWith("t1", "d1", "r1");
    }
  });

  it("G4: a founder-ordered body is never fired in-session; it is handed to a human before any read or receipt", async () => {
    for (const origin of ["user_initiated_chat", "user_initiated_ledger"]) {
      const d = deps();
      expect(await dispatchCustomAgentDecision({ ...args, body: { amount: 25, origin, founder_chat_order: true } }, d)).toBe("not_dispatched");
      expect(d.dispatch).not.toHaveBeenCalled();
      expect(d.insertReceipt).not.toHaveBeenCalled();
      expect(d.handToHuman).toHaveBeenCalledWith("t1", "d1", "r1");
    }
  });

  it("a pause past the cut guard is never fired by a custom agent: a person approves it", async () => {
    for (const a of [
      { ...args, decision_class: "meta_ads.pause_past_cut_guard", body: { status: "PAUSED" } },
      { ...args, body: { status: "PAUSED", origin: "cut_guard_override" } },
    ]) {
      const d = deps();
      expect(await dispatchCustomAgentDecision(a, d)).toBe("not_dispatched");
      expect(d.dispatch).not.toHaveBeenCalled();
      expect(d.handToHuman).toHaveBeenCalledWith("t1", "d1", "r1");
    }
  });

  it("the origin alone (a member's chat, a verified email reply) keeps today's in-session dispatch", async () => {
    const d = deps();
    expect(await dispatchCustomAgentDecision({ ...args, body: { amount: 25, origin: "user_initiated_chat" } }, d)).toBe("dispatched");
    expect(d.handToHuman).not.toHaveBeenCalled();
  });

  it("a connected-app write (composio.*) is never fired by a custom agent: a person approves it", async () => {
    for (const decision_class of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
      const d = deps();
      expect(await dispatchCustomAgentDecision({ ...args, decision_class, body: { kind: "composio_write", toolkit: "shopify" } }, d)).toBe("not_dispatched");
      expect(d.dispatch).not.toHaveBeenCalled();
      expect(d.insertReceipt).not.toHaveBeenCalled();
      expect(d.handToHuman).toHaveBeenCalledWith("t1", "d1", "r1");
    }
  });

  it("dispatched: never handed to a human", async () => {
    const d = deps();
    await dispatchCustomAgentDecision(args, d);
    expect(d.handToHuman).not.toHaveBeenCalled();
  });

  it("admitted: receipt attempted, then the dispatch as a custom agent, then succeeded", async () => {
    const d = deps();
    expect(await dispatchCustomAgentDecision(args, d)).toBe("dispatched");
    expect(d.insertReceipt).toHaveBeenCalledWith(facts, "decision:meta_ads.budget_change", "meta_ads.budget_change", "attempted");
    expect(d.dispatch).toHaveBeenCalledWith(expect.objectContaining({ decision_id: "d1", agent_run_id: "r1", customAgent: true }));
    expect(d.settleReceipt).toHaveBeenCalledWith({ tenant_id: "t1", id: "rcpt-1" }, "succeeded", null);
  });

  it("a guard refused (spend cap): the receipt says failed with the reason code", async () => {
    const d = deps({ dispatch: vi.fn(async () => ({ dispatched: false, reason: "class_spend_cap_over" })) });
    expect(await dispatchCustomAgentDecision(args, d)).toBe("not_dispatched");
    expect(d.settleReceipt).toHaveBeenCalledWith({ tenant_id: "t1", id: "rcpt-1" }, "failed", "class_spend_cap_over");
    expect(d.handToHuman).toHaveBeenCalledWith("t1", "d1", "r1");
  });

  it("a timeout (dispatch still running) is not flipped under its claim", async () => {
    const d = deps({ dispatch: vi.fn(async () => ({ dispatched: false, reason: "dispatch_timeout" })) });
    await dispatchCustomAgentDecision(args, d);
    expect(d.handToHuman).not.toHaveBeenCalled();
  });

  it("no receipt, no dispatch", async () => {
    const d = deps({ insertReceipt: vi.fn(async () => null) });
    expect(await dispatchCustomAgentDecision(args, d)).toBe("receipt_failed");
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.handToHuman).toHaveBeenCalledWith("t1", "d1", "r1");
  });

  it("a throwing dispatch is a failed receipt, never an exception", async () => {
    const d = deps({ dispatch: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await dispatchCustomAgentDecision(args, d)).toBe("not_dispatched");
    expect(d.settleReceipt).toHaveBeenCalledWith({ tenant_id: "t1", id: "rcpt-1" }, "failed", "dispatch_threw");
  });
});
