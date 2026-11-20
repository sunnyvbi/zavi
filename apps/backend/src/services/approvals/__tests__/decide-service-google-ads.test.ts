import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcCalls, state } = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  state: { row: null as Record<string, unknown> | null, role: "owner" as string | null, roleFails: false },
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
      return Promise.resolve({ data: { changed: true, status: args.p_action === "reject" ? "rejected" : "approved", ok: true }, error: null });
    },
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: async () => {
    if (state.roleFails) throw new Error("role read failed");
    return state.role;
  },
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/analytics/action-events", () => ({ trackApprovalCardDecided: vi.fn() }));

import { decideOnDecision } from "../decide-service";

const RAISE = { campaign_id: "1", daily_budget_usd: 30, expected_current_daily_budget_usd: 20, origin: "user_initiated_chat" };
const CUT = { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, origin: "user_initiated_chat" };
function setRow(decision_class: string, body: Record<string, unknown>) {
  state.row = { id: "d-1", tenant_id: "t-1", status: "proposed", decision_class, agent_run_id: null, body };
}
const flipped = () => rpcCalls.some((c) => c.fn === "decide_decision_as_actor");
const approve = () => decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "u" } });

beforeEach(() => {
  rpcCalls.length = 0;
  state.role = "member";
  state.roleFails = false;
});

describe("Google Ads cards: a spend raise needs an owner or admin", () => {
  it("a member approving a Google budget raise is refused and nothing changes", async () => {
    setRow("google_ads.update_campaign_budget_review", RAISE);
    expect((await approve()).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });

  it.each(["owner", "admin"])("an %s approves the raise", async (r) => {
    state.role = r;
    setRow("google_ads.update_campaign_budget_review", RAISE);
    const res = await approve();
    expect(res.ok).toBe(true);
    expect(flipped()).toBe(true);
  });

  it("a member may approve a Google budget cut", async () => {
    setRow("google_ads.update_campaign_budget_review", CUT);
    expect((await approve()).ok).toBe(true);
    expect(flipped()).toBe(true);
  });

  it("a member removing a NEGATIVE keyword (widens targeting) is refused; an unread one too", async () => {
    for (const body of [
      { level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2", criterion_negative: true },
      { level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2" },
      null,
    ]) {
      setRow("google_ads.remove_resource", body as Record<string, unknown>);
      expect((await approve()).code, JSON.stringify(body)).toBe("not_authorized");
    }
    expect(flipped()).toBe(false);
  });

  it("a member may remove a keyword the server read as positive", async () => {
    setRow("google_ads.remove_resource", { level: "keyword", scope: "ad_group", parent_id: "1", criterion_id: "2", criterion_negative: false });
    expect((await approve()).ok).toBe(true);
  });

  it("a role-read error is not_authorized (fail closed)", async () => {
    state.roleFails = true;
    setRow("google_ads.update_campaign_budget_review", RAISE);
    expect((await approve()).code).toBe("not_authorized");
    expect(flipped()).toBe(false);
  });

  it("a member's reject is never gated", async () => {
    setRow("google_ads.update_campaign_budget_review", RAISE);
    const res = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "reject", actor: { user_id: "u" } });
    expect(res.ok).toBe(true);
  });

  it("G3: Autopilot (approver_source cgo) never decides a founder-ordered row, even as the owner; nothing flips", async () => {
    state.role = "owner";
    for (const origin of ["user_initiated_chat", "user_initiated_ledger"]) {
      setRow("google_ads.update_campaign_budget_review", { ...CUT, origin });
      const r = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "owner" }, approver_source: "cgo" });
      expect(r.code).toBe("not_authorized");
    }
    expect(rpcCalls).toHaveLength(0);
    setRow("google_ads.update_campaign_budget_review", { campaign_id: "1", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 });
    const ok = await decideOnDecision({ decision_id: "d-1", tenant_id: "t-1", action: "approve", actor: { user_id: "owner" }, approver_source: "cgo" });
    expect(ok.ok).toBe(true);
    expect(rpcCalls.some((c) => c.fn === "decide_decision_as_cgo")).toBe(true);
  });
});

const paired = vi.hoisted(() => ({ verdict: { kind: "go" } as { kind: "go" } | { kind: "wait"; why: "cut_untapped"; legs: [] } }));
vi.mock("@/services/growth/move-group", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/move-group")>()),
  checkPairedLeg: vi.fn(async () => paired.verdict),
  runAloneConfirm: vi.fn(async () => ({ message: "confirm", daily_add: 10, currency: null, open_legs: 1, why: "cut_untapped" })),
}));

describe("a founder's paired move: the raise waits for the cut", () => {
  it("must-catch: the raise is refused with the founder's words and nothing flips", async () => {
    state.role = "owner";
    paired.verdict = { kind: "wait", why: "cut_untapped", legs: [] };
    setRow("google_ads.update_campaign_budget_review", { ...RAISE, founder_chat_order: true, move_group: "run-root" });
    const res = await approve();
    expect(res).toMatchObject({ ok: false, code: "paired_move_waits", status: "proposed" });
    expect(res.detail).toMatch(/Approve the matching cut first/);
    expect(flipped()).toBe(false);
  });

  it("must-not-touch: a leg cleared to go approves as before", async () => {
    state.role = "owner";
    paired.verdict = { kind: "go" };
    setRow("google_ads.update_campaign_budget_review", { ...RAISE, founder_chat_order: true, move_group: "run-root" });
    expect((await approve()).ok).toBe(true);
    expect(flipped()).toBe(true);
  });
});
