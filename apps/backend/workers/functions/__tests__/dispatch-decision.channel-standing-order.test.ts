
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runSlug: vi.fn(),
  upsert: vi.fn(),
  send: vi.fn(async () => undefined),
}));

vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}), send: mocks.send },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          maybeSingle: async () => ({
            data: table === "agent_runs" ? mocks.runSlug() : null,
            error: null,
          }),
        }),
      }),
      upsert: (row: unknown, opts: unknown) => {
        mocks.upsert(table, row, opts);
        return Promise.resolve({ error: null });
      },
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }),
}));

vi.mock("@/services/connectors/social-publish-account", () => ({
  resolveSocialPublishAccount: vi.fn(),
}));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
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
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const THREAD = "11111111-1111-1111-1111-111111111111";

function decision(body: Record<string, unknown>, agent_run_id: string | null = "run-1") {
  return {
    id: "dec-1",
    tenant_id: "t-1",
    agent_run_id,
    decision_class: "channel.create-standing-order",
    status: "approved",
    handler: "praxis.create_channel_standing_order",
    body,
  } as never;
}

const body = {
  cron_expression: "0 13 * * *",
  timezone: "Asia/Calcutta",
  standing_order: { prompt: "Daily X brief", deliver: { kind: "chat_thread", thread_id: THREAD } },
  agent_slug: "engineer",
};

beforeEach(() => {
  mocks.upsert.mockReset();
  mocks.runSlug.mockReset().mockReturnValue({ agent_slug: "x_organic" });
});

describe("praxis.create_channel_standing_order", () => {
  it("writes the run agent's schedule row with timezone, upserting on (tenant_id, agent_slug)", async () => {
    const res = await HANDLERS["praxis.create_channel_standing_order"](decision(body));
    expect(res.ok).toBe(true);
    expect(res.notice).toMatch(/X schedule active/);
    expect(mocks.upsert).toHaveBeenCalledWith(
      "tenant_agent_schedules",
      expect.objectContaining({
        tenant_id: "t-1",
        agent_slug: "x_organic",
        cron_expression: "0 13 * * *",
        timezone: "Asia/Calcutta",
        enabled: true,
        payload_template: { standing_order: body.standing_order },
      }),
      { onConflict: "tenant_id,agent_slug" },
    );
  });

  it("refuses when the originating run owns no channel", async () => {
    mocks.runSlug.mockReturnValue({ agent_slug: "operator" });
    const res = await HANDLERS["praxis.create_channel_standing_order"](decision(body));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not own a channel/);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses without an originating run or when it cannot be found", async () => {
    const none = await HANDLERS["praxis.create_channel_standing_order"](decision(body, null));
    expect(none.ok).toBe(false);
    mocks.runSlug.mockReturnValue(null);
    const gone = await HANDLERS["praxis.create_channel_standing_order"](decision(body));
    expect(gone.ok).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a bad timezone before writing", async () => {
    const res = await HANDLERS["praxis.create_channel_standing_order"](
      decision({ ...body, timezone: "Mars/Olympus" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid timezone/);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
