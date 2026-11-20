
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ resend: vi.fn(), writer: true }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => ({ user_id: "u1", tenant_id: "t-1", bearer: "b" }) }));
vi.mock("@/services/auth/tenant-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/auth/tenant-role")>()),
  requireTenantRole: async (_a: unknown, _r: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (h.writer) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/build/build-live-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/build/build-live-email")>()),
  resendOwnerLoginLink: h.resend,
}));

import { postAutopilotBuildAdminLink } from "../autopilot";

const RUN = "0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4d01";

async function call(body: unknown) {
  const out = { status: 200, body: undefined as unknown };
  const res = { status: (s: number) => ((out.status = s), res), json: (b: unknown) => ((out.body = b), res), setHeader: () => res };
  await postAutopilotBuildAdminLink({ body, headers: {} } as never, res as never);
  return out;
}

beforeEach(() => {
  h.resend.mockReset().mockResolvedValue({ sent: true, email: "owner@example.test" });
  h.writer = true;
});

describe("build-admin-link with a session id", () => {
  it("forwards the session id; the tenant stays server-derived", async () => {
    expect(await call({ conductor_run_id: RUN })).toEqual({ status: 200, body: { ok: true, email: "owner@example.test" } });
    expect(h.resend).toHaveBeenCalledWith("t-1", { conductor_run_id: RUN });
  });

  it("no body reaches the service with no session (which has no site to resend)", async () => {
    await call({});
    expect(h.resend).toHaveBeenCalledWith("t-1", { conductor_run_id: null });
  });

  it("a member gets 403 and nothing is sent", async () => {
    h.writer = false;
    expect((await call({ conductor_run_id: RUN })).status).toBe(403);
    expect(h.resend).not.toHaveBeenCalled();
  });

  it("a second ask inside the cooldown is 429 with founder copy", async () => {
    h.resend.mockResolvedValue({ sent: false, reason: "cooldown", retryAfterS: 300 });
    const r = await call({ conductor_run_id: RUN });
    expect(r.status).toBe(429);
    expect((r.body as { error: { code: string } }).error.code).toBe("too_soon");
  });

  it("a malformed id is 400 and never reaches the service", async () => {
    for (const bad of ["x", 42, "0f1c1a5e; drop", "a".repeat(200)]) {
      expect((await call({ conductor_run_id: bad })).status).toBe(400);
    }
    expect(h.resend).not.toHaveBeenCalled();
  });

  it("a foreign or unknown run maps to the existing 409 body", async () => {
    h.resend.mockResolvedValue({ sent: false, reason: "no_live_site" });
    const r = await call({ conductor_run_id: RUN });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("no_live_site");
  });
});
