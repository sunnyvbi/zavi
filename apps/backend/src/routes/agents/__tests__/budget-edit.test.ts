
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  writeEnabled: vi.fn(),
  googleWriteEnabled: vi.fn(),
  googleCurrency: vi.fn(),
  enumerate: vi.fn(),
  currency: vi.fn(),
  fbGet: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  statusEqId: vi.fn(),
  statusEqTenant: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: (...idArgs: unknown[]) => {
          mocks.statusEqId(...idArgs);
          return {
            eq: (...tenArgs: unknown[]) => {
              mocks.statusEqTenant(...tenArgs);
              return { maybeSingle: mocks.maybeSingle };
            },
          };
        },
      }),
    }),
  }),
}));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({
  isMetaAdsWriteEnabled: () => mocks.writeEnabled(),
}));
vi.mock("@/services/tools/google-ads/write/_currency-guard", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/google-ads/write/_currency-guard")>()),
  readGoogleAccountCurrency: (t: string) => mocks.googleCurrency(t),
}));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({
  isGoogleAdsWriteEnabled: () => mocks.googleWriteEnabled(),
}));
vi.mock("@/services/tools/meta-ads/list_ad_sets", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enumerateCampaignAdSets: (...a: unknown[]) => mocks.enumerate(...a),
  };
});
vi.mock("@/services/tools/meta-ads/_client", () => ({
  getAdAccountCurrency: (...a: unknown[]) => mocks.currency(...a),
  fbGet: (...a: unknown[]) => mocks.fbGet(...a),
}));
vi.mock("@/services/tools/meta-ads/write/_fx-rate", () => ({
  unitsPerUsd: async (c: string) => (c === "USD" ? 1 : 80),
}));

import {
  performanceMarketerBudgetEdit,
  performanceMarketerPause,
  performanceMarketerCampaignStatus,
  performanceMarketerDecisionStatus,
} from "../budget-edit";
import { AUTHORIZED_EFFECTIVE_CAP } from "@/services/tools/meta-ads/write/_user-initiated";
import { googleSetStatusBodySchema } from "@/services/tools/google-ads/write/_decision-bodies";
import { planLegacyAdDecisions } from "@/services/growth/goal-owner";
import { cgoApproveAdDecision } from "@/services/growth/cgo-ads";

function makeReqRes(body: unknown) {
  const req = { headers: { authorization: "Bearer tok" }, body } as never;
  let jsonPayload: unknown;
  let statusCode = 200;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(p: unknown) {
      jsonPayload = p;
      return this;
    },
  } as never;
  return {
    req,
    res,
    get status() {
      return statusCode;
    },
    get body() {
      return jsonPayload as Record<string, unknown>;
    },
  };
}

const AUTH_OK = { tenant_id: "tenant-1", user_id: "user-1", access_token: "tok" };

function edgeAdSet(
  id: string,
  name: string,
  dailyMinor: string | null,
  extra: Record<string, unknown> = {},
) {
  return { id, name, daily_budget: dailyMinor, effective_status: "ACTIVE", ...extra };
}

describe("performanceMarketerBudgetEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(AUTH_OK);
    mocks.writeEnabled.mockResolvedValue(true);
    mocks.currency.mockResolvedValue("USD");
    mocks.fbGet.mockResolvedValue({ name: "Campaign" });
    mocks.rpc.mockResolvedValue({ data: "decision-id-1", error: null });
    mocks.maybeSingle.mockImplementation(async () => ({
      data: { status: "proposed", body: (mocks.rpc.mock.calls.at(-1)?.[1] as { p_body?: unknown } | undefined)?.p_body ?? null },
      error: null,
    }));
  });

  it("must-catch (security review): an emit that hands back a DIFFERENT open card is refused, never replied with its id", async () => {
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "A", "4000")]);
    mocks.maybeSingle.mockImplementationOnce(async () => ({ data: { status: "proposed", body: { ad_set_id: "a1", daily_budget_usd: 99 } }, error: null }));
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 50 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("different_change_open");
  });

  it("refuses with 409 when Meta write is disabled — never enumerates ad sets or emits", async () => {
    mocks.writeEnabled.mockResolvedValue(false);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 50 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("meta_ads_write_disabled");
    expect(mocks.enumerate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s an invalid body before any side effect", async () => {
    const ctx = makeReqRes({ campaign_id: "", proposed_daily_budget_usd: -5 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(400);
    expect(mocks.enumerate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a budget over the fat-finger ceiling", async () => {
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "A", "4000")]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 20000 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("an INR account stages the edit in rupees, with the ceiling read as rupees", async () => {
    mocks.currency.mockResolvedValue("INR");
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "A", "200000")]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 20000 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(200);
    const body = mocks.rpc.mock.calls[0][1].p_body as Record<string, unknown>;
    expect(body).toMatchObject({ daily_budget_usd: 20000, expected_current_daily_budget_usd: 2000, currency: "INR" });
    expect(ctx.body.currency).toBe("INR");

    mocks.rpc.mockClear();
    const tooBig = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 900_000 });
    await performanceMarketerBudgetEdit(tooBig.req, tooBig.res);
    expect(tooBig.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a CBO campaign stages the CAMPAIGN budget review class, read live, never enumerating ad sets", async () => {
    mocks.fbGet.mockResolvedValue({ name: "Spring CBO", daily_budget: "5000" });
    const ctx = makeReqRes({ campaign_id: "c9", proposed_daily_budget_usd: 80 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(200);
    expect(ctx.body.level).toBe("campaign");
    expect(mocks.enumerate).not.toHaveBeenCalled();
    expect(mocks.fbGet).toHaveBeenCalledWith("tenant-1", "c9", expect.anything());
    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_tenant_id).toBe("tenant-1");
    expect(args.p_decision_class).toBe("meta_ads.update_campaign_budget_review");
    expect(args.p_body).toMatchObject({
      campaign_id: "c9",
      daily_budget_usd: 80,
      expected_current_daily_budget_usd: 50,
      currency: "USD",
      over_cap: true,
      origin: "user_initiated_ledger",
      authorized_effective_cap: AUTHORIZED_EFFECTIVE_CAP,
      name: "Spring CBO",
    });
    expect((args.p_body as Record<string, unknown>).ad_set_id).toBeUndefined();
  });

  it("a campaign with a LIFETIME budget is refused without emitting", async () => {
    mocks.fbGet.mockResolvedValue({ name: "Launch", lifetime_budget: "900000" });
    const ctx = makeReqRes({ campaign_id: "c9", proposed_daily_budget_usd: 80 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("lifetime_budget");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a CBO campaign edit over the fat-finger ceiling is refused", async () => {
    mocks.fbGet.mockResolvedValue({ name: "Big", daily_budget: "5000" });
    const ctx = makeReqRes({ campaign_id: "c9", proposed_daily_budget_usd: 20_000 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses when neither the campaign nor any ad set holds a daily budget, without emitting", async () => {
    mocks.enumerate.mockResolvedValue([
      edgeAdSet("a1", "A", null),
      edgeAdSet("a2", "B", null),
    ]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 50 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("ambiguous_target");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses ambiguous target (multiple budgeted ad sets) without emitting", async () => {
    mocks.enumerate.mockResolvedValue([
      edgeAdSet("a1", "A", "3000"),
      edgeAdSet("a2", "B", "2000"),
    ]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 50 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("ambiguous_target");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("THE CODEX SCENARIO: 2 budgeted ad sets, only one with window spend → STILL refuses 409 ambiguous", async () => {
    mocks.enumerate.mockResolvedValue([
      edgeAdSet("a1", "Spent", "3000", { effective_status: "ACTIVE" }),
      edgeAdSet("a2", "Paused zero-spend", "2500", {
        effective_status: "PAUSED",
        configured_status: "PAUSED",
      }),
    ]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 50 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("ambiguous_target");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("counts a brand-new zero-spend ad set as a second budgeted ad set → refuses", async () => {
    mocks.enumerate.mockResolvedValue([
      edgeAdSet("a1", "Live", "3000"),
      edgeAdSet("a2", "Brand new", "1000", {
        effective_status: "PENDING_REVIEW",
        configured_status: "ACTIVE",
      }),
    ]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 50 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("excludes DELETED/ARCHIVED ad sets so a single LIVE budgeted ad set still resolves", async () => {
    mocks.enumerate.mockResolvedValue([
      edgeAdSet("a1", "Live", "3000"),
      edgeAdSet("a2", "Old", "9999", { effective_status: "ARCHIVED" }),
      edgeAdSet("a3", "Gone", "8888", { configured_status: "DELETED" }),
    ]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 45 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(200);
    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    const body = args.p_body as Record<string, unknown>;
    expect(body.ad_set_id).toBe("a1");
    expect(body.expected_current_daily_budget_usd).toBe(30);
  });

  it("refuses an ad account outside USD and INR (scale unverified) without emitting", async () => {
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "GB set", "3000")]);
    mocks.currency.mockResolvedValue("GBP");
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 45 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("unsupported_currency");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("502s when the ad-sets edge read fails — never emits", async () => {
    mocks.enumerate.mockRejectedValue(new Error("graph 500"));
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 45 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(502);
    expect((ctx.body.error as { code: string }).code).toBe("ad_sets_unavailable");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("emits the REVIEW class with the JWT tenant + user_initiated_ledger provenance on the happy path", async () => {
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "Bay Area", "3000")]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 45 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);

    expect(ctx.status).toBe(200);
    expect(ctx.body.ok).toBe(true);
    expect(ctx.body.decision_id).toBe("decision-id-1");

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("emit_decision");
    expect(args.p_tenant_id).toBe("tenant-1");
    expect(args.p_agent_run_id).toBeNull();
    expect(args.p_decision_class).toBe("meta_ads.update_ad_set_budget_review");
    const body = args.p_body as Record<string, unknown>;
    expect(body.ad_set_id).toBe("a1");
    expect(body.daily_budget_usd).toBe(45);
    expect(body.expected_current_daily_budget_usd).toBe(30);
    expect(body.over_cap).toBe(true);
    expect(body.campaign_id).toBe("c1");
    expect(body.origin).toBe("user_initiated_ledger");
    expect(body.authorized_effective_cap).toEqual(AUTHORIZED_EFFECTIVE_CAP);
  });

  it("re-derives the ad set from the AUTHED tenant (passes tenant_id into enumerate)", async () => {
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "X", "1000")]);
    const ctx = makeReqRes({ campaign_id: "c9", proposed_daily_budget_usd: 12 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    const [tenant, campaign] = mocks.enumerate.mock.calls[0] as [string, string];
    expect(tenant).toBe("tenant-1");
    expect(campaign).toBe("c9");
  });

  it("emits ONLY the never-auto-safe REVIEW class (never the plain auto budget class)", async () => {
    mocks.enumerate.mockResolvedValue([edgeAdSet("a1", "X", "3000")]);
    const ctx = makeReqRes({ campaign_id: "c1", proposed_daily_budget_usd: 60 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(args.p_decision_class).not.toBe("meta_ads.update_ad_set_budget");
  });
});

describe("performanceMarketerPause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(AUTH_OK);
    mocks.writeEnabled.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({ data: "decision-id-2", error: null });
  });

  it("refuses with 409 when Meta write is disabled — never emits", async () => {
    mocks.writeEnabled.mockResolvedValue(false);
    const ctx = makeReqRes({ campaign_id: "c1" });
    await performanceMarketerPause(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect((ctx.body.error as { code: string }).code).toBe("meta_ads_write_disabled");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s an invalid body before any side effect", async () => {
    const ctx = makeReqRes({ campaign_id: "" });
    await performanceMarketerPause(ctx.req, ctx.res);
    expect(ctx.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("pauses the CAMPAIGN (level=campaign, object_id=campaign_id) — unambiguous by construction", async () => {
    const ctx = makeReqRes({ campaign_id: "c1" });
    await performanceMarketerPause(ctx.req, ctx.res);

    expect(ctx.status).toBe(200);
    expect(ctx.body.ok).toBe(true);
    expect(ctx.body.decision_id).toBe("decision-id-2");
    expect(mocks.enumerate).not.toHaveBeenCalled();

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("emit_decision");
    expect(args.p_tenant_id).toBe("tenant-1");
    expect(args.p_agent_run_id).toBeNull();
    expect(args.p_decision_class).toBe("meta_ads.set_status_review");
    expect(args.p_decision_class).not.toBe("meta_ads.set_status");
    const body = args.p_body as Record<string, unknown>;
    expect(body.object_id).toBe("c1");
    expect(body.level).toBe("campaign");
    expect(body.status).toBe("PAUSED");
    expect(body.over_cap).toBe(true);
    expect(body.origin).toBe("user_initiated_ledger");
    expect(ctx.body.level).toBe("campaign");
    expect(ctx.body.campaign_id).toBe("c1");
  });
});

describe("performanceMarketerBudgetEdit: Google, USD accounts only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(AUTH_OK);
    mocks.googleWriteEnabled.mockResolvedValue(true);
  });

  it.each([
    ["EUR", 409, "google_ads_non_usd_account"],
    ["", 409, "google_ads_non_usd_account"],
  ] as const)("a %s account is refused before any Google read or staging", async (cur, code, errCode) => {
    mocks.googleCurrency.mockResolvedValue(cur);
    const ctx = makeReqRes({ channel: "google", campaign_id: "123", proposed_daily_budget_usd: 40 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(code);
    expect(ctx.body).toMatchObject({ error: { code: errCode } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("an unreadable currency is refused (fail closed)", async () => {
    mocks.googleCurrency.mockRejectedValue(new Error("google down"));
    const ctx = makeReqRes({ channel: "google", campaign_id: "123", proposed_daily_budget_usd: 40 });
    await performanceMarketerBudgetEdit(ctx.req, ctx.res);
    expect(ctx.status).toBe(502);
    expect(ctx.body).toMatchObject({ error: { code: "google_ads_currency_unverified" } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("performanceMarketerCampaignStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(AUTH_OK);
    mocks.writeEnabled.mockResolvedValue(true);
    mocks.googleWriteEnabled.mockResolvedValue(true);
    mocks.googleCurrency.mockResolvedValue("USD");
    mocks.rpc.mockResolvedValue({ data: "decision-status-1", error: null });
  });

  it("a Google enable on a non-USD account is refused before staging; a pause never reads the currency", async () => {
    mocks.googleCurrency.mockResolvedValue("EUR");
    const on = makeReqRes({ channel: "google", campaign_id: "123", enabled: true });
    await performanceMarketerCampaignStatus(on.req, on.res);
    expect(on.status).toBe(409);
    expect(on.body).toMatchObject({ error: { code: "google_ads_non_usd_account" } });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.googleCurrency.mockClear();
    const off = makeReqRes({ channel: "google", campaign_id: "123", enabled: false });
    await performanceMarketerCampaignStatus(off.req, off.res);
    expect(off.status).toBe(200);
    expect(mocks.googleCurrency).not.toHaveBeenCalled();
  });

  it("a Google enable whose account currency cannot be read is refused (fail closed)", async () => {
    mocks.googleCurrency.mockRejectedValue(new Error("google down"));
    const ctx = makeReqRes({ channel: "google", campaign_id: "123", enabled: true });
    await performanceMarketerCampaignStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(502);
    expect(ctx.body).toMatchObject({ error: { code: "google_ads_currency_unverified" } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["meta", true, "meta_ads.set_status_review", "ACTIVE"],
    ["meta", false, "meta_ads.set_status_review", "PAUSED"],
    ["google", true, "google_ads.set_status_review", "ENABLED"],
    ["google", false, "google_ads.set_status_review", "PAUSED"],
  ] as const)("stages a review decision for %s enabled=%s", async (channel, enabled, cls, status) => {
    const ctx = makeReqRes({
      channel,
      campaign_id: "123",
      campaign_name: "Spring sale",
      enabled,
    });
    await performanceMarketerCampaignStatus(ctx.req, ctx.res);

    expect(ctx.status).toBe(200);
    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_tenant_id).toBe("tenant-1");
    expect(args.p_decision_class).toBe(cls);
    expect(args.p_body).toMatchObject({ status, over_cap: true, name: "Spring sale", origin: "user_initiated_ledger" });
  });

  it("a founder-staged Google set_status_review is never approved by the CGO's sweep (origin user_initiated_ledger)", async () => {
    const ctx = makeReqRes({ channel: "google", campaign_id: "123", campaign_name: "Spring sale", enabled: true });
    await performanceMarketerCampaignStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(200);
    const [, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    const body = args.p_body as Record<string, unknown>;
    expect(body.origin).toBe("user_initiated_ledger");
    expect(googleSetStatusBodySchema.parse(body).origin).toBe("user_initiated_ledger");
    const row = (b: unknown) => ({ id: "d-1", decision_class: "google_ads.set_status_review", body: b, emitted_at: "2026-10-02T09:00:00Z", agent_run_id: null });
    const now = new Date("2026-10-02T10:00:00Z");
    expect(planLegacyAdDecisions([row(body)], now)).toEqual([]);
    const { origin: _o, ...unstamped } = body;
    expect(planLegacyAdDecisions([row(unstamped)], now).map((p) => p.act)).toEqual(["approve"]);
    expect(await cgoApproveAdDecision("tenant-1", "d-1", "google_ads.set_status_review", body)).toBe(false);
  });

  it("uses the matching platform gate", async () => {
    mocks.googleWriteEnabled.mockResolvedValue(false);
    const ctx = makeReqRes({ channel: "google", campaign_id: "123", enabled: false });
    await performanceMarketerCampaignStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(409);
    expect(mocks.writeEnabled).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric Google campaign id before emitting", async () => {
    const ctx = makeReqRes({ channel: "google", campaign_id: "bad-id", enabled: true });
    await performanceMarketerCampaignStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("performanceMarketerDecisionStatus", () => {
  const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  function statusReqRes(decisionId: string) {
    const req = {
      headers: { authorization: "Bearer tok" },
      params: { decision_id: decisionId },
    } as never;
    let jsonPayload: unknown;
    let statusCode = 200;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(p: unknown) {
        jsonPayload = p;
        return this;
      },
    } as never;
    return {
      req,
      res,
      get status() {
        return statusCode;
      },
      get body() {
        return jsonPayload as Record<string, unknown>;
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(AUTH_OK);
  });

  it("400s an invalid (non-uuid) decision id before any read", async () => {
    const ctx = statusReqRes("not-a-uuid");
    await performanceMarketerDecisionStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(400);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("returns status + dispatch_error for a decision owned by the authed tenant (filtered by id AND tenant_id)", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { status: "rejected", dispatch_error: "cap_refuse: no_cap_configured" },
      error: null,
    });
    const ctx = statusReqRes(UUID);
    await performanceMarketerDecisionStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(200);
    expect(ctx.body.status).toBe("rejected");
    expect(ctx.body.dispatch_error).toBe("cap_refuse: no_cap_configured");
    expect(mocks.statusEqId).toHaveBeenCalledWith("id", UUID);
    expect(mocks.statusEqTenant).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("404s a decision that is not found / belongs to another tenant (no cross-tenant leak)", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const ctx = statusReqRes(UUID);
    await performanceMarketerDecisionStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(404);
    expect((ctx.body.error as { code: string }).code).toBe("not_found");
  });

  it("normalizes a null dispatch_error to null on an in-flight decision", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { status: "proposed", dispatch_error: null },
      error: null,
    });
    const ctx = statusReqRes(UUID);
    await performanceMarketerDecisionStatus(ctx.req, ctx.res);
    expect(ctx.status).toBe(200);
    expect(ctx.body.status).toBe("proposed");
    expect(ctx.body.dispatch_error).toBeNull();
  });
});
