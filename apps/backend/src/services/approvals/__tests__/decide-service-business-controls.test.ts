import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: {
    row: null as Record<string, unknown> | null,
    role: "owner" as string | null,
  },
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
      return Promise.resolve({
        data: {
          changed: true,
          status: fn.startsWith("decide")
            ? args.p_action === "reject"
              ? "rejected"
              : "approved"
            : "ok",
          ok: true,
        },
        error: null,
      });
    },
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: async () => state.role,
}));
vi.mock("@/../workers/client", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: vi.fn(),
}));
vi.mock("@/services/memory/stamp-outcome", () => ({
  stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/growth/bind-action-outcome", () => ({
  bindActionOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/analytics/action-events", () => ({
  trackApprovalCardDecided: vi.fn(),
}));

import { decideOnDecision } from "../decide-service";
import { trackApprovalCardDecided } from "@/services/analytics/action-events";

const saved = vi.hoisted(() => ({ approve: vi.fn() }));
vi.mock("@/services/growth/business-control-proposal", () => ({
  approveBusinessControls: saved.approve,
}));
beforeEach(() => {
  rpcCalls.length = 0;
  state.role = "owner";
  saved.approve.mockReset();
  state.row = {
    id: "d-1",
    tenant_id: "t-1",
    status: "proposed",
    decision_class: "growth.save_business_controls",
    agent_run_id: null,
    body: {},
  };
});
const approve = (extra: Record<string, unknown> = {}) =>
  decideOnDecision({
    decision_id: "d-1",
    tenant_id: "t-1",
    action: "approve",
    actor: { user_id: "u" },
    business_controls: { policy: {} },
    ...extra,
  });
it.each(["member", "viewer", null])(
  "refuses role %s before saving",
  async (role) => {
    state.role = role;
    expect((await approve()).code).toBe("not_authorized");
    expect(saved.approve).not.toHaveBeenCalled();
  },
);
it.each([{ staff_override: true }, { approver_source: "cgo" }])(
  "refuses non-human approval %j",
  async (extra) => {
    expect((await approve(extra)).code).toBe("not_authorized");
    expect(saved.approve).not.toHaveBeenCalled();
  },
);
it("refuses bare chat yes, Slack and generic approval", async () => {
  expect((await approve({ business_controls: undefined })).code).toBe(
    "stale_card",
  );
  expect(saved.approve).not.toHaveBeenCalled();
});
it("refuses cross-tenant requests", async () => {
  expect((await approve({ tenant_id: "other" })).code).toBe("cross_tenant");
  expect(saved.approve).not.toHaveBeenCalled();
});
it("returns saved only after the atomic policy approval succeeds, with no worker dispatch", async () => {
  saved.approve.mockResolvedValue({ status: "saved", changed: true });
  expect(await approve()).toMatchObject({
    ok: true,
    changed: true,
    status: "acted",
  });
  expect(rpcCalls).toHaveLength(0);
  expect(trackApprovalCardDecided).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "approved", decision_class: "growth.save_business_controls" }),
  );
});
it("does not count an identical replay as a second approval", async () => {
  vi.mocked(trackApprovalCardDecided).mockClear();
  saved.approve.mockResolvedValue({ status: "saved", changed: false });
  expect(await approve()).toMatchObject({ ok: true, changed: false });
  expect(trackApprovalCardDecided).not.toHaveBeenCalled();
});
it("maps stale/invalid policy and database failures without approving", async () => {
  saved.approve
    .mockResolvedValueOnce({ status: "stale_card" })
    .mockResolvedValueOnce({ status: "invalid_edit" })
    .mockRejectedValueOnce(new Error("DB down"));
  expect((await approve()).code).toBe("stale_card");
  expect((await approve()).code).toBe("invalid_edit");
  expect((await approve()).ok).toBe(false);
  expect(rpcCalls).toHaveLength(0);
});
