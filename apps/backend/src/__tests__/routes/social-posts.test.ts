
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const POST = "33333333-cccc-cccc-cccc-333333333333";
const NEW_POST = "44444444-dddd-dddd-dddd-444444444444";

vi.mock("../../services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("../../services/tenant-client", () => ({ tenantRpc: vi.fn() }));
const send = vi.hoisted(() => vi.fn());
vi.mock("../../../workers/client", () => ({ inngest: { send } }));

import { requireAuth } from "../../services/auth/middleware";
import { tenantRpc } from "../../services/tenant-client";
import { socialPostCancel, socialPostReschedule } from "../../routes/social/posts";

function mkRes(): Response & { _status: number; _body: unknown } {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 200,
    _body: undefined,
    status(code: number) {
      r._status = code;
      return r as Response;
    },
    json(body: unknown) {
      r._body = body;
      return r as Response;
    },
  };
  return r as Response & { _status: number; _body: unknown };
}

const rpc = tenantRpc as ReturnType<typeof vi.fn>;
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

beforeEach(() => {
  rpc.mockReset();
  send.mockReset().mockResolvedValue(undefined);
  (requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user_id: "u", tenant_id: TENANT_A, access_token: "t" });
});

describe("cancel", () => {
  it("200 when the RPC flips it; tenant injected by the facade, never in the arg bag", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const res = mkRes();
    await socialPostCancel({ params: { id: POST } } as unknown as Request, res);
    expect(res._status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(TENANT_A, "social_post_cancel", { p_post_id: POST });
  });

  it("409 when the RPC returns false (already publishing / foreign tenant / cancelled)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const res = mkRes();
    await socialPostCancel({ params: { id: POST } } as unknown as Request, res);
    expect(res._status).toBe(409);
    expect((res._body as { error: { code: string } }).error.code).toBe("not_cancellable");
  });

  it("400 on a non-uuid id, before any RPC", async () => {
    const res = mkRes();
    await socialPostCancel({ params: { id: "nope" } } as unknown as Request, res);
    expect(res._status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("reschedule", () => {
  it("200 + event for the NEW row id", async () => {
    rpc.mockResolvedValue({ data: NEW_POST, error: null });
    const res = mkRes();
    await socialPostReschedule({ params: { id: POST }, body: { scheduled_at: FUTURE } } as unknown as Request, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, post_id: NEW_POST });
    expect(rpc).toHaveBeenCalledWith(TENANT_A, "social_post_reschedule", { p_post_id: POST, p_scheduled_at: FUTURE });
    expect(send).toHaveBeenCalledWith({
      name: "social/publish.requested",
      data: { post_id: NEW_POST, tenant_id: TENANT_A, agent_run_id: null },
    });
  });

  it("400 on a past time and on a malformed time — no RPC, no event", async () => {
    for (const bad of [{ scheduled_at: "2001-01-01T00:00:00Z" }, { scheduled_at: "tomorrow" }, {}]) {
      const res = mkRes();
      await socialPostReschedule({ params: { id: POST }, body: bad } as unknown as Request, res);
      expect(res._status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("409 when the RPC returns null — and no event is sent", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const res = mkRes();
    await socialPostReschedule({ params: { id: POST }, body: { scheduled_at: FUTURE } } as unknown as Request, res);
    expect(res._status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("502 with the new post id when the enqueue throws (row committed, worker not woken)", async () => {
    rpc.mockResolvedValue({ data: NEW_POST, error: null });
    send.mockRejectedValue(new Error("inngest down"));
    const res = mkRes();
    await socialPostReschedule({ params: { id: POST }, body: { scheduled_at: FUTURE } } as unknown as Request, res);
    expect(res._status).toBe(502);
    expect(res._body).toMatchObject({ error: { code: "enqueue_failed" }, post_id: NEW_POST });
  });

  it("500 on an RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = mkRes();
    await socialPostReschedule({ params: { id: POST }, body: { scheduled_at: FUTURE } } as unknown as Request, res);
    expect(res._status).toBe(500);
  });
});

it("never names a tenant in the arg bag nor imports the raw service client", () => {
  const code = readFileSync("src/routes/social/posts.ts", "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  expect(code).not.toMatch(/p_tenant_id/);
  expect(code).not.toMatch(/serviceClient/);
});
