import { describe, it, expect, vi, beforeEach } from "vitest";
import { composioWriteFingerprint } from "@/services/connectors/composio/fingerprint";

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

import { decideOnDecision, OWNER_ONLY_APPROVE_CLASSES } from "../decide-service";

function sealed(decision_class: string, labels: string[]) {
  const b = {
    kind: "composio_write", server_id: "composio", tool_slug: "SQUARE_CREATE_REFUND", toolkit: "square",
    app_name: "Square", action: "Create refund", arguments: { charge: "ch_1", amount: 500 },
    classification: { destructive: false }, labels, governed_by: "chokepoint",
    connected_account_id: "ca_1", auth_config_id: "ac_1",
  };
  return { ...b, fingerprint: composioWriteFingerprint({ ...b, decision_class }) };
}
function setRow(decision_class: string, body: Record<string, unknown>) {
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class, agent_run_id: null, body };
}
const flipped = () => rpcCalls.some((c) => c.fn === "decide_decision_as_actor" || c.fn === "decide_decision_as_staff");
const edited = () => rpcCalls.some((c) => c.fn.startsWith("edit_decision_body"));

beforeEach(() => { rpcCalls.length = 0; state.role = "owner"; });

describe("OWNER_ONLY_APPROVE_CLASSES", () => {
  it("has composio money + delete classes, not the plain write class", () => {
    expect(OWNER_ONLY_APPROVE_CLASSES.has("composio.moves_money")).toBe(true);
    expect(OWNER_ONLY_APPROVE_CLASSES.has("composio.deletes_data")).toBe(true);
    expect(OWNER_ONLY_APPROVE_CLASSES.has("composio.write")).toBe(false);
  });
});

describe("decideOnDecision on composio.* rows", () => {
  it("web: a member cannot approve a composio.moves_money row, even with the right fingerprint", async () => {
    const body = sealed("composio.moves_money", ["moves_money"]);
    setRow("composio.moves_money", body); state.role = "member";
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(r.code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });
  it("web: an admin approves money and deletion with the card fingerprint", async () => {
    for (const [cls, labels] of [["composio.moves_money", ["moves_money"]], ["composio.deletes_data", ["deletes_data"]]] as const) {
      const body = sealed(cls, [...labels]);
      setRow(cls, body); state.role = "admin";
      const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
      expect(r.ok).toBe(true);
    }
    expect(flipped()).toBe(true);
  });
  it.each(["member", "viewer"])("%s cannot approve a deletion", async (role) => {
    const body = sealed("composio.deletes_data", ["deletes_data"]);
    setRow("composio.deletes_data", body);
    state.role = role;
    const result = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(result.code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });
  it("an admin cannot approve a stale money card", async () => {
    setRow("composio.moves_money", sealed("composio.moves_money", ["moves_money"]));
    state.role = "admin";
    const result = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: "f".repeat(64) });
    expect(result.code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("an admin still approves a non-composio owner-only class (browser.action), unchanged", async () => {
    setRow("browser.action", {}); state.role = "admin";
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" } });
    expect(r.ok).toBe(true);
  });
  it("web: an owner with the card's fingerprint approves", async () => {
    const body = sealed("composio.moves_money", ["moves_money"]);
    setRow("composio.moves_money", body);
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(r.ok).toBe(true);
    expect(flipped()).toBe(true);
  });
  it("web: a member can approve a plain composio.write with the card's fingerprint", async () => {
    const body = sealed("composio.write", []);
    setRow("composio.write", body); state.role = "member";
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(r.ok).toBe(true);
  });
  it("no fingerprint (Slack button, NL yes, bulk, old client) → stale_card, no flip", async () => {
    setRow("composio.write", sealed("composio.write", []));
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" } });
    expect(r.code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("a body whose frozen account was swapped after emit → stale_card even when the caller echoes the old seal", async () => {
    const body = sealed("composio.write", []);
    setRow("composio.write", { ...body, connected_account_id: "ca_other" });
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(r.code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("a fingerprint from another card → stale_card", async () => {
    setRow("composio.write", sealed("composio.write", []));
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: "f".repeat(64) });
    expect(r.code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("a body edited after emit (its stored fingerprint no longer matches its content) → stale_card even when the caller echoes it", async () => {
    const body = sealed("composio.write", []);
    setRow("composio.write", { ...body, arguments: { charge: "ch_1", amount: 50000 } });
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(r.code).toBe("stale_card");
    expect(flipped()).toBe(false);
  });
  it("a class column that disagrees with the sealed class → stale_card", async () => {
    const body = sealed("composio.write", []);
    setRow("composio.moves_money", body);
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint });
    expect(r.code).toBe("stale_card");
  });
  for (const cls of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
    it(`staff can never approve ${cls}, even with the fingerprint`, async () => {
      const body = sealed(cls, cls === "composio.moves_money" ? ["moves_money"] : cls === "composio.deletes_data" ? ["deletes_data"] : []);
      setRow(cls, body);
      const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "staff" }, staff_override: true, expected_fingerprint: body.fingerprint });
      expect(r.code).toBe("not_authorized");
      expect(flipped()).toBe(false);
    });
  }
  it("no body edit path runs for composio.* (scheduled_at / payload_edit are ignored, card still sealed)", async () => {
    const body = sealed("composio.write", []);
    setRow("composio.write", body);
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" }, expected_fingerprint: body.fingerprint, scheduled_at: null, payload_edit: { text: "x" } });
    expect(r.ok).toBe(true);
    expect(edited()).toBe(false);
  });
  it("reject is never gated (no fingerprint, member)", async () => {
    setRow("composio.moves_money", sealed("composio.moves_money", ["moves_money"])); state.role = "member";
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "reject", actor: { user_id: "u" } });
    expect(r.ok).toBe(true);
  });
  it("other classes are unaffected by the fingerprint rule", async () => {
    setRow("support-lead.reply", {});
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" } });
    expect(r.ok).toBe(true);
  });
});
