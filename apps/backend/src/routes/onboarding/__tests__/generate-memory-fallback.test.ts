
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();
const logEventMock = vi.fn(async (_input: unknown) => {});

vi.mock("@/services/anthropic", () => ({
  createMessageWithFailover: (...args: unknown[]) => createMock(...args),
  hasAnthropicAuth: () => true,
  DEFAULT_MODEL: "claude-sonnet-4-6",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () => ({ user_id: "user-1", access_token: "tok" })),
}));

vi.mock("@/services/auth/closedBetaGate", () => ({
  requireClosedBetaGrant: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { blob: {} }, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (input: unknown) => logEventMock(input),
}));

import { onboardingGenerateMemory } from "../generate-memory";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res as unknown as import("express").Response & { statusCode: number; body: any };
}

const okMemory = `<memory>${JSON.stringify({
  company: "# Company\n\nWe do X.",
  ops: "# Ops\n\nY.",
  policies: "# Policies\n\nZ.",
  disputes: "# Disputes\n\nA.",
  support: "# Support\n\nB.",
})}</memory>`;

function body(enrichment?: unknown) {
  return {
    wizard: {
      role: "",
      marketplaceShape: "saas",
      stage: 1,
      orgName: "Acme",
      website: "acme.com",
      customerId: "acme",
      freeText: "We sell scheduling software to dentists.",
    },
    enrichment,
  };
}

async function run(payload: unknown) {
  const req = { body: payload, headers: {} } as unknown as import("express").Request;
  const res = mockRes();
  await onboardingGenerateMemory(req, res);
  return res;
}

describe("onboardingGenerateMemory — save resilience", () => {
  beforeEach(() => {
    createMock.mockReset();
    logEventMock.mockClear();
  });

  it("uses createMessageWithFailover and returns the model memory on success", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: okMemory }] });
    const res = await run(body());
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.memory.company).toBe("# Company\n\nWe do X.");
    expect(res.body.fallback).toBeUndefined();
  });

  it("429 after failover -> 200 with deterministic fallback memory, logged", async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error("rate_limit_error"), { status: 429, name: "RateLimitError" }),
    );
    const res = await run(body());
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fallback).toBe(true);
    expect(res.body.anchor_candidates).toEqual([]);
    const m = res.body.memory;
    for (const k of ["company", "ops", "policies", "disputes", "support"]) {
      expect(typeof m[k]).toBe("string");
      expect(m[k].length).toBeGreaterThan(0);
    }
    expect(m.company).toContain("Acme");
    expect(m.company).toContain("acme.com");
    expect(m.company).toContain("scheduling software to dentists");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "onboarding.generate_memory.fallback",
        meta: { failure_class: "upstream_error", error_class: "RateLimitError", http_status: 429 },
      }),
    );
  });

  it.each([401, 403, 404])(
    "non-retryable %i -> 502, no fallback, logged at error level (config breakage stays visible)",
    async (status) => {
      createMock.mockRejectedValue(
        Object.assign(new Error("auth"), { status, name: "AuthenticationError" }),
      );
      const res = await run(body());
      expect(res.statusCode).toBe(502);
      expect(res.body.fallback).toBeUndefined();
      expect(res.body.memory).toBeUndefined();
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          code: "onboarding.generate_memory.config_error",
          meta: { failure_class: "config_error", error_class: "AuthenticationError", http_status: status },
        }),
      );
    },
  );

  it("400 (e.g. oversized user payload), 5xx and a status-less timeout still fall back", async () => {
    createMock.mockRejectedValueOnce(Object.assign(new Error("prompt is too long"), { status: 400, name: "BadRequestError" }));
    expect((await run(body())).body.fallback).toBe(true);
    createMock.mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));
    expect((await run(body())).body.fallback).toBe(true);
    createMock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" }));
    expect((await run(body())).body.fallback).toBe(true);
  });

  it("unparseable output on both attempts -> fallback 200", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "no tags here" }] });
    const res = await run(body());
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body.fallback).toBe(true);
  });

  it("fallback includes the sanitized scan description when present", async () => {
    createMock.mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    const res = await run(
      body({
        status: "ok",
        domain_pages: [],
        app_listings: [],
        description: "Acme builds booking tools for dental clinics.",
      }),
    );
    expect(res.body.fallback).toBe(true);
    expect(res.body.memory.company).toContain("booking tools for dental clinics");
  });

  it.each(["request_failed", "enrichment_disabled"])(
    "accepts enrichment skipped reason %s (no 400)",
    async (reason) => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: okMemory }] });
      const res = await run(body({ status: "skipped", reason }));
      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
    },
  );
});
