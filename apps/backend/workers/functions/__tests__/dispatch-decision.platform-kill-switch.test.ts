
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));

const enqueueAgentRun = vi.fn();
const getVisibleAgentSlugs = vi.fn();
const claimDecisionMock = vi.fn();
const isFleetHaltedMock = vi.fn(async () => false);
const metaWriteEnabled = vi.fn(async () => true);
const googleWriteEnabled = vi.fn(async () => true);
const metaSetStatusMock = vi.fn(async () => ({ ok: true }));

const decisionsUpdates: Array<Record<string, unknown>> = [];

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
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
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
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
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
  postDispatchNotice: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_executeDispatch as executeDispatch, pinSitePrBody, readSitePrRun } from "../dispatch-decision";
import { platformWriteEnabled } from "@/services/channels/exec-kill-switch";

function claimed(over: Record<string, unknown>) {
  return {
    id: "d-1",
    tenant_id: "t-1",
    agent_run_id: null,
    body: {},
    status: "approved",
    ...over,
  };
}

beforeEach(() => {
  decisionsUpdates.length = 0;
  claimDecisionMock.mockReset();
  isFleetHaltedMock.mockReset();
  isFleetHaltedMock.mockResolvedValue(false);
  enqueueAgentRun.mockReset();
  getVisibleAgentSlugs.mockReset();
  getVisibleAgentSlugs.mockResolvedValue(new Set(["pm"]));
  metaSetStatusMock.mockReset();
  metaSetStatusMock.mockResolvedValue({ ok: true });
  metaWriteEnabled.mockReset();
  metaWriteEnabled.mockResolvedValue(true);
  googleWriteEnabled.mockReset();
  googleWriteEnabled.mockResolvedValue(true);
});

describe("dispatch-decision — platform write switch, checked at execute time", () => {
  it("meta switch OFF refuses a staged meta card and never touches the account", async () => {
    metaWriteEnabled.mockResolvedValue(false);
    claimDecisionMock.mockResolvedValueOnce(
      claimed({
        decision_class: "meta_ads.set_status",
        handler: "meta_ads.set_status",
        body: { object_id: "23848", level: "adset", status: "PAUSED" },
      }),
    );

    const res = await executeDispatch("d-1");

    expect(res.ok).toBe(false);
    expect(metaSetStatusMock).not.toHaveBeenCalled();
    expect(decisionsUpdates.some((u) => u.status === "rejected")).toBe(false);
    const failed = decisionsUpdates.find((u) => u.status === "dispatch_failed");
    expect(failed, "expected a terminal dispatch_failed settle").toBeTruthy();
    expect(String(failed!.dispatch_error)).toMatch(/Meta Ads/);
    expect(String(failed!.dispatch_error)).toMatch(/Nothing in the account changed/i);
  });

  it("google switch OFF refuses a google card on this rail too", async () => {
    googleWriteEnabled.mockResolvedValue(false);
    claimDecisionMock.mockResolvedValueOnce(
      claimed({
        decision_class: "google_ads.update_campaign_budget",
        handler: "google_ads.update_campaign_budget",
        body: { campaign_id: "c-1", daily_budget_usd: 90 },
      }),
    );

    const res = await executeDispatch("d-1");

    expect(res.ok).toBe(false);
    const failed = decisionsUpdates.find((u) => u.status === "dispatch_failed");
    expect(failed).toBeTruthy();
    expect(String(failed!.dispatch_error)).toMatch(/Google Ads/);
  });

  it("meta switch ON lets the same card through to the account", async () => {
    claimDecisionMock.mockResolvedValueOnce(
      claimed({
        decision_class: "meta_ads.set_status",
        handler: "meta_ads.set_status",
        body: { object_id: "23848", level: "adset", status: "PAUSED" },
      }),
    );

    const res = await executeDispatch("d-1");

    expect(res.ok).toBe(true);
    expect(metaSetStatusMock).toHaveBeenCalledTimes(1);
    expect(decisionsUpdates.some((u) => u.status === "acted")).toBe(true);
  });

  it("a non-ad class dispatches normally while BOTH ad switches are off", async () => {
    metaWriteEnabled.mockResolvedValue(false);
    googleWriteEnabled.mockResolvedValue(false);
    enqueueAgentRun.mockResolvedValueOnce({ run_id: "run-9" });
    claimDecisionMock.mockResolvedValueOnce(
      claimed({
        decision_class: "praxis.dispatch_specialist",
        handler: "praxis.dispatch_specialist",
        body: { target_agent_slug: "pm", intent: "do a thing" },
      }),
    );

    const res = await executeDispatch("d-1");

    expect(res.ok).toBe(true);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(decisionsUpdates.some((u) => u.status === "acted")).toBe(true);
    expect(decisionsUpdates.some((u) => u.status === "dispatch_failed")).toBe(false);
  });
});

describe("dispatch-decision — a site PR card's run governs its github.open_pr", () => {
  const svcWith = (row: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }) }),
  }) as never;
  const card = (exec_class: string, repo_hint: unknown = "acme/site") => ({ payload: { site_pr_card: { action_id: "a", claim_id: "c", exec_class }, repo_hint }, enqueued_by: null });
  const pr = { handler: "github.open_pr", agent_run_id: "run-1", tenant_id: "t-1" };

  beforeEach(() => lockedChannels.clear());

  it("names the card class and the server's repo for a server-started site PR run", async () => {
    expect(await readSitePrRun(svcWith(card("seo.create_pr.v1")), pr)).toEqual({ kind: "site_pr", exec_class: "seo.create_pr.v1", repo_hint: "acme/site", page_copy: null, approved_by: null, page_url: null });
    expect(await readSitePrRun(svcWith(card("geo.create_pr.v1", 7)), pr)).toEqual({ kind: "site_pr", exec_class: "geo.create_pr.v1", repo_hint: null, page_copy: null, approved_by: null, page_url: null });
  });

  it("carries a page-copy card's blocks, and an unreadable set is an error, never 'no blocks'", async () => {
    const blocks = [{ current_text: "old", new_text: "new" }];
    const withCopy = (pc: unknown) => ({ payload: { ...card("seo.create_pr.v1").payload, site_pr_content: { page_copy: pc } }, enqueued_by: null });
    expect(await readSitePrRun(svcWith(withCopy({ blocks })), pr)).toEqual({ kind: "site_pr", exec_class: "seo.create_pr.v1", repo_hint: "acme/site", page_copy: blocks, approved_by: null, page_url: null });
    expect(await readSitePrRun(svcWith(withCopy({ blocks: "x" })), pr)).toEqual({ kind: "error" });
    const approved = { payload: { ...withCopy({ blocks }).payload, site_pr_card: { action_id: "a", claim_id: "c", exec_class: "seo.create_pr.v1", approved_by: "u-9" } }, enqueued_by: null };
    expect(await readSitePrRun(svcWith(approved), pr)).toMatchObject({ approved_by: "u-9" });
  });

  it("is `none` for every other decision, a client-enqueued run or an unknown class", async () => {
    expect(await readSitePrRun(svcWith(card("seo.create_pr.v1")), { ...pr, handler: "meta_ads.set_status" })).toEqual({ kind: "none" });
    expect(await readSitePrRun(svcWith(card("seo.create_pr.v1")), { ...pr, agent_run_id: null })).toEqual({ kind: "none" });
    expect(await readSitePrRun(svcWith({ ...card("seo.create_pr.v1"), enqueued_by: "u-1" }), pr)).toEqual({ kind: "none" });
    expect(await readSitePrRun(svcWith(card("meta_ads.set_status")), pr)).toEqual({ kind: "none" });
    expect(await readSitePrRun(svcWith({ payload: { task_description: "x" }, enqueued_by: null }), pr)).toEqual({ kind: "none" });
  });

  it("is `error` (refuse, never guess) when the run cannot be read", async () => {
    expect(await readSitePrRun(svcWith(null, { message: "boom" }), pr)).toEqual({ kind: "error" });
  });

  it("pins the repo the server resolved over the one the model wrote, and keeps it a reviewable PR", () => {
    const body = { repo: "acme/other-repo", title: "SEO: x", push_to_main: true, defer_pr: true, live_edit_draft: true, expected_base_sha: "f".repeat(40), files: [] };
    expect(pinSitePrBody(body, "acme/site")).toEqual({ repo: "acme/site", title: "SEO: x", files: [] });
  });

  it("the seo lock turns the card class off while github.open_pr itself stays on", async () => {
    lockedChannels.add("seo");
    expect(await platformWriteEnabled("seo.create_pr.v1")).toBe(false);
    expect(await platformWriteEnabled("geo.create_pr.v1")).toBe(true);
    expect(await platformWriteEnabled("github.open_pr")).toBe(true);
  });
});
