import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getBool: vi.fn(),
  loadRole: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBool }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: mocks.loadRole }));

import { redditWorkspaceV2Gate, redditWriteRoleGate } from "../gate";

const mkRes = () => {
  const res = {
    statusCode: 200,
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
  return res as unknown as Response & { statusCode: number; body: any };
};
const mkReq = (method?: string) => ({ method, body: {}, query: {}, params: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.getBool.mockResolvedValue(true);
  mocks.loadRole.mockResolvedValue("member");
});

describe("redditWorkspaceV2Gate", () => {
  it("stops at auth without reading the flag", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const next = vi.fn();
    await redditWorkspaceV2Gate(mkReq(), mkRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.getBool).not.toHaveBeenCalled();
  });

  it("passes through when the flag is on, scoped to the caller's tenant", async () => {
    const next = vi.fn();
    await redditWorkspaceV2Gate(mkReq(), mkRes(), next);
    expect(mocks.getBool).toHaveBeenCalledWith("reddit_workspace_v2", "t1");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("404s the route when the tenant's kill switch is off", async () => {
    mocks.getBool.mockResolvedValue(false);
    const next = vi.fn();
    const res = mkRes();
    await redditWorkspaceV2Gate(mkReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ reason: "disabled" });
  });

  it("fails OPEN if the settings read throws — the default is ON, and a blip must not black out the panel", async () => {
    mocks.getBool.mockRejectedValue(new Error("settings down"));
    const next = vi.fn();
    const res = mkRes();
    await redditWorkspaceV2Gate(mkReq(), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});

describe("redditWriteRoleGate", () => {
  const AUTH = { user_id: "u1", tenant_id: "t1", access_token: "tok" };

  it.each([["GET"], ["HEAD"], ["OPTIONS"], ["get"]])("lets a member through on %s without reading auth or role", async (method) => {
    const next = vi.fn();
    const res = mkRes();
    await redditWriteRoleGate(mkReq(method), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.loadRole).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it.each([["POST"], ["PATCH"], ["PUT"], ["DELETE"]])("403s a member on %s and never reaches the handler", async (method) => {
    const next = vi.fn();
    const res = mkRes();
    await redditWriteRoleGate(mkReq(method), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "forbidden", message: "Only an owner or an admin can change this." });
    expect(mocks.loadRole).toHaveBeenCalledWith(AUTH);
  });

  it.each([[null], ["viewer"], [""], ["Owner"]])("403s a write when the role is %j", async (role) => {
    mocks.loadRole.mockResolvedValue(role);
    const next = vi.fn();
    const res = mkRes();
    await redditWriteRoleGate(mkReq("POST"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it.each([["owner"], ["admin"]])("passes a write for %s", async (role) => {
    mocks.loadRole.mockResolvedValue(role);
    const next = vi.fn();
    const res = mkRes();
    await redditWriteRoleGate(mkReq("POST"), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("fails CLOSED with 500 when the role read throws, and never reaches the handler", async () => {
    mocks.loadRole.mockRejectedValue(new Error("tenant_users down"));
    const next = vi.fn();
    const res = mkRes();
    await redditWriteRoleGate(mkReq("DELETE"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "role_check_failed", message: "We couldn't verify your access. Try again." });
    expect(JSON.stringify(res.body)).not.toContain("tenant_users");
  });

  it("stops at auth on a write without reading the role", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const next = vi.fn();
    await redditWriteRoleGate(mkReq("POST"), mkRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.loadRole).not.toHaveBeenCalled();
  });

  it("treats a request with no method as a read", async () => {
    const next = vi.fn();
    await redditWriteRoleGate(mkReq(undefined), mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.loadRole).not.toHaveBeenCalled();
  });
});
