
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  softDeleteAccount: vi.fn(),
}));

vi.mock("@/services/auth/jwt", () => ({ verifyBearer: mocks.verifyBearer }));
vi.mock("@/services/account/delete-account", async () => {
  const actual = await vi.importActual<typeof import("@/services/account/delete-account")>(
    "@/services/account/delete-account",
  );
  return { ...actual, softDeleteAccount: mocks.softDeleteAccount };
});

import type { Request, Response } from "express";
import { accountDelete } from "@/routes/account";
import { AccountDeletionError } from "@/services/account/delete-account";

const ME = "11111111-1111-1111-1111-111111111111";

function res() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return r;
    },
  };
  return r as unknown as Response & { statusCode: number; body: any };
}

function req(body?: unknown, headers: Record<string, string> = {}): Request {
  return { body, headers } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyBearer.mockResolvedValue({ user_id: ME, access_token: "tok", email: "a@b.co" });
  mocks.softDeleteAccount.mockResolvedValue({
    deleted_user_id: ME,
    deleted_tenants: ["t-solo"],
    left_tenants: [],
  });
});

describe("DELETE /api/account", () => {
  it("returns the result the app reads as its last authenticated response", async () => {
    const r = res();
    await accountDelete(req({ source: "mobile" }), r);

    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      deleted_user_id: ME,
      deleted_tenants: ["t-solo"],
      left_tenants: [],
    });
  });

  it("deletes the VERIFIED caller, never a user id from the request", async () => {
    await accountDelete(req({ user_id: "99999999-9999-9999-9999-999999999999" }), res());

    expect(mocks.softDeleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: ME, access_token: "tok" }),
    );
  });

  it("hands the verified token's session to the service, so a staff login-as session is refused", async () => {
    mocks.verifyBearer.mockResolvedValue({ user_id: ME, access_token: "tok", email: "a@b.co", session_id: "sess-9" });
    mocks.softDeleteAccount.mockRejectedValue(
      new AccountDeletionError(403, "staff_session", "This session was opened by Zavi support, so it cannot delete the account."),
    );
    const r = res();
    await accountDelete(req({}, { "x-session-id": "forged" }), r);
    expect(mocks.softDeleteAccount).toHaveBeenCalledWith(expect.objectContaining({ user_id: ME, session_id: "sess-9" }));
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("staff_session");
  });

  it("401s without a valid bearer, and does not touch the account", async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const r = res();
    await accountDelete(req(), r);

    expect(r.statusCode).toBe(401);
    expect(mocks.softDeleteAccount).not.toHaveBeenCalled();
  });

  it("passes a 409 through verbatim — the app shows that message to the person", async () => {
    mocks.softDeleteAccount.mockRejectedValue(
      new AccountDeletionError(
        409,
        "owner_transfer_required",
        "You are the only owner of Acme Growth, which still has other members.",
      ),
    );
    const r = res();
    await accountDelete(req(), r);

    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("owner_transfer_required");
    expect(r.body.error.message).toContain("Acme Growth");
  });

  it("never echoes an internal error back to the caller", async () => {
    mocks.softDeleteAccount.mockRejectedValue(new Error("password=hunter2 at pg://prod"));
    const r = res();
    await accountDelete(req(), r);

    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect(r.body.error.message).toContain("support@zaviagent.com");
  });

  it("defaults the audit label rather than trusting an unknown one", async () => {
    await accountDelete(req({ source: "definitely-not-a-source" }), res());
    expect(mocks.softDeleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ source: "api" }),
    );
  });

  it("works with no body at all — the contract says the app sends none", async () => {
    const r = res();
    await accountDelete(req(undefined), r);
    expect(r.statusCode).toBe(200);
  });

  it("auths with verifyBearer, NOT requireAuth", async () => {
    const src = readFileSync(join(__dirname, "../../routes/account/index.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("verifyBearer");
    expect(code).not.toContain("requireAuth");
  });
});
