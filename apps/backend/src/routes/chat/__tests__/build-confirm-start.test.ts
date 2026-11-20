import { describe, it, expect, vi, beforeEach } from "vitest";

const TH = "33333333-3333-4333-8333-333333333333";
const NONCE = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  start: vi.fn(),
  note: vi.fn(),
  role: vi.fn(async () => true),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: "tenant-A", access_token: "tok" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: (...a: unknown[]) => h.role(...(a as [])),
}));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({
        data: { id: TH, user_id: "u1", agent_slug: "operator" },
        error: null,
      });
      return b;
    },
  }),
}));
vi.mock("@/services/agents/heavy-build-confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/heavy-build-confirm")>()),
  startConfirmedHeavyBuild: h.start,
  postBuildConfirmNote: h.note,
}));

import type { Request, Response } from "express";
import { buildConfirmStart } from "../build-confirm-start";

function call() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const req = { params: { thread_id: TH }, body: { nonce: NONCE } } as unknown as Request;
  return buildConfirmStart(req, res as unknown as Response).then(() => res);
}

describe("POST /api/chat/build-confirm/:thread_id/start — chat notes", () => {
  beforeEach(() => {
    h.start.mockReset();
    h.note.mockReset();
    h.note.mockResolvedValue(undefined);
  });

  it("three failed clicks on a card that stays startable post no chat message, and each click still gets the reason", async () => {
    h.start.mockResolvedValue({
      status: "failed",
      message: "Something went wrong starting the build. Try again.",
      retryable: true,
    });
    for (let i = 0; i < 3; i++) {
      const res = await call();
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({
        status: "failed",
        message: "Something went wrong starting the build. Try again.",
      });
    }
    expect(h.start).toHaveBeenCalledTimes(3);
    expect(h.note).not.toHaveBeenCalled();
  });

  it("a failure that kills the card posts one chat message telling the founder to ask again", async () => {
    h.start.mockResolvedValue({
      status: "failed",
      message: "The build did not start. Ask me again and I'll set it up.",
      retryable: false,
    });
    await call();
    expect(h.note).toHaveBeenCalledTimes(1);
    expect(h.note.mock.calls[0][0].body).toMatch(/Ask me again/);
  });

  it("a started build still posts its note", async () => {
    h.start.mockResolvedValue({ status: "started", run_id: "cr-1", est_credits: 2000 });
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(h.note).toHaveBeenCalledTimes(1);
    expect(h.note.mock.calls[0][0].meta).toEqual({ build_confirm_result: "started" });
  });

  it("a member cannot start a new build from the chat card: refused before anything starts", async () => {
    h.role.mockImplementationOnce(async (...a: unknown[]) => {
      const res = a[2] as { status: (c: number) => { json: (b: unknown) => void } };
      res.status(403).json({ error: "forbidden" });
      return false;
    });
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.note).not.toHaveBeenCalled();
    expect((h.role.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toEqual(["owner", "admin"]);
  });
});
