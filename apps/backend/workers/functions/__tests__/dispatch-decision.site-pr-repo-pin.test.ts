
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();
const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const metaWriteEnabled = vi.fn(async () => true);
const googleWriteEnabled = vi.fn(async () => true);
const metaSetStatusMock = vi.fn(async () => ({ ok: true }));

const decisionsUpdates: Array<Record<string, unknown>> = [];
let agentRunRow: Record<string, unknown> | null = null;
const seenBodies: unknown[] = [];
const resolveRepo = vi.fn();

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
}));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: (...a: unknown[]) => getVisibleAgentSlugs(...a),
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "decisions") {
        return {
          update: (payload: Record<string, unknown>) => {
            decisionsUpdates.push(payload);
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      if (table === "agent_runs") {
        const chain: Record<string, unknown> = {
          maybeSingle: async () => ({ data: agentRunRow, error: null }),
          single: async () => ({ data: agentRunRow, error: null }),
        };
        for (const m of ["eq", "in", "is", "order", "limit"]) chain[m] = () => chain;
        return { select: () => chain };
      }
      const empty: Record<string, unknown> = {
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
      };
      for (const m of ["eq", "in", "is", "neq", "gte", "lte", "order", "limit"]) empty[m] = () => empty;
      return { select: () => empty };
    },
  }),
}));

vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({
  isMetaAdsWriteEnabled: () => metaWriteEnabled(),
}));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({
  isGoogleAdsWriteEnabled: () => googleWriteEnabled(),
}));

const lockedChannels = new Set<string>();
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: async (slug: string) => lockedChannels.has(slug),
  isChannelLockedStrict: async (slug: string) => lockedChannels.has(slug),
}));

vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({
  prProposalSchema: { safeParse: (b: unknown) => { seenBodies.push(b); return { success: false, error: { issues: [] } }; } },
  prProposalProductBuildSchema: { safeParse: (b: unknown) => { seenBodies.push(b); return { success: false, error: { issues: [] } }; } },
}));
vi.mock("@/services/agents/repo-resolver", () => ({ resolveRepoFullName: (...a: unknown[]) => resolveRepo(...a) }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({
  claimDecision: (id: string) => claimDecisionMock(id),
  releaseClaim: vi.fn(),
  markDispatched: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => isFleetHaltedMock() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({
  updateAdSetBudgetBodySchema: {},
  setStatusBodySchema: {
    safeParse: (b: unknown) => ({ success: true as const, data: b }),
  },
  createAdSetBodySchema: {},
}));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: (...a: unknown[]) => metaSetStatusMock(...(a as [])) }));
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
  extractChatThreadId: vi.fn(() => null),
  extractSlackRouting: vi.fn(() => null),
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";

const shipPr = (body: Record<string, unknown>) => ({
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: "run-1",
  decision_class: "engineer.ship-pr",
  handler: "github.open_pr",
  status: "approved",
  body,
});
const MODEL_BODY = { repo: "acme/not-the-site", title: "SEO: titles", base_branch: "main", push_to_main: true, files: [] };

beforeEach(() => {
  decisionsUpdates.length = 0;
  seenBodies.length = 0;
  agentRunRow = null;
  claimDecisionMock.mockReset();
  resolveRepo.mockReset();
  isFleetHaltedMock.mockResolvedValue(false);
});

describe("dispatch-decision — a site PR card's PR opens on the server's repo", () => {
  it("replaces the model's repo with the re-resolved card repo and drops push_to_main", async () => {
    agentRunRow = { agent_slug: "engineer", trigger: "a2a", enqueued_by: null, payload: { repo_hint: "acme/site", site_pr_card: { action_id: "a", claim_id: "c", exec_class: "seo.create_pr.v1" } } };
    resolveRepo.mockResolvedValueOnce("acme/site");
    claimDecisionMock.mockResolvedValueOnce(shipPr({ ...MODEL_BODY }));

    await executeDispatch("d-1");

    expect(resolveRepo).toHaveBeenCalledWith({ tenant_id: "t-1", repo_hint: "acme/site" });
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toMatchObject({ repo: "acme/site", title: "SEO: titles" });
    expect(seenBodies[0]).not.toHaveProperty("push_to_main");
  });

  it("refuses, writing nothing, when the card repo no longer resolves for the tenant", async () => {
    agentRunRow = { agent_slug: "engineer", trigger: "a2a", enqueued_by: null, payload: { repo_hint: "acme/site", site_pr_card: { action_id: "a", claim_id: "c", exec_class: "geo.create_pr.v1" } } };
    resolveRepo.mockRejectedValueOnce(new Error("repo_hint_not_connected"));
    claimDecisionMock.mockResolvedValueOnce(shipPr({ ...MODEL_BODY }));

    const res = await executeDispatch("d-1");

    expect(res.ok).toBe(false);
    expect(seenBodies).toHaveLength(0);
    expect(decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(true);
  });

  it("leaves an ordinary engineer PR (no site_pr_card) exactly as the model wrote it", async () => {
    agentRunRow = { agent_slug: "engineer", trigger: "a2a", enqueued_by: null, payload: { repo_hint: "acme/site", task_description: "fix" } };
    claimDecisionMock.mockResolvedValueOnce(shipPr({ ...MODEL_BODY }));

    await executeDispatch("d-1");

    expect(resolveRepo).not.toHaveBeenCalled();
    expect(seenBodies[0]).toMatchObject({ repo: "acme/not-the-site", push_to_main: true });
  });

  it("leaves a client-enqueued run's PR alone even if its payload claims a card", async () => {
    agentRunRow = { agent_slug: "engineer", trigger: "manual", enqueued_by: "u-1", payload: { repo_hint: "acme/site", site_pr_card: { action_id: "a", claim_id: "c", exec_class: "seo.create_pr.v1" } } };
    claimDecisionMock.mockResolvedValueOnce(shipPr({ ...MODEL_BODY }));

    await executeDispatch("d-1");

    expect(resolveRepo).not.toHaveBeenCalled();
    expect(seenBodies[0]).toMatchObject({ repo: "acme/not-the-site" });
  });
});
