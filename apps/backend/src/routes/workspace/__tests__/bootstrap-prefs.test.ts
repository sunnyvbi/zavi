
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    rpc: Record<string, { data: unknown; error: { message: string } | null }>;
    rpcThrows: Record<string, string>;
  } = { rpc: {}, rpcThrows: {} };

  const requireAuth = vi.fn(async () => ({
    tenant_id: "tenant-1",
    user_id: "user-1",
    access_token: "token-1",
  }));

  const emptyQuery = () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const k of ["select", "eq", "neq", "in", "gte"]) chain[k] = vi.fn(self);
    (chain as { maybeSingle: unknown }).maybeSingle = vi.fn(async () => ({
      data: null,
      error: null,
    }));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [], error: null, count: 0 });
    return chain;
  };

  const serverClientFromBearer = vi.fn(() => ({
    from: vi.fn(() => emptyQuery()),
    rpc: vi.fn((name: string) => {
      if (state.rpcThrows[name]) {
        return Promise.reject(new Error(state.rpcThrows[name]));
      }
      return Promise.resolve(
        state.rpc[name] ?? { data: null, error: null },
      );
    }),
  }));

  const logEvent = vi.fn(async () => {});

  return { state, requireAuth, serverClientFromBearer, logEvent };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: m.serverClientFromBearer,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("@/services/agents/registry", () => ({ listAgents: () => [] }));
vi.mock("@/services/agents/visibility", () => ({
  getTenantDisabledSlugs: async () => new Set<string>(),
}));
vi.mock("@/services/agents/entitlement", () => ({
  annotateLockedTier: async (a: Array<Record<string, unknown>>) => a.map((x) => ({ ...x, locked_tier: null })),
}));
vi.mock("@/services/agents/thread-counts", () => ({
  countThreadsBySlug: async () => new Map<string, number>(),
}));
vi.mock("@/services/workspace/scrubThreadBindings", () => ({
  scrubForeignThreadBindings: async (t: unknown[]) => t,
}));

import { workspaceBootstrap } from "../bootstrap";

function mockRes(): Response & { statusCode: number; body?: unknown } {
  const res: Partial<Response> & { statusCode: number; body?: unknown } = {
    statusCode: 200,
  };
  res.status = function status(code: number) {
    res.statusCode = code;
    return res as Response;
  };
  res.json = function json(body: unknown) {
    res.body = body;
    return res as Response;
  };
  return res as Response & { statusCode: number; body?: unknown };
}

type Body = { prefs?: Record<string, unknown> };

beforeEach(() => {
  m.state.rpc = {
    list_agents_for_tenant: { data: [], error: null },
    get_tabs_session: { data: [{ tabs: [], active_tab_id: null }], error: null },
    get_user_prefs: { data: {}, error: null },
  };
  m.state.rpcThrows = {};
  m.logEvent.mockClear();
});

describe("workspace bootstrap — prefs", () => {
  it("passes the stored prefs blob through to the payload", async () => {
    m.state.rpc.get_user_prefs = {
      data: { viewMode: "threaded", paneWidthPct: 52 },
      error: null,
    };
    const res = mockRes();
    await workspaceBootstrap({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as Body).prefs).toEqual({
      viewMode: "threaded",
      paneWidthPct: 52,
    });
  });

  it("returns {} for a user who has never set a pref", async () => {
    const res = mockRes();
    await workspaceBootstrap({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as Body).prefs).toEqual({});
  });

  it("FAILS SOFT to {} — and still 200s the rest of the workspace — when the prefs read errors", async () => {
    m.state.rpc.get_user_prefs = {
      data: null,
      error: { message: "permission denied for function get_user_prefs" },
    };
    const res = mockRes();
    await workspaceBootstrap({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as Body).prefs).toEqual({});
    expect(res.body).toHaveProperty("tree");
    expect(res.body).toHaveProperty("tabs_session");
    expect(res.body).toHaveProperty("status_counters");
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "workspace.prefs.read_failed" }),
    );
  });

  it("FAILS SOFT when the prefs read REJECTS (a throw would otherwise reject the whole Promise.all)", async () => {
    m.state.rpcThrows.get_user_prefs = "socket hang up";
    const res = mockRes();
    await workspaceBootstrap({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as Body).prefs).toEqual({});
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "workspace.prefs.read_failed" }),
    );
  });

  it("ignores a non-object prefs value instead of forwarding junk", async () => {
    m.state.rpc.get_user_prefs = { data: "threaded", error: null };
    const res = mockRes();
    await workspaceBootstrap({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect((res.body as Body).prefs).toEqual({});
  });

  it("still 500s when the TABS session read fails (prefs fail-soft did not weaken that)", async () => {
    m.state.rpc.get_tabs_session = {
      data: null,
      error: { message: "boom" },
    };
    const res = mockRes();
    await workspaceBootstrap({} as Request, res);

    expect(res.statusCode).toBe(500);
  });
});
