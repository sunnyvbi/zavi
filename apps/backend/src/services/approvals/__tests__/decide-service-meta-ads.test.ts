import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null, role: "owner" as string | null },
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
const flipped = () => rpcCalls.some((c) => c.fn.startsWith("decide_decision_as"));
const approve = () => decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" } });

beforeEach(() => { rpcCalls.length = 0; state.role = "member"; });

describe("Meta Ads cards: spend needs an owner or admin at the click", () => {
  it("a member's launch, copy, raise or switch-on is refused before it is accepted", async () => {
    for (const [cls, body] of [
      ["meta_ads.launch_campaign", { campaign: { daily_budget_usd: 30 } }],
      ["meta_ads.duplicate_campaign", { source_campaign_id: "1", daily_budget_usd: 20 }],
      ["meta_ads.update_ad_set_budget_review", { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }],
      ["meta_ads.set_status", { status: "ACTIVE" }],
    ] as const) {
      rpcCalls.length = 0;
      setRow(cls, body);
      expect((await approve()).code).toBe("not_authorized");
      expect(flipped()).toBe(false);
    }
  });

  it("a member may still approve a pause or a cut", async () => {
    for (const [cls, body] of [
      ["meta_ads.set_status", { status: "PAUSED" }],
      ["meta_ads.update_campaign_budget", { daily_budget_usd: 50, expected_current_daily_budget_usd: 60 }],
    ] as const) {
      rpcCalls.length = 0;
      setRow(cls, body);
      expect((await approve()).ok).toBe(true);
      expect(flipped()).toBe(true);
    }
  });

  it("an admin approves a launch", async () => {
    state.role = "admin";
    setRow("meta_ads.launch_campaign", { campaign: { daily_budget_usd: 30 } });
    expect((await approve()).ok).toBe(true);
  });
});
