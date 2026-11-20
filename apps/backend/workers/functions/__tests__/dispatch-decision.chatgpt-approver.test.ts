
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));

const m = vi.hoisted(() => ({
  role: "owner" as string | null,
  roleCalls: [] as Array<[string, string]>,
  execute: vi.fn(async () => ({ ok: true })),
  cgoAdBudget: vi.fn(async () => true),
  authorizeUnattended: vi.fn(async () => ({ verdict: "allow", reasons: [] as string[] })),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/waiver-resolve", () => ({ resolveWaiverState: vi.fn(async () => ({ state: "none" })) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(), buildOpenPrNotice: vi.fn(), extractChatThreadId: vi.fn(() => null),
  extractSlackRouting: vi.fn(() => null), postDispatchNotice: vi.fn(), HANDLER_LABELS: {},
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: vi.fn(async (u: string, t: string) => { m.roleCalls.push([u, t]); return m.role; }),
}));
vi.mock("@/services/connectors/chatgpt-ads/growth-execution", () => ({ executeChatgptGrowthAction: m.execute }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: m.cgoAdBudget }));
vi.mock("@/services/growth/unattended-policy", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  authorizeUnattended: m.authorizeUnattended,
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

type Row = Parameters<(typeof HANDLERS)["chatgpt_ads.update_campaign_budget"]>[0];
const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const row = (decision_class: string, body: Record<string, unknown>, approved_by_source: string | null = null) =>
  ({ id: "d-1", tenant_id: T, agent_run_id: null, decision_class, body, status: "dispatching", approved_by: "u-member", approved_by_source }) as unknown as Row;

beforeEach(() => {
  m.role = "member";
  m.roleCalls.length = 0;
  m.execute.mockClear();
  m.cgoAdBudget.mockClear();
  m.authorizeUnattended.mockClear();
});

describe("ChatGPT Ads executor: the approver must still be an owner or admin", () => {
  it.each([
    ["chatgpt_ads.create_and_launch", { name: "c" }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }],
    ["chatgpt_ads.set_status", { status: "ACTIVE" }],
  ])("hands %s back to the founder when the approver lost the role, before any OpenAI call", async (cls, body) => {
    const r = await HANDLERS[cls](row(cls, body));
    expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "chatgpt_ads_admin_required" });
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.roleCalls).toEqual([["u-member", T]]);
  });

  it("runs the raise when the approver is still an admin", async () => {
    m.role = "admin";
    const cls = "chatgpt_ads.update_campaign_budget";
    const r = await HANDLERS[cls](row(cls, { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }));
    expect(r).toEqual({ ok: true });
    expect(m.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["chatgpt_ads.set_status", { status: "PAUSED" }],
    ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 30, expected_current_daily_budget_usd: 60 }],
  ])("a member's %s still runs, with no role read", async (cls, body) => {
    const r = await HANDLERS[cls](row(cls, body));
    expect(r).toEqual({ ok: true });
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(m.roleCalls).toHaveLength(0);
  });

  it("a cgo Autopilot approval is unaffected (its own gate runs, no role re-check)", async () => {
    const cls = "chatgpt_ads.create_and_launch";
    const r = await HANDLERS[cls](row(cls, { name: "c" }, "cgo"));
    expect(r).toEqual({ ok: true });
    expect(m.cgoAdBudget).toHaveBeenCalledTimes(1);
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(m.roleCalls).toHaveLength(0);
  });

  it("a staff approval is unaffected", async () => {
    const cls = "chatgpt_ads.update_campaign_budget";
    const r = await HANDLERS[cls](row(cls, { daily_budget_usd: 90, expected_current_daily_budget_usd: 60 }, "staff"));
    expect(r).toEqual({ ok: true });
    expect(m.roleCalls).toHaveLength(0);
  });
});
