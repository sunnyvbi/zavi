
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => flag.on }));
vi.mock("@/services/auth/middleware", () => ({ authMiddleware: vi.fn() }));
vi.mock("@/services/copilotkit/zavi-agent", () => ({ runZaviAgent: vi.fn() }));

import { copilotGate, copilotInfo, copilotRun, COPILOTKIT_AGENT_ID } from "../index";

function mkRes() {
  const r: Partial<Response> & { _status: number; _body: unknown } = {
    _status: 200,
    _body: undefined,
    status(c: number) { r._status = c; return r as Response; },
    json(b: unknown) { r._body = b; return r as Response; },
  };
  return r as Response & { _status: number; _body: unknown };
}

beforeEach(() => { flag.on = true; });

describe("copilotGate", () => {
  it("401 when no auth was attached", async () => {
    const res = mkRes();
    const next = vi.fn();
    await copilotGate({} as Request, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("404 copilotkit_disabled when the tenant flag is off", async () => {
    flag.on = false;
    const res = mkRes();
    const next = vi.fn();
    await copilotGate({ auth: { user_id: "u", tenant_id: "t", access_token: "x" } } as unknown as Request, res, next);
    expect(res._status).toBe(404);
    expect((res._body as { error: { code: string } }).error.code).toBe("copilotkit_disabled");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through when authed and on", async () => {
    const next = vi.fn();
    await copilotGate({ auth: { user_id: "u", tenant_id: "t", access_token: "x" } } as unknown as Request, mkRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("copilotInfo", () => {
  it("advertises one sse agent named zavi and no telemetry", () => {
    const res = mkRes();
    copilotInfo({} as Request, res);
    const body = res._body as { mode: string; agents: Record<string, unknown>; telemetryDisabled: boolean };
    expect(body.mode).toBe("sse");
    expect(Object.keys(body.agents)).toEqual([COPILOTKIT_AGENT_ID]);
    expect(body.telemetryDisabled).toBe(true);
  });
});

describe("copilotRun", () => {
  it("404 for an unknown agent id, 400 for a non-RunAgentInput body", async () => {
    const run = copilotRun(() => "http://127.0.0.1:1");
    const a = mkRes();
    await run({ params: { agentId: "other" }, body: {}, auth: { tenant_id: "t" } } as unknown as Request, a);
    expect(a._status).toBe(404);
    const b = mkRes();
    await run({ params: { agentId: "zavi" }, body: { nope: 1 }, auth: { tenant_id: "t" } } as unknown as Request, b);
    expect(b._status).toBe(400);
  });
});
