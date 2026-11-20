import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();
const checkAgentTier = vi.fn();

vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a) }));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: (...a: unknown[]) => getVisibleAgentSlugs(...a),
}));
vi.mock("@/services/agents/entitlement", () => ({
  checkAgentTier: (...a: unknown[]) => checkAgentTier(...a),
  planUpgradeMessage: (slug: string, tier: string) => `${slug} needs ${tier}`,
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
const GOAL_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  objective: "Get 20 signups",
  target_metric: "weekly_signups",
  target_value: 20,
  baseline_value: null,
  current_value: 6,
  due_date: "2099-12-31",
  priority: 50,
  measurement_mode: "manual_reported",
};
let goalStatus: string | null = "active";
const goalEqs: Array<[string, unknown]> = [];
let hypRow: Record<string, unknown> | null = null;
vi.mock("@/services/supabase", () => {
  const chain = {
    eq: (col: string, v: unknown) => {
      goalEqs.push([col, v]);
      return chain;
    },
    maybeSingle: async () => ({ data: goalStatus ? { ...GOAL_ROW, status: goalStatus } : null, error: null }),
  };
  const hypChain = { eq: () => hypChain, maybeSingle: async () => ({ data: hypRow, error: null }) };
  return { serviceClient: () => ({ from: (t: string) => ({ select: () => (t === "cgo_hypotheses" ? hypChain : chain) }) }) };
});
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), releaseClaim: vi.fn(), markDispatched: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({ updateAdSetBudgetBodySchema: {}, setStatusBodySchema: {}, createAdSetBodySchema: {} }));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: vi.fn() }));
vi.mock("../dispatch-notice", () => ({ buildDispatchNotice: vi.fn(), postDispatchNotice: vi.fn() }));
vi.mock("@/services/growth/unattended-policy", () => ({ authorizeUnattended: async () => ({ verdict: "allow", reasons: [] }), dispatchActionFromBody: () => ({}) }));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";
import { goalRev } from "@/services/growth/goal-owner";

const GOAL = "22222222-2222-4222-8222-222222222222";
const REV = goalRev(GOAL_ROW);
const cgoCard = (body: Record<string, unknown>) =>
  ({ id: "d-cgo", tenant_id: "t-1", decision_class: "cgo.dispatch-specialist", body: { goal_rev: REV, ...body } }) as never;

beforeEach(() => {
  enqueueAgentRun.mockReset();
  getVisibleAgentSlugs.mockReset();
  checkAgentTier.mockReset();
  goalStatus = "active";
  goalEqs.length = 0;
  hypRow = null;
  getVisibleAgentSlugs.mockResolvedValue(new Set(["engineer", "research", "reddit_organic", "cgo"]));
});

describe("praxis.dispatch_specialist: cgo.dispatch-specialist cards", () => {
  it("refuses cgo as a target", async () => {
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "cgo", intent: "x", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(res.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a move the tier does not include, even engineer, and enqueues nothing", async () => {
    checkAgentTier.mockResolvedValueOnce({ enforced: true, tier: "free", required_tier: "pro", allowed: false });
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "engineer", intent: "fix the hero", dispatched_by: "cgo", goal_id: GOAL, repo_hint: "acme/site" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("engineer needs pro");
    expect(checkAgentTier).toHaveBeenCalledWith("t-1", "engineer");
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("fails closed when the tier check itself errors", async () => {
    checkAgentTier.mockRejectedValueOnce(new Error("tenant_subscriptions read failed"));
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "research", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(res.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("an allowed move enqueues the specialist with the goal id and cgo provenance", async () => {
    checkAgentTier.mockResolvedValueOnce({ enforced: false, tier: "free", required_tier: "starter", allowed: true });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-1" });
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "price the rivals", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(res.ok).toBe(true);
    const payload = enqueueAgentRun.mock.calls[0][0].payload;
    expect(payload.goal_id).toBe(GOAL);
    expect(payload.dispatched_by).toBe("cgo");
    expect(payload.source_decision_id).toBe("d-cgo");
  });

  it("a research move carries the problem it was tagged with (hypothesis tracker)", async () => {
    checkAgentTier.mockResolvedValueOnce({ enforced: false, tier: "free", required_tier: "starter", allowed: true });
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-2" });
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "check the booking page", dispatched_by: "cgo", goal_id: GOAL, problem: "conversion" }),
    );
    expect(res.ok).toBe(true);
    const payload = enqueueAgentRun.mock.calls.at(-1)[0].payload;
    expect(payload.problem).toBe("conversion");
  });

  it("refuses a card whose goal is no longer the tenant's active goal, checked by id AND tenant", async () => {
    goalStatus = "paused";
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "research", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("this goal is no longer active");
    expect(goalEqs).toEqual([
      ["id", GOAL],
      ["tenant_id", "t-1"],
    ]);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a cgo card with no goal id", async () => {
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "research", dispatched_by: "cgo" }),
    );
    expect(res.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a card made for an older version of the goal", async () => {
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "research", dispatched_by: "cgo", goal_id: GOAL, goal_rev: "stale-rev" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("this goal changed since the move was proposed");
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    ["the objective", { objective: "Get 20 signups!" }],
    ["the metric", { target_metric: "weekly_bookings" }],
    ["the target", { target_value: 25 }],
    ["the due date", { due_date: "2099-11-30" }],
  ])("an approved card made before the founder edited %s starts nothing", async (_label, before) => {
    const made = goalRev({ ...GOAL_ROW, ...before });
    expect(made).not.toBe(REV);
    checkAgentTier.mockResolvedValue({ allowed: true, tier: "pro", required_tier: "starter" });
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "research", intent: "research", dispatched_by: "cgo", goal_id: GOAL, goal_rev: made }),
    );
    expect(res).toMatchObject({ ok: false, error: "this goal changed since the move was proposed" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("a card with no revision at all is refused the same way", async () => {
    const res = await HANDLERS["praxis.dispatch_specialist"](
      { id: "d-cgo", tenant_id: "t-1", decision_class: "cgo.dispatch-specialist", body: { target_agent_slug: "research", intent: "research", dispatched_by: "cgo", goal_id: GOAL } } as never,
    );
    expect(res).toMatchObject({ ok: false, error: "this goal changed since the move was proposed" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a card for a channel agent (v2: channels propose their own cards)", async () => {
    getVisibleAgentSlugs.mockResolvedValue(new Set(["reddit_organic", "engineer"]));
    const res = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "reddit_organic", intent: "post", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(res.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("refuses a target outside cgo's allowlist, and an engineer card with no repo", async () => {
    getVisibleAgentSlugs.mockResolvedValue(new Set(["engineer", "browser-operator"]));
    const a = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "browser-operator", intent: "x", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(a.ok).toBe(false);
    const b = await HANDLERS["praxis.dispatch_specialist"](
      cgoCard({ target_agent_slug: "engineer", intent: "fix hero", dispatched_by: "cgo", goal_id: GOAL }),
    );
    expect(b).toEqual({ ok: false, error: "engineer card has no repo" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it.each(["chief-of-staff", "growth-lead", "qa", "cgo"])("keeps site identity when a %s engineer card is approved", async producer => {
    const site_id = "33333333-3333-4333-8333-333333333333";
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "site-run" });
    checkAgentTier.mockResolvedValue({ allowed: true });
    const res = await HANDLERS["praxis.dispatch_specialist"]({
      id: "site-decision", tenant_id: "t-1", decision_class: `${producer}.dispatch-specialist`,
      body: { target_agent_slug: "engineer", intent: "fix hero", repo_hint: "Praxis-build/site", site_id,
        ...(producer === "cgo" ? { goal_id: GOAL, goal_rev: REV } : {}) },
    } as never);
    expect(res.ok).toBe(true);
    expect(enqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: "t-1", agent_slug: "engineer",
      payload: expect.objectContaining({ repo_hint: "Praxis-build/site", site_id }),
    }));
  });

  it("does not run the cgo tier check for other dispatch classes", async () => {
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-2" });
    const res = await HANDLERS["praxis.dispatch_specialist"]({
      id: "d-other",
      tenant_id: "t-1",
      decision_class: "chief-of-staff.dispatch-specialist",
      body: { target_agent_slug: "engineer", intent: "x" },
    } as never);
    expect(res.ok).toBe(true);
    expect(checkAgentTier).not.toHaveBeenCalled();
  });

  it("a card cgo approved itself never starts on a hypothesis the founder said is not true; the founder's own approval still runs", async () => {
    const founderNo = { status: "ruled_out", evidence: [{ kind: "founder", ref: "q", verdict: "ruled_out" }] };
    hypRow = founderNo;
    checkAgentTier.mockResolvedValue({ enforced: false, tier: "pro", required_tier: "starter", allowed: true });
    const card = (src: string) =>
      ({ id: "d-cgo", tenant_id: "t-1", decision_class: "cgo.dispatch-specialist", approved_by_source: src, body: { goal_rev: REV, target_agent_slug: "research", intent: "x", dispatched_by: "cgo", goal_id: GOAL, hypothesis_id: "h-1" } }) as never;
    const byCgo = await HANDLERS["praxis.dispatch_specialist"](card("cgo"));
    expect(byCgo).toMatchObject({ ok: false, error: expect.stringContaining("not true for your business") });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    hypRow = { status: "ruled_out", evidence: [{ kind: "run", ref: "r", verdict: "ruled_out" }] };
    enqueueAgentRun.mockResolvedValue({ run_id: "run-x" });
    expect((await HANDLERS["praxis.dispatch_specialist"](card("cgo"))).ok).toBe(true);
    hypRow = founderNo;
    expect((await HANDLERS["praxis.dispatch_specialist"](card("founder"))).ok).toBe(true);
  });
});
