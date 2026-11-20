import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
const h = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn(), verify: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  signupLocationClient: () => ({
    auth: { admin: { getUserById: h.user } },
    rpc: h.rpc,
  }),
}));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: h.verify }));
import { signupLocation, verifySignupLocationTicket } from "../signup-location";
const secret = "local-test-secret-not-real-credentials-123456",
  id = "10000000-0000-4000-8000-000000000001";
function ticket(over: object = {}) {
  const payload = JSON.stringify({
    email_hash: createHash("sha256").update("user@example.com").digest("hex"),
    country: "IN",
    city: "Pune",
    issued_at: new Date().toISOString(),
    nonce: id,
    ...over,
  });
  return {
    payload,
    signature: createHmac("sha256", secret).update(payload).digest("hex"),
  };
}
function res() {
  const r = {
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
  };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
}
afterEach(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv("SIGNUP_LOCATION_SIGNING_SECRET", secret);
  h.user.mockReset();
  h.rpc.mockReset();
  h.verify.mockReset();
  h.verify.mockResolvedValue(null);
  h.rpc.mockResolvedValue({ error: null });
});
it("rejects forged, malformed and expired tickets", () => {
  const t = ticket();
  expect(verifySignupLocationTicket(t.payload, t.signature, secret)?.city).toBe(
    "Pune",
  );
  expect(
    verifySignupLocationTicket(
      t.payload.replace("Pune", "Delhi"),
      t.signature,
      secret,
    ),
  ).toBeNull();
  expect(verifySignupLocationTicket(t.payload, "garbage", secret)).toBeNull();
  const old = ticket({ issued_at: new Date(Date.now() - 61000).toISOString() });
  expect(
    verifySignupLocationTicket(old.payload, old.signature, secret),
  ).toBeNull();
});
it("supports unconfirmed signup only with the ticket embedded in that exact identity", async () => {
  const t = ticket();
  h.user.mockResolvedValue({
    data: {
      user: {
        id,
        email: "user@example.com",
        created_at: new Date().toISOString(),
        user_metadata: { growth_signup_location_ticket: t.signature },
      },
    },
  });
  const r = res();
  await signupLocation({ body: { user_id: id, ...t } } as Request, r);
  expect(h.rpc).toHaveBeenCalledWith(
    "record_admin_growth_signup_location",
    expect.objectContaining({ p_user_id: id, p_city: "Pune" }),
  );
  expect(r.status).toHaveBeenCalledWith(204);
});
it("rejects another user even with a valid location signature", async () => {
  const t = ticket();
  h.user.mockResolvedValue({
    data: {
      user: {
        id,
        email: "other@example.com",
        created_at: new Date().toISOString(),
        user_metadata: { growth_signup_location_ticket: t.signature },
      },
    },
  });
  await signupLocation({ body: { user_id: id, ...t } } as Request, res());
  expect(h.rpc).not.toHaveBeenCalled();
});
it("requires the matching verified JWT for a new OAuth user", async () => {
  const t = ticket();
  h.user.mockResolvedValue({
    data: {
      user: {
        id,
        email: "user@example.com",
        created_at: new Date().toISOString(),
        user_metadata: {},
      },
    },
  });
  await signupLocation({ body: { user_id: id, ...t } } as Request, res());
  expect(h.rpc).not.toHaveBeenCalled();
  h.verify.mockResolvedValue({ user_id: id });
  await signupLocation({ body: { user_id: id, ...t } } as Request, res());
  expect(h.rpc).toHaveBeenCalledTimes(1);
});
it("never relocates an existing account", async () => {
  const t = ticket();
  h.user.mockResolvedValue({
    data: {
      user: {
        id,
        email: "user@example.com",
        created_at: "2025-01-01T00:00:00Z",
        user_metadata: { growth_signup_location_ticket: t.signature },
      },
    },
  });
  await signupLocation({ body: { user_id: id, ...t } } as Request, res());
  expect(h.rpc).not.toHaveBeenCalled();
});
