
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(),
}));

let upsertError: { message: string } | null = null;
let lastUpsertRow: Record<string, unknown> | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (_table: string) => ({
      upsert: async (row: Record<string, unknown>, _opts: unknown) => {
        lastUpsertRow = row;
        return { error: upsertError };
      },
    }),
  }),
}));

import { verifyBearer } from "@/services/auth/jwt";
import { redeemBetaSecret } from "@/routes/beta/redeem-secret";

function mockReqRes(body: unknown) {
  const req = { body } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe("POST /api/beta/redeem-secret", () => {
  const SECRET = "praxis-test-secret-aaaaaaaaaaaa";

  beforeEach(() => {
    upsertError = null;
    lastUpsertRow = null;
    process.env.BETA_INVITE_SECRET = SECRET;
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("happy path — valid key + authed → stamps profile + 200", async () => {
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user_id: "user-1",
      access_token: "tok",
    });
    const { req, res } = mockReqRes({ key: SECRET });
    await redeemBetaSecret(req, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(lastUpsertRow?.user_id).toBe("user-1");
    expect(typeof lastUpsertRow?.beta_invited_at).toBe("string");
  });

  it("invalid key → 400 invite_invalid (constant-time compared)", async () => {
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user_id: "user-1",
      access_token: "tok",
    });
    const { req, res } = mockReqRes({ key: "wrong-key-of-different-length" });
    await redeemBetaSecret(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "invite_invalid", message: "Invalid invite link." },
    });
    expect(lastUpsertRow).toBeNull();
  });

  it("unauthed → 401", async () => {
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { req, res } = mockReqRes({ key: SECRET });
    await redeemBetaSecret(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("missing BETA_INVITE_SECRET env → fail-closed 503 (no hardcoded fallback)", async () => {
    delete process.env.BETA_INVITE_SECRET;
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user_id: "user-1",
      access_token: "tok",
    });
    const { req, res } = mockReqRes({ key: "praxis-beta-2026-launch" });
    await redeemBetaSecret(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "invite_unavailable", message: "Invite redemption is not available." },
    });
  });

  it("env unset → never stamps the profile (fail-closed)", async () => {
    delete process.env.BETA_INVITE_SECRET;
    lastUpsertRow = null;
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user_id: "user-fallback-test",
      access_token: "tok",
    });
    const { req, res } = mockReqRes({ key: "praxis-beta-2026-launch" });
    await redeemBetaSecret(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(lastUpsertRow).toBeNull();
  });

  it("upsert error → 500 stamp_failed", async () => {
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user_id: "user-1",
      access_token: "tok",
    });
    upsertError = { message: "rls denied" };
    const { req, res } = mockReqRes({ key: SECRET });
    await redeemBetaSecret(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "stamp_failed", message: "Could not stamp invite. Try again." },
    });
  });

  it("invalid body (missing key) → 400 validation", async () => {
    (verifyBearer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user_id: "user-1",
      access_token: "tok",
    });
    const { req, res } = mockReqRes({});
    await redeemBetaSecret(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
