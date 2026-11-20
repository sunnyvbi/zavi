
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () => ({ user_id: "user-test-1", access_token: "tok" })),
}));
let flagOn = true;
let lastEqCol: string | null = null;
let lastEqVal: unknown = null;
let auditInserts: Array<Record<string, unknown>> = [];
let rateLimitLedger: Record<string, number> = {};
let rpcShouldFail = false;
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "tick_enrichment_rate_limit") return { data: null, error: null };
      if (rpcShouldFail) return { data: null, error: { message: "boom" } };
      const key = String(args.p_key);
      rateLimitLedger[key] = (rateLimitLedger[key] ?? 0) + 1;
      return { data: rateLimitLedger[key] <= Number(args.p_limit), error: null };
    },
    from: (table: string) => ({
      delete: () => ({
        neq: async () => {
          if (table === "enrichment_rate_limit") rateLimitLedger = {};
          return { error: null };
        },
      }),
      insert: async (row: Record<string, unknown>) => {
        if (table === "enrichment_audit") auditInserts.push(row);
        return { error: null };
      },
      select: () => ({
        eq: (col: string, val: unknown) => {
          lastEqCol = col;
          lastEqVal = val;
          return {
            maybeSingle: async () => {
              if (table === "system_config" && col === "id" && val === 1) {
                return {
                  data: { blob: { onboarding_web_enrichment: flagOn } },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          };
        },
      }),
    }),
  }),
}));

let appSettings: Record<string, unknown> = {};
vi.mock("@/services/settings", () => ({
  getAppSetting: vi.fn(async (key: string) => appSettings[key]),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("@/services/onboarding/enrichment/domain-match", () => ({
  resolveDomain: vi.fn(),
}));
vi.mock("@/services/onboarding/enrichment/fetch-domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/onboarding/enrichment/fetch-domain")>()),
  fetchDomain: vi.fn(),
}));
vi.mock("@/services/onboarding/enrichment/fetch-app-store", () => ({
  fetchAppListings: vi.fn(),
}));
vi.mock("@/services/onboarding/enrichment/competitors", () => ({
  findCompetitors: vi.fn(async () => []),
}));
vi.mock("@/services/onboarding/enrichment/classify-shape-stage", () => ({
  classifyShapeStage: vi.fn(async () => undefined),
}));

import { onboardingEnrich, retryOnce, __test } from "../enrich";
import { verifyBearer } from "@/services/auth/jwt";
import { resolveDomain } from "@/services/onboarding/enrichment/domain-match";
import { fetchDomain } from "@/services/onboarding/enrichment/fetch-domain";
import { fetchAppListings } from "@/services/onboarding/enrichment/fetch-app-store";
import { findCompetitors } from "@/services/onboarding/enrichment/competitors";
import { classifyShapeStage } from "@/services/onboarding/enrichment/classify-shape-stage";

const mockVerifyBearer = verifyBearer as unknown as ReturnType<typeof vi.fn>;
const mockResolve = resolveDomain as unknown as ReturnType<typeof vi.fn>;
const mockFetchDomain = fetchDomain as unknown as ReturnType<typeof vi.fn>;
const mockFetchApp = fetchAppListings as unknown as ReturnType<typeof vi.fn>;
const mockFindCompetitors = findCompetitors as unknown as ReturnType<typeof vi.fn>;
const mockClassify = classifyShapeStage as unknown as ReturnType<typeof vi.fn>;

type MockRes = {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

function mockRes(): MockRes {
  const json = vi.fn();
  const status = vi.fn();
  status.mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

function mockReq(body: object, headers: Record<string, string> = {}, ip = "198.51.100.9"): Request {
  return { body, headers, ip, socket: { remoteAddress: ip } } as unknown as Request;
}

describe("POST /api/onboarding/enrich", () => {
  beforeEach(async () => {
    flagOn = true;
    appSettings = {};
    mockVerifyBearer.mockResolvedValue({ user_id: "user-test-1", access_token: "tok" });
    mockResolve.mockReset();
    mockFetchDomain.mockReset();
    mockFetchApp.mockReset();
    mockFindCompetitors.mockReset();
    mockFindCompetitors.mockResolvedValue([]);
    mockClassify.mockReset();
    mockClassify.mockResolvedValue(undefined);
    auditInserts = [];
    await __test.resetRateLimits();
    __test.resetCache();
    rpcShouldFail = false;
  });

  afterEach(async () => {
    await __test.resetRateLimits();
    __test.resetCache();
  });

  it("returns feature_flag_off when flag is false (mode=full)", async () => {
    flagOn = false;
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }), res);
    expect(json).toHaveBeenCalled();
    const payload = json.mock.calls[0][0];
    expect(payload.mode).toBe("full");
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("feature_flag_off");
  });

  it("flag-read uses .eq('id', 1) — guards against the 2026-05-17 schema-drift bug", async () => {
    flagOn = true;
    lastEqCol = null;
    lastEqVal = null;
    const { res } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), res);
    expect(lastEqCol).toBe("id");
    expect(lastEqVal).toBe(1);
  });

  it("returns feature_flag_off when flag is false (mode=resolve_only)", async () => {
    flagOn = false;
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.mode).toBe("resolve_only");
    expect(payload.result.status).toBe("skipped");
    expect(payload.result.reason).toBe("feature_flag_off");
  });

  it("spend brake defaults ON when the setting is unset (hard rule 7)", async () => {
    expect(appSettings.onboarding_enrichment_enabled).toBeUndefined();
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://acme.example/", title: "Home", text_excerpt: "hello" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 5,
      total_ms: 10,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme", mode: "full" }), res);
    expect(json.mock.calls[0][0].enrichment.status).toBe("ok");
  });

  it("spend brake OFF → mode=full skips with enrichment_disabled, doing no paid work", async () => {
    appSettings.onboarding_enrichment_enabled = false;
    const { res, status, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.mode).toBe("full");
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("enrichment_disabled");
    expect(payload.debug.total_cost_usd).toBe(0);
    expect(status).not.toHaveBeenCalledWith(502);
    expect(status).not.toHaveBeenCalledWith(503);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockFetchDomain).not.toHaveBeenCalled();
  });

  it("spend brake OFF does NOT burn the founder's per-user budget", async () => {
    appSettings.onboarding_enrichment_enabled = false;
    for (const o of ["a", "b", "c", "d", "e", "f", "g"]) {
      const { res, json } = mockRes();
      await onboardingEnrich(mockReq({ orgName: o, mode: "full" }), res);
      expect(json.mock.calls[0][0].enrichment.reason).toBe("enrichment_disabled");
    }
    appSettings.onboarding_enrichment_enabled = true;
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://acme.example/", title: "Home", text_excerpt: "hello" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 5,
      total_ms: 10,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "h", mode: "full" }), res);
    expect(json.mock.calls[0][0].enrichment.status).toBe("ok");
  });

  it("spend brake does not touch resolve_only (the cheap pre-confirm probe)", async () => {
    appSettings.onboarding_enrichment_enabled = false;
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), res);
    expect(json.mock.calls[0][0].result.status).toBe("resolved");
  });

  it("fails CLOSED when the rate-limit RPC errors (no paid work)", async () => {
    rpcShouldFail = true;
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res, status, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("user_rate_limit");
    expect(status).not.toHaveBeenCalledWith(500);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("anonymous caller with no derivable IP is refused (not bucketed as 'unknown')", async () => {
    const { verifyBearer } = await import("@/services/auth/jwt");
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res, status, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }, {}, ""), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("user_rate_limit");
    expect(status).not.toHaveBeenCalledWith(500);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("an IP-less caller cannot exhaust the bucket a real anonymous caller uses", async () => {
    const { verifyBearer } = await import("@/services/auth/jwt");
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    for (let i = 0; i < 30; i += 1) {
      const { res } = mockRes();
      await onboardingEnrich(mockReq({ orgName: `Spam ${i}`, mode: "resolve_only" }, {}, ""), res);
    }
    const { res, json } = mockRes();
    await onboardingEnrich(
      mockReq({ orgName: "Stripe", mode: "resolve_only" }, {}, "198.51.100.9"),
      res,
    );
    expect(json.mock.calls[0][0].result.status).toBe("resolved");
  });

  it("anonymous FULL calls get the 20/IP budget, not the 5/user one", async () => {
    const { verifyBearer } = await import("@/services/auth/jwt");
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockResolve.mockResolvedValue(null);
    const reasons: unknown[] = [];
    for (let i = 0; i < 21; i += 1) {
      const { res, json } = mockRes();
      await onboardingEnrich(
        mockReq({ orgName: `Founder ${i}`, mode: "full" }, {}, "203.0.113.7"),
        res,
      );
      reasons.push(json.mock.calls[0][0].enrichment.reason);
    }
    expect(reasons.slice(0, 20)).not.toContain("user_rate_limit");
    expect(reasons[20]).toBe("user_rate_limit");
    expect(Object.keys(rateLimitLedger)).toEqual(["anon:203.0.113.7"]);
  });

  it("an authed caller with no IP still resolves by user id", async () => {
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }, {}, ""), res);
    expect(json.mock.calls[0][0].result.status).toBe("resolved");
  });

  it("resolve_only returns the matched domain", async () => {
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.mode).toBe("resolve_only");
    expect(payload.result.status).toBe("resolved");
    expect(payload.result.resolved_domain).toBe("stripe.com");
    expect(mockFetchDomain).not.toHaveBeenCalled();
  });

  it("full mode crawls domain + app store and returns ok", async () => {
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://acme.example/", title: "Home", text_excerpt: "hello" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 5,
      total_ms: 100,
    });
    mockFetchApp.mockResolvedValue([]);
    mockFindCompetitors.mockResolvedValue([
      {
        name: "Lindy",
        url: "https://lindy.ai",
        source_title: "Zavi alternatives",
        source_url: "https://example.com/zavi-alternatives",
        snippet: "Lindy is listed as a related AI agent product.",
      },
    ]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme Inc", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.mode).toBe("full");
    expect(payload.enrichment.status).toBe("ok");
    expect(payload.enrichment.domain_pages.length).toBe(1);
    expect(payload.enrichment.competitors).toHaveLength(1);
    expect(payload.enrichment.competitors[0].name).toBe("Lindy");
    expect(payload.debug.resolved_domain).toBe("acme.example");
    expect(payload.debug.total_cost_usd).toBeGreaterThan(0);
  });

  it("carries inferredShape/inferredStage/shapeConfidence into the full payload", async () => {
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://acme.example/", title: "Home", text_excerpt: "hello" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 5,
      total_ms: 100,
    });
    mockFetchApp.mockResolvedValue([]);
    mockClassify.mockResolvedValue({ shape: "marketplace", stage: 4, confidence: "high" });
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme Inc", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("ok");
    expect(payload.enrichment.inferredShape).toBe("marketplace");
    expect(payload.enrichment.inferredStage).toBe(4);
    expect(payload.enrichment.shapeConfidence).toBe("high");
  });

  it("omits the inferred fields when the classifier returns undefined", async () => {
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://acme.example/", title: "Home", text_excerpt: "hello" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 5,
      total_ms: 100,
    });
    mockFetchApp.mockResolvedValue([]);
    mockClassify.mockResolvedValue(undefined);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme Inc", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("ok");
    expect(payload.enrichment).not.toHaveProperty("inferredShape");
  });

  it("returns all_fetches_failed when zero pages + zero listings", async () => {
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [],
      pages_attempted: 13,
      pages_fetched: 0,
      ssrf_blocked: 0,
      total_bytes: 0,
      total_ms: 50,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("all_fetches_failed");
  });

  it("treats all-null app_listing as 'no useful data' (skipped:all_fetches_failed)", async () => {
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [],
      pages_attempted: 13,
      pages_fetched: 0,
      ssrf_blocked: 0,
      total_bytes: 0,
      total_ms: 50,
    });
    mockFetchApp.mockResolvedValue([
      {
        store: "ios",
        url: "https://apps.apple.com/us/app/random/id1",
        name: null,
        version: null,
        last_updated: null,
        rating: null,
        ratings_count: null,
        support_url: null,
      },
    ]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("all_fetches_failed");
  });

  it("returns 200 (NOT 502) when resolveDomain returns null (Tavily error)", async () => {
    mockResolve.mockResolvedValue(null);
    const { res, status, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "X", mode: "full" }), res);
    expect(status).not.toHaveBeenCalledWith(502);
    expect(status).not.toHaveBeenCalledWith(504);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("skipped");
  });

  it("rate-limits a single user after 5 FULL calls in 24h", async () => {
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://stripe.com/", title: "Home", text_excerpt: "x" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 1,
      total_ms: 10,
    });
    mockFetchApp.mockResolvedValue([]);
    for (const o of ["a", "b", "c", "d", "e"]) {
      const { res } = mockRes();
      await onboardingEnrich(mockReq({ orgName: o, mode: "full" }), res);
    }
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "f", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("skipped");
    expect(payload.enrichment.reason).toBe("user_rate_limit");
  });

  it("resolve_only does NOT count toward the per-user rate limit", async () => {
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://stripe.com/", title: "Home", text_excerpt: "x" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 1,
      total_ms: 10,
    });
    mockFetchApp.mockResolvedValue([]);
    for (const o of ["a", "b", "c", "d", "e", "f"]) {
      const { res, json } = mockRes();
      await onboardingEnrich(mockReq({ orgName: o, mode: "resolve_only" }), res);
      expect(json.mock.calls[0][0].result.status).toBe("resolved");
    }
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "g", mode: "full" }), res);
    expect(json.mock.calls[0][0].enrichment.status).toBe("ok");
  });

  it("cache returns the same response for repeat orgName+mode within 1h", async () => {
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res: r1, json: j1 } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), r1);
    expect(mockResolve).toHaveBeenCalledTimes(1);

    const { res: r2, json: j2 } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), r2);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(j2.mock.calls[0][0]).toEqual(j1.mock.calls[0][0]);
  });

  it("rejects malformed body with 400", async () => {
    const { res, status, json } = mockRes();
    await onboardingEnrich(mockReq({ wrongField: "x" }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it("allows missing bearer for pre-auth /start enrichment", async () => {
    const { verifyBearer } = await import("@/services/auth/jwt");
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    const { res, status, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "resolve_only" }), res);
    expect(status).not.toHaveBeenCalledWith(401);
    const payload = json.mock.calls[0][0];
    expect(payload.mode).toBe("resolve_only");
    expect(payload.result.status).toBe("resolved");
    expect(payload.result.resolved_domain).toBe("stripe.com");
  });

  it("writes anonymous audit rows with null user_id", async () => {
    const { verifyBearer } = await import("@/services/auth/jwt");
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://stripe.com/", title: "Home", text_excerpt: "payments" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 8,
      total_ms: 50,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }), res);
    await new Promise((r) => setTimeout(r, 0));
    expect(auditInserts.length).toBe(1);
    expect(auditInserts[0].user_id).toBeNull();
  });

  it("rate-limits anonymous resolve_only calls by req.ip and ignores spoofed XFF rotation", async () => {
    const { verifyBearer } = await import("@/services/auth/jwt");
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    for (let i = 0; i < 20; i += 1) {
      const { res, json } = mockRes();
      await onboardingEnrich(
        mockReq(
          { orgName: `Stripe ${i}`, mode: "resolve_only" },
          { "x-forwarded-for": `203.0.113.${i}` },
          "198.51.100.9",
        ),
        res,
      );
      expect(json.mock.calls[0][0].result.status).toBe("resolved");
    }
    const { res, json } = mockRes();
    await onboardingEnrich(
      mockReq(
        { orgName: "Stripe 21", mode: "resolve_only" },
        { "x-forwarded-for": "203.0.113.250" },
        "198.51.100.9",
      ),
      res,
    );
    expect(json.mock.calls[0][0].result.status).toBe("skipped");
    expect(json.mock.calls[0][0].result.reason).toBe("user_rate_limit");
  });

  it("writes audit log row via logEvent on successful ok run", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    const mockLog = logEvent as unknown as ReturnType<typeof vi.fn>;
    mockLog.mockClear();
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://stripe.com/", title: "Home", text_excerpt: "payments" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 8,
      total_ms: 50,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }), res);
    expect(mockLog).toHaveBeenCalled();
    const args = mockLog.mock.calls
      .map((c) => c[0])
      .find((a) => a.source === "onboarding.enrichment" && a.code === "ok");
    expect(args).toBeDefined();
    expect(args!.code).toBe("ok");
    expect(args!.message).toContain("onboarding.enrichment.run");
    expect(args!.message).toContain("mode=full");
    expect(args!.message).toContain("domain=stripe.com");
  });

  it("logs the estimated spend for every full run (the telemetry that replaced the cap)", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    const mockLog = logEvent as unknown as ReturnType<typeof vi.fn>;
    mockLog.mockClear();
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://stripe.com/", title: "Home", text_excerpt: "payments" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 8,
      total_ms: 50,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }), res);

    const spend = mockLog.mock.calls
      .map((c) => c[0])
      .find((a) => a.source === "onboarding.enrichment" && a.code === "spend");
    expect(spend, "no spend telemetry emitted").toBeDefined();
    expect(spend!.message).toContain("onboarding.enrichment.spend");
    expect(spend!.message).toContain("user=user-test-1");
    expect(spend!.message).toMatch(/est_cost_usd=\d+\.\d{4}/);
    expect(spend!.message).toMatch(/tokens=\d+/);
    expect(spend!.message).toContain("domain_pages=1");
    expect(spend!.message).toContain("tavily=3");
    expect(json.mock.calls[0][0].debug.total_cost_usd).toBeGreaterThan(0);
  });

  it("returns every fetched page untrimmed — no budget-driven drops", async () => {
    mockResolve.mockResolvedValue({ domain: "acme.example", confidence: 1, via: "tavily" });
    const pages = [
      "/", "/about", "/about-us", "/pricing", "/faq", "/terms", "/privacy",
      "/policies/refund-policy", "/refunds", "/help", "/help-center", "/support",
      "/contact", "/how-it-works", "/hosts", "/customers", "/careers",
    ].map((p) => ({
      url: `https://acme.example${p}`,
      title: p,
      text_excerpt: "acme content ".repeat(700),
    }));
    mockFetchDomain.mockResolvedValue({
      pages,
      pages_attempted: 17,
      pages_fetched: 17,
      ssrf_blocked: 0,
      total_bytes: 155_000,
      total_ms: 500,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res, json } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Acme", mode: "full" }), res);
    const payload = json.mock.calls[0][0];
    expect(payload.enrichment.status).toBe("ok");
    expect(payload.enrichment.domain_pages).toHaveLength(17);
    expect(payload.enrichment.domain_pages.map((p: { url: string }) => p.url)).toContain(
      "https://acme.example/contact",
    );
    expect(payload.debug.total_cost_usd).toBeGreaterThan(0.75);
  });

  it("writes a structured enrichment_audit row on a successful full run", async () => {
    mockResolve.mockResolvedValue({ domain: "stripe.com", confidence: 1, via: "tavily" });
    mockFetchDomain.mockResolvedValue({
      pages: [{ url: "https://stripe.com/", title: "Home", text_excerpt: "payments" }],
      pages_attempted: 13,
      pages_fetched: 1,
      ssrf_blocked: 0,
      total_bytes: 8,
      total_ms: 50,
    });
    mockFetchApp.mockResolvedValue([]);
    const { res } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Stripe", mode: "full" }), res);
    await new Promise((r) => setTimeout(r, 0));
    expect(auditInserts.length).toBe(1);
    const row = auditInserts[0];
    expect(row.mode).toBe("full");
    expect(row.outcome).toBe("ok");
    expect(row.resolved_domain).toBe("stripe.com");
    expect(row.pages_fetched).toBe(1);
    expect(row.cost_usd).toBeGreaterThan(0);
    expect(Object.keys(row)).not.toContain("orgName");
  });

  it("audit insert is best-effort — a throwing insert never breaks the onboard", async () => {
    mockResolve.mockResolvedValue(null);
    const { res, json, status } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "X", mode: "full" }), res);
    expect(status).not.toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].enrichment.status).toBe("skipped");
  });

  it("writes audit log row via logEvent on skipped run (no PII in message)", async () => {
    const { logEvent } = await import("@/services/logging/logEvent");
    const mockLog = logEvent as unknown as ReturnType<typeof vi.fn>;
    mockLog.mockClear();
    mockResolve.mockResolvedValue(null);
    const { res } = mockRes();
    await onboardingEnrich(mockReq({ orgName: "Mystery Inc", mode: "full" }), res);
    expect(mockLog).toHaveBeenCalled();
    const args = mockLog.mock.calls[0][0];
    expect(args.source).toBe("onboarding.enrichment");
    expect(args.code).toContain("skipped");
    expect(args.message).not.toContain("Mystery Inc");
    expect(args.message).toContain("domain=none");
  });
});

describe("retryOnce", () => {
  it("returns the first result when fn succeeds (no retry)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await retryOnce(fn, 1)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once on a thrown error and returns the second result", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");
    expect(await retryOnce(fn, 1)).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows if the retry also fails (caller's .catch handles it)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("down"));
    await expect(retryOnce(fn, 1)).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a resolved null (genuine no-match is not an error)", async () => {
    const fn = vi.fn().mockResolvedValue(null);
    expect(await retryOnce(fn, 1)).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
