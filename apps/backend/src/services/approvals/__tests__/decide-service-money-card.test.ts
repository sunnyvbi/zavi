import { describe, it, expect, vi, beforeEach } from "vitest";
import { moneyCardFingerprint } from "../money-card";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null, role: "owner" as string | null },
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
      return Promise.resolve({ data: { changed: true, status: fn.startsWith("decide") ? (args.p_action === "reject" ? "rejected" : "approved") : "ok", ok: true }, error: null });
    },
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => state.role }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/analytics/action-events", () => ({ trackApprovalCardDecided: vi.fn() }));

import { decideOnDecision } from "../decide-service";

function sealed(cls: string, fields: Record<string, unknown>) {
  const b = { ...fields, governed_by: "chokepoint" };
  return { ...b, fingerprint: moneyCardFingerprint(cls, b) as string };
}
const CHARGE = sealed("stripe.create_payment", { amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7" });
const PAYOUT = sealed("stripe.remit_to_tenant", { client_reference: "order-7", held_fund_id: "hf-1", currency: "usd", gross_minor: 10_000, reserve_minor: 1_000, fee_minor: 500, net_minor: 8_500 });
function setRow(decision_class: string, body: Record<string, unknown>) {
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class, agent_run_id: null, body };
}
const flipped = () => rpcCalls.some((c) => c.fn.startsWith("decide_decision_as"));
const approve = (extra: Record<string, unknown> = {}) =>
  decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, ...extra });

beforeEach(() => { rpcCalls.length = 0; state.role = "owner"; });

describe("Zavi-money cards: approved on the web card, by the owner or an admin", () => {
  it("the owner approves a charge or payout with the card's seal", async () => {
    for (const [cls, body] of [["stripe.create_payment", CHARGE], ["stripe.remit_to_tenant", PAYOUT]] as const) {
      rpcCalls.length = 0;
      setRow(cls, body);
      expect((await approve({ expected_fingerprint: body.fingerprint })).ok).toBe(true);
      expect(flipped()).toBe(true);
    }
  });
  it("no seal echoed (Slack button, chat yes, bulk approve) is refused", async () => {
    setRow("stripe.create_payment", CHARGE);
    expect((await approve()).code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("an amount edited after the card was made is refused, even echoing the old seal", async () => {
    setRow("stripe.create_payment", { ...CHARGE, amount: 199_900 });
    expect((await approve({ expected_fingerprint: CHARGE.fingerprint })).code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("an admin approves with the seal; a member or viewer cannot", async () => {
    state.role = "admin";
    setRow("stripe.remit_to_tenant", PAYOUT);
    expect((await approve({ expected_fingerprint: PAYOUT.fingerprint })).ok).toBe(true);
    for (const role of ["member", "viewer"]) {
      rpcCalls.length = 0;
      state.role = role;
      setRow("stripe.remit_to_tenant", PAYOUT);
      expect((await approve({ expected_fingerprint: PAYOUT.fingerprint })).code).toBe("not_authorized");
      expect(flipped()).toBe(false);
    }
  });
  it("cgo and staff can never approve one", async () => {
    setRow("stripe.create_payment", CHARGE);
    expect((await approve({ expected_fingerprint: CHARGE.fingerprint, approver_source: "cgo" })).code).toBe("not_authorized");
    expect((await approve({ expected_fingerprint: CHARGE.fingerprint, staff_override: true })).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });
  it("reject is never gated", async () => {
    setRow("stripe.create_payment", CHARGE);
    state.role = "member";
    expect((await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "reject", actor: { user_id: "u" } })).ok).toBe(true);
  });
});
