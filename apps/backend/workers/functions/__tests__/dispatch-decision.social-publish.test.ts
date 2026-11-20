
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  send: vi.fn(async () => undefined),
}));

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("../../client", () => ({
  inngest: { createFunction: () => ({}), send: mocks.send },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    rpc: mocks.rpc,
  }),
}));

vi.mock("@/services/connectors/social-publish-account", () => ({
  resolveSocialPublishAccount: vi.fn(async () => ({ accountId: "native", transport: "native" })),
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
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const FUTURE = "2099-01-02T09:00:00.000Z";
const PAST = "2001-01-02T09:00:00.000Z";

function decision(scheduled_at: unknown) {
  return {
    id: "dec-1",
    tenant_id: "t-1",
    agent_run_id: null,
    decision_class: "social.publish.v2",
    status: "approved",
    handler: "social.publish.v2",
    body: { channel: "linkedin", payload: { text: "Hello" }, scheduled_at },
  };
}

function createArgs() {
  const call = mocks.rpc.mock.calls.find((c) => c[0] === "social_post_create");
  if (!call) throw new Error("social_post_create not called");
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  resetTenantPlan();
  mocks.rpc.mockReset();
  mocks.send.mockClear();
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === "_social_publish_enabled") return { data: true, error: null };
    if (fn === "social_post_create") return { data: "post-1", error: null };
    return { data: null, error: null };
  });
});

describe("social.publish.v2 — scheduled_at is judged at approval", () => {
  it("a future time is frozen into the snapshot, the RPC arg, and the notice", async () => {
    const res = await HANDLERS["social.publish.v2"](decision(FUTURE));
    expect(res.ok).toBe(true);
    const args = createArgs();
    expect(args.p_scheduled_at).toBe(FUTURE);
    expect((args.p_snapshot as { scheduled_at: unknown }).scheduled_at).toBe(FUTURE);
    expect(res.notice).toMatch(/Scheduled linkedin post for/);
    expect(res.notice).toContain("2099");
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("a time moved on the channel calendar (set_staged_post_scheduled_at's format) is the one frozen", async () => {
    const MOVED = "2099-03-04T17:00:00Z";
    const res = await HANDLERS["social.publish.v2"](decision(MOVED));
    expect(res.ok).toBe(true);
    const args = createArgs();
    expect(args.p_scheduled_at).toBe(MOVED);
    expect((args.p_snapshot as { scheduled_at: unknown }).scheduled_at).toBe(MOVED);
  });

  it("a past time becomes null — immediate publish, and the notice says so", async () => {
    const res = await HANDLERS["social.publish.v2"](decision(PAST));
    expect(res.ok).toBe(true);
    const args = createArgs();
    expect(args.p_scheduled_at).toBeNull();
    expect((args.p_snapshot as { scheduled_at: unknown }).scheduled_at).toBeNull();
    expect(res.notice).toMatch(/immediate publish/);
  });

  it("null / absent behave the same as a past time", async () => {
    for (const v of [null, undefined]) {
      mocks.rpc.mockClear();
      const res = await HANDLERS["social.publish.v2"](decision(v));
      expect(res.ok).toBe(true);
      expect(createArgs().p_scheduled_at).toBeNull();
      expect(res.notice).toMatch(/immediate publish/);
    }
  });

  it("a non-ISO time is refused before any RPC or insert", async () => {
    const res = await HANDLERS["social.publish.v2"](decision("tomorrow at 9"));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/scheduled_at/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("social.publish.v2 — developer/test copy is refused at approval", () => {
  it("the leaked test post is refused with a reason the card can show, before any post row", async () => {
    const res = await HANDLERS["social.publish.v2"]({
      ...decision(null),
      body: {
        channel: "linkedin",
        payload: { text: "Local test from the X agent panel: a thread root, staged for approval, never posted on its own. (Zavi dev)" },
        scheduled_at: null,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/test marker/);
    expect(mocks.rpc.mock.calls.some((c) => c[0] === "social_post_create")).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a draft with unfilled blanks is refused and the error names them", async () => {
    const res = await HANDLERS["social.publish.v2"]({
      ...decision(null),
      body: { channel: "linkedin", payload: { text: "Hi [First name], we just launched in [city]." }, scheduled_at: null },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Fill before publishing: [First name], [city]");
    expect(mocks.rpc.mock.calls.some((c) => c[0] === "social_post_create")).toBe(false);
  });
});

describe("social.publish.v2 and the plan", () => {
  it("Free: refused with the upgrade message; no post row, no publish event, not even the rail check", async () => {
    tenantPlan.tier = "free";
    const res = await HANDLERS["social.publish.v2"](decision(null));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/needs the Starter plan/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("Starter: the post is frozen and queued as before", async () => {
    tenantPlan.tier = "starter";
    const res = await HANDLERS["social.publish.v2"](decision(null));
    expect(res.ok).toBe(true);
    expect(createArgs().p_channel).toBe("linkedin");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("an unreadable plan refuses the approval (it can be approved again)", async () => {
    tenantPlan.unreadable = true;
    const res = await HANDLERS["social.publish.v2"](decision(null));
    expect(res.ok).toBe(false);
    expect(mocks.rpc.mock.calls.some((c) => c[0] === "social_post_create")).toBe(false);
  });

  it("a malformed body is still the body error, not a plan answer", async () => {
    tenantPlan.tier = "free";
    const res = await HANDLERS["social.publish.v2"]({ ...decision(null), body: { payload: {} } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/requires \{channel, payload/);
  });
});

describe("social.publish.v2 with the rail paused", () => {
  it.each([
    ["the config switch is off", { data: false, error: null }],
    ["the switch cannot be read", { data: null, error: { message: "rpc down" } }],
  ])("refuses with code social_publish_paused and the old sentence when %s; no post row, no event", async (_label, gateRes) => {
    vi.stubEnv("SOCIAL_PUBLISH_LOCAL_OVERRIDE_TENANTS", "");
    try {
      mocks.rpc.mockImplementation(async (fn: string) => {
        if (fn === "_social_publish_enabled") return gateRes;
        if (fn === "social_post_create") return { data: "post-1", error: null };
        return { data: null, error: null };
      });
      const res = await HANDLERS["social.publish.v2"](decision(FUTURE));
      expect(res).toEqual({
        ok: false,
        code: "social_publish_paused",
        error: "Social publishing isn't enabled for your account yet.",
      });
      expect(mocks.rpc.mock.calls.some((c) => c[0] === "social_post_create")).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
