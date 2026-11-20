import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveMacWorkerToken: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/auth/mac-worker-token", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/auth/mac-worker-token")
  >("@/services/auth/mac-worker-token");
  return {
    ...actual,
    resolveMacWorkerToken: mocks.resolveMacWorkerToken,
  };
});

vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));

import { macWorkerAuth, getMacWorker } from "../auth";
import { MacTokenAuthError } from "@/services/auth/mac-worker-token";

function mockReqRes(authHeader?: string) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Parameters<typeof macWorkerAuth>[0];
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  mocks.resolveMacWorkerToken.mockReset();
  mocks.logEvent.mockReset();
  mocks.logEvent.mockResolvedValue(undefined);
});

describe("macWorkerAuth", () => {
  it("F1: 401 when no Authorization header", async () => {
    const { req, res } = mockReqRes();
    const next = vi.fn();
    await macWorkerAuth(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized" } });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.resolveMacWorkerToken).not.toHaveBeenCalled();
  });

  it("F1: 401 when header is present but not a Bearer", async () => {
    const { req, res } = mockReqRes("Basic abc");
    const next = vi.fn();
    await macWorkerAuth(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("F2/F3: 401 generic on not_found (no detail leak)", async () => {
    mocks.resolveMacWorkerToken.mockRejectedValue(new MacTokenAuthError("not_found"));
    const { req, res } = mockReqRes("Bearer zavi_mac_" + "a".repeat(64));
    const next = vi.fn();
    await macWorkerAuth(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized" } });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("F4: 401 on a revoked token", async () => {
    mocks.resolveMacWorkerToken.mockRejectedValue(new MacTokenAuthError("revoked"));
    const { req, res } = mockReqRes("Bearer zavi_mac_" + "a".repeat(64));
    const next = vi.fn();
    await macWorkerAuth(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized" } });
  });

  it("F4b: 401 + anomaly audit log on the anomaly branch", async () => {
    mocks.resolveMacWorkerToken.mockRejectedValue(new MacTokenAuthError("anomaly"));
    const { req, res } = mockReqRes("Bearer zavi_mac_" + "a".repeat(64));
    const next = vi.fn();
    await macWorkerAuth(req, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthorized" } });
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const logArg = (mocks.logEvent.mock.calls as unknown[][])[0][0];
    expect(logArg).toMatchObject({
      code: "mac_worker_token_anomaly",
      level: "warn",
    });
  });

  it("attaches the caller + calls next on a valid token (owner read here, not body)", async () => {
    mocks.resolveMacWorkerToken.mockResolvedValue({
      token_id: "tok-1",
      owner: "mac:tok-1",
    });
    const { req, res } = mockReqRes("Bearer zavi_mac_" + "a".repeat(64));
    const next = vi.fn();
    await macWorkerAuth(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getMacWorker(req).owner).toBe("mac:tok-1");
  });
});
