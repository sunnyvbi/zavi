import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const IMG_PATH = `${TENANT_A}/33333333-cccc-cccc-cccc-333333333333.jpg`;

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), tenantRpc: vi.fn(), readiness: vi.fn() }));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("../../services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("../../services/tenant-client", () => ({ tenantRpc: m.tenantRpc }));
vi.mock("@/services/connectors/pinterest-composio/readiness", () => ({ resolvePinterestPublishReadiness: m.readiness }));

import { socialPropose } from "../../routes/social/propose";

function mkRes() {
  const r = { _status: 200, _body: undefined as unknown, locals: {} } as Response & { _status: number; _body: unknown };
  r.status = ((c: number) => { r._status = c; return r; }) as never;
  r.json = ((b: unknown) => { r._body = b; return r; }) as never;
  return r;
}

const PIN = {
  title: "Linen duvet cover",
  text: "Stonewashed linen.",
  image_path: IMG_PATH,
  board_id: "222",
  board_name: "Typed by the founder",
  link: "https://acme.com/p/duvet",
};
const pass = { status: "pass" };
const ready = (over: Record<string, unknown> = {}) => ({
  ok: true,
  checked_at: "2026-10-08T00:00:00.000Z",
  checks: { board: pass, media: pass, link: pass, identity: { status: "unverified", reason: "Your company website is not on file." } },
  board: { id: "222", name: "Linen", privacy: "PUBLIC" },
  board_count: 2,
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.requireAuth.mockResolvedValue({ user_id: "u", tenant_id: TENANT_A, access_token: "t" });
  m.tenantRpc.mockResolvedValue({ data: "dec-pin", error: null });
});

describe("POST /api/social/propose — Pinterest publication readiness", () => {
  it("refuses a pin whose board is gone with the founder reason and stages nothing", async () => {
    const reason = "That board is not on your connected Pinterest account any more. Pick one of your current boards and try again.";
    m.readiness.mockResolvedValue(
      ready({ ok: false, board: null, checks: { board: { status: "fail", reason_code: "pinterest_board_missing", reason }, media: pass, link: pass, identity: pass }, reason_code: "pinterest_board_missing", reason }),
    );
    const res = mkRes();
    await socialPropose({ body: { channel: "pinterest_pin", payload: PIN } } as Request, res);
    expect(m.readiness).toHaveBeenCalledWith(TENANT_A, { board_id: "222", image_path: IMG_PATH, link: "https://acme.com/p/duvet" });
    expect(res._status).toBe(422);
    expect(res._body).toMatchObject({ error: { code: "pinterest_board_missing", message: reason } });
    expect(res.locals.idempotencyRelease).toBe(true);
    expect(m.tenantRpc).not.toHaveBeenCalled();
  });

  it("refuses an image that failed the media check", async () => {
    m.readiness.mockResolvedValue(ready({ ok: false, checks: { board: pass, media: { status: "fail", reason_code: "pinterest_media_invalid" }, link: pass, identity: pass }, reason_code: "pinterest_media_invalid", reason: "bad image" }));
    const res = mkRes();
    await socialPropose({ body: { channel: "pinterest_pin", payload: PIN } } as Request, res);
    expect(res._status).toBe(422);
    expect(m.tenantRpc).not.toHaveBeenCalled();
  });

  it("stages a ready pin under the account's board name, with the readiness on the body", async () => {
    m.readiness.mockResolvedValue(ready());
    const res = mkRes();
    await socialPropose({ body: { channel: "pinterest_pin", payload: PIN } } as Request, res);
    expect(res._body).toMatchObject({ ok: true, decision_id: "dec-pin" });
    const body = m.tenantRpc.mock.calls[0][2].p_body;
    expect(body.payload.board_name).toBe("Linen");
    expect(body.readiness).toEqual(ready());
    expect(body.readiness.checks.identity.status).toBe("unverified");
  });

  it("releases the idempotency claim after a definitive staging refusal", async () => {
    m.readiness.mockResolvedValue(ready());
    m.tenantRpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "database refused the write" } });
    const res = mkRes();
    await socialPropose({ body: { channel: "pinterest_pin", payload: PIN } } as Request, res);
    expect(res._status).toBe(500);
    expect(res.locals.idempotencyRelease).toBe(true);
  });

  it("keeps the idempotency claim when the staging outcome is ambiguous", async () => {
    m.readiness.mockResolvedValue(ready());
    m.tenantRpc.mockResolvedValueOnce({ data: null, error: { status: 0, message: "response lost" } });
    const res = mkRes();
    await socialPropose({ body: { channel: "pinterest_pin", payload: PIN } } as Request, res);
    expect(res._status).toBe(500);
    expect(res.locals.idempotencyRelease).not.toBe(true);
  });

  it("keeps the claim when PostgREST loses the database connection", async () => {
    m.readiness.mockResolvedValue(ready());
    m.tenantRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST001", message: "database connection lost" } });
    const res = mkRes();
    await socialPropose({ body: { channel: "pinterest_pin", payload: PIN } } as Request, res);
    expect(res._status).toBe(500);
    expect(res.locals.idempotencyRelease).not.toBe(true);
  });

  it("does not run Pinterest checks for another channel", async () => {
    const res = mkRes();
    await socialPropose({ body: { channel: "linkedin", payload: { text: "hi" } } } as Request, res);
    expect(m.readiness).not.toHaveBeenCalled();
    expect(m.tenantRpc.mock.calls[0][2].p_body).not.toHaveProperty("readiness");
  });
});
