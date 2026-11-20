import { describe, it, expect, vi, beforeEach } from "vitest";
import { moneyCardFingerprint } from "../money-card";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null, role: "member" as string | null },
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

const CLS = "extension.money_step";
function card(over: Record<string, unknown> = {}) {
  const b: Record<string, unknown> = {
    host: "adsmanager.facebook.com",
    label: "Publish",
    op: "click_ref",
    op_args: '{"op":"click_ref","ref":{"backend_node_id":7,"frame_session":null}}',
    value: null,
    frame_url: "https://adsmanager.facebook.com/adsmanager",
    frame_session: null,
    backend_node_id: 7,
    screenshot_id: "sha256:abc",
    run_owner_user_id: "member-1",
    held_op_id: "op-1",
    ...over,
  };
  return { ...b, fingerprint: moneyCardFingerprint(CLS, b) as string };
}
function setRow(body: Record<string, unknown>) {
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class: CLS, agent_run_id: "run-1", body };
}
const flipped = () => rpcCalls.some((c) => c.fn.startsWith("decide_decision_as"));
const approve = (user: string, extra: Record<string, unknown> = {}) =>
  decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: user }, ...extra });

beforeEach(() => {
  rpcCalls.length = 0;
  state.role = "member";
});

describe("extension.money_step: only the run's own user confirms", () => {
  it("the member who runs the task approves with the right fingerprint", async () => {
    const b = card();
    setRow(b);
    const r = await approve("member-1", { expected_fingerprint: b.fingerprint });
    expect(r.ok).toBe(true);
    expect(flipped()).toBe(true);
  });

  it("the OWNER approving another member's card is not_authorized", async () => {
    state.role = "owner";
    const b = card();
    setRow(b);
    expect((await approve("owner-9", { expected_fingerprint: b.fingerprint })).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });

  it("an admin, or another member, cannot approve it either", async () => {
    for (const [user, role] of [["admin-2", "admin"], ["member-3", "member"]] as const) {
      rpcCalls.length = 0;
      state.role = role;
      const b = card();
      setRow(b);
      expect((await approve(user, { expected_fingerprint: b.fingerprint })).code).toBe("not_authorized");
      expect(flipped()).toBe(false);
    }
  });

  it("the run's owner being the tenant owner still works (role does not matter, identity does)", async () => {
    state.role = "owner";
    const b = card({ run_owner_user_id: "owner-9" });
    setRow(b);
    expect((await approve("owner-9", { expected_fingerprint: b.fingerprint })).ok).toBe(true);
  });

  it("a wrong fingerprint is stale_card", async () => {
    const b = card();
    setRow(b);
    expect((await approve("member-1", { expected_fingerprint: "0".repeat(64) })).code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });

  it("a body edited after the card was made (value changed) is stale_card, even echoing the old seal", async () => {
    const b = card();
    setRow({ ...b, value: "$5,000.00" });
    expect((await approve("member-1", { expected_fingerprint: b.fingerprint })).code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });

  it("a swapped run owner breaks the seal (cannot re-point the card to someone else)", async () => {
    const b = card();
    setRow({ ...b, run_owner_user_id: "owner-9" });
    state.role = "owner";
    expect((await approve("owner-9", { expected_fingerprint: b.fingerprint })).code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });

  it("Slack / chat / bulk approve (no fingerprint echoed) is refused", async () => {
    setRow(card());
    expect((await approve("member-1")).code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });

  it("staff and cgo can never approve one", async () => {
    const b = card();
    setRow(b);
    expect((await approve("member-1", { expected_fingerprint: b.fingerprint, staff_override: true })).code).toBe("not_authorized");
    expect((await approve("member-1", { expected_fingerprint: b.fingerprint, approver_source: "cgo" })).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });

  it("a card with no run owner sealed cannot be approved by anyone", async () => {
    const b = card({ run_owner_user_id: null });
    setRow(b);
    state.role = "owner";
    expect((await approve("owner-9", { expected_fingerprint: b.fingerprint })).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });

  it("reject is never gated (anyone in the tenant can say no)", async () => {
    setRow(card());
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "reject", actor: { user_id: "member-3" } });
    expect(r.ok).toBe(true);
  });
});
