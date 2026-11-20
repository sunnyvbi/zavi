import { createHash, createHmac } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
const h = vi.hoisted(() => ({ send: vi.fn(), rpc: vi.fn() }));
vi.mock("@/email/sendAuthEmail", () => ({ sendOtpEmail: h.send }));
vi.mock("@/services/tenant-client", () => ({
  signupLocationClient: () => ({ rpc: h.rpc }),
}));
import { authEmailSendOtp } from "../send-otp";
const key = "isolated-test-only-signing-secret-123456789";
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
beforeEach(() => {
  h.rpc.mockReset();
  h.send.mockReset();
  h.rpc.mockResolvedValue({ error: null });
  h.send.mockImplementation(async (_email, created) => {
    if (created) await created("new-auth-id");
    return { sent: true };
  });
  vi.stubEnv("SIGNUP_LOCATION_SIGNING_SECRET", key);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
it("ties OTP signup location to the identity the auth service just created", async () => {
  const payload = JSON.stringify({
    email_hash: createHash("sha256").update("user@example.com").digest("hex"),
    country: "IN",
    city: "Pune",
    issued_at: new Date().toISOString(),
    nonce: "10000000-0000-4000-8000-000000000001",
  });
  const signature = createHmac("sha256", key).update(payload).digest("hex");
  await authEmailSendOtp(
    {
      body: {
        email: "user@example.com",
        location_ticket: { payload, signature },
      },
    } as Request,
    res(),
  );
  expect(h.rpc).toHaveBeenCalledWith(
    "record_admin_growth_signup_location",
    expect.objectContaining({ p_user_id: "new-auth-id", p_country: "IN" }),
  );
});
it("ignores invalid geo claims while preserving OTP signup", async () => {
  const r = res();
  await authEmailSendOtp(
    {
      body: {
        email: "user@example.com",
        location_ticket: { payload: "forged", signature: "x" },
      },
    } as Request,
    r,
  );
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.send).toHaveBeenCalledWith("user@example.com");
  expect(r.status).toHaveBeenCalledWith(200);
});
