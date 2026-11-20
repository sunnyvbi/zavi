
import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const { send, logged } = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ["evt_1"] })),
  logged: [] as Array<{ level: string; code?: string }>,
}));

vi.mock("@/../workers/client", () => ({ inngest: { send } }));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async (i: { level: string; code?: string }) => {
    logged.push({ level: i.level, code: i.code });
  }),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn() }));
vi.mock("@/services/connectors/meta-ads/expiry", () => ({
  resolveTokenExpiry: vi.fn(),
  persistMetaAdsExpiry: vi.fn(),
}));

import { metaAdsDeauthorize } from "../meta-ads";

const SECRET = "meta-app-secret-for-tests";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function signedRequest(payload: Record<string, unknown>, secret = SECRET): string {
  const payloadPart = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
  return `${b64url(sig)}.${payloadPart}`;
}

const VALID = { algorithm: "HMAC-SHA256", issued_at: 1_780_000_000, user_id: "998877" };

type Captured = { status: number; body: unknown };

function mockRes(): { res: Response; out: Captured } {
  const out: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

function mockReq(body: unknown): Request {
  return { body } as unknown as Request;
}

beforeEach(() => {
  send.mockClear();
  send.mockResolvedValue({ ids: ["evt_1"] });
  logged.length = 0;
  process.env.META_APP_SECRET = SECRET;
});

describe("verified callback", () => {
  it("enqueues the token-health sweep and answers 200", async () => {
    const { res, out } = mockRes();
    await metaAdsDeauthorize(mockReq({ signed_request: signedRequest(VALID) }), res);

    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ name: "meta_ads.deauthorized", data: {} });
  });

  it("never puts the app-scoped user id in the log meta", async () => {
    const { res } = mockRes();
    await metaAdsDeauthorize(mockReq({ signed_request: signedRequest(VALID) }), res);

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(VALID.user_id);
    expect(logged.some((l) => l.code === "meta_ads.deauthorized")).toBe(true);
  });
});

describe("rejects unverified callers without dispatching", () => {
  it.each([
    ["a signature from a different secret", { signed_request: signedRequest(VALID, "other") }],
    ["a missing signed_request field", {}],
    ["a non-string signed_request", { signed_request: 42 }],
    ["a malformed signed_request", { signed_request: "garbage" }],
    ["an undefined body", undefined],
  ])("401s on %s and does not enqueue", async (_label, body) => {
    const { res, out } = mockRes();
    await metaAdsDeauthorize(mockReq(body), res);

    expect(out.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    expect(logged.some((l) => l.code === "meta_ads.deauthorize_bad_signature")).toBe(true);
  });

  it("401s on an algorithm downgrade even with a correct HMAC", async () => {
    const { res, out } = mockRes();
    await metaAdsDeauthorize(
      mockReq({ signed_request: signedRequest({ ...VALID, algorithm: "none" }) }),
      res,
    );

    expect(out.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("degraded configuration", () => {
  it("503s (not 200) when META_APP_SECRET is unset, so we never ack what we cannot read", async () => {
    delete process.env.META_APP_SECRET;
    const { res, out } = mockRes();
    await metaAdsDeauthorize(mockReq({ signed_request: signedRequest(VALID) }), res);

    expect(out.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it("500s when the dispatch fails, so Meta's retry has a chance to redeliver", async () => {
    send.mockRejectedValueOnce(new Error("inngest down"));
    const { res, out } = mockRes();
    await metaAdsDeauthorize(mockReq({ signed_request: signedRequest(VALID) }), res);

    expect(out.status).toBe(500);
    expect(logged.some((l) => l.code === "meta_ads.deauthorize_dispatch_failed")).toBe(true);
  });
});
