import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auth: { tenant_id: "t-session", user_id: "u-1", access_token: "tok" } as Record<string, string> | null,
  logged: [] as Array<Record<string, unknown>>,
  ok: true,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => h.auth }));
vi.mock("@/services/logging/logEvent", () => ({
  logEventConfirmed: async (input: Record<string, unknown>) => {
    h.logged.push(input);
    return h.ok ? { ok: true } : { ok: false, error: "boom" };
  },
}));

import { OPENED_THROTTLE_MS, resetWorkspaceOpenedThrottle, workspaceOpened } from "../opened";
import { WORKSPACE_OPENED_CODE } from "@/services/growth/tenant-idle";

function res() {
  const r = { code: 0, status(c: number) { r.code = c; return r; }, end() { return r; } };
  return r;
}
const call = async (body: unknown = {}) => {
  const r = res();
  await workspaceOpened({ body } as unknown as Request, r as unknown as Response);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return r.code;
};

beforeEach(() => {
  resetWorkspaceOpenedThrottle();
  h.logged.length = 0;
  h.ok = true;
  h.auth = { tenant_id: "t-session", user_id: "u-1", access_token: "tok" };
  vi.useRealTimers();
});

describe("workspaceOpened", () => {
  it("logs one open for the session's tenant, ignoring any tenant in the body", async () => {
    expect(await call({ tenant_id: "t-other" })).toBe(204);
    expect(h.logged).toEqual([expect.objectContaining({ code: WORKSPACE_OPENED_CODE, tenant_id: "t-session", level: "info" })]);
  });

  it("logs at most once per throttle window, then again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    await call();
    await call();
    expect(h.logged).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse("2026-10-28T10:00:00Z") + OPENED_THROTTLE_MS));
    await call();
    expect(h.logged).toHaveLength(2);
  });

  it("another user or company is its own window", async () => {
    await call();
    h.auth = { tenant_id: "t-session", user_id: "u-2", access_token: "tok" };
    await call();
    h.auth = { tenant_id: "t-two", user_id: "u-2", access_token: "tok" };
    await call();
    expect(h.logged.map((l) => l.tenant_id)).toEqual(["t-session", "t-session", "t-two"]);
  });

  it("a row that did not land is retried on the next call", async () => {
    h.ok = false;
    await call();
    h.ok = true;
    await call();
    expect(h.logged).toHaveLength(2);
  });

  it("logs nothing without a session", async () => {
    h.auth = null;
    await call();
    expect(h.logged).toHaveLength(0);
  });
});
