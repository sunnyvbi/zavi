import { describe, it, expect, vi, beforeEach } from "vitest";

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

function setRow(decision_class: string, body: Record<string, unknown>) {
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class, agent_run_id: null, body };
}
const flipped = (fn = "decide_decision_as_actor") => rpcCalls.some((c) => c.fn === fn);
const approve = () => decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" } });

beforeEach(() => { rpcCalls.length = 0; state.role = "member"; });

describe("ChatGPT Ads cards: spend needs an owner or admin at the click", () => {
  it.each([
    ["chatgpt_ads.create_and_launch", { name: "c" }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 90 }],
    ["chatgpt_ads.set_status", { status: "ACTIVE" }],
  ] as const)("a member's %s %j is refused before it is accepted", async (cls, body) => {
    setRow(cls, body);
    expect((await approve()).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });

  it.each([
    ["chatgpt_ads.set_status", { status: "PAUSED" }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 50, expected_current_daily_budget_usd: 60 }],
  ] as const)("a member may still approve %s %j", async (cls, body) => {
    setRow(cls, body);
    expect((await approve()).ok).toBe(true);
    expect(flipped()).toBe(true);
  });

  it.each(["owner", "admin"])("an %s approves a launch", async (r) => {
    state.role = r;
    setRow("chatgpt_ads.create_and_launch", { name: "c" });
    expect((await approve()).ok).toBe(true);
  });

  it("cgo's own Autopilot approval is unaffected", async () => {
    state.role = "owner";
    setRow("chatgpt_ads.create_and_launch", { name: "c" });
    const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "owner" }, approver_source: "cgo" });
    expect(r.ok).toBe(true);
    expect(flipped("decide_decision_as_cgo")).toBe(true);
  });
});
