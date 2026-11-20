
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const H = vi.hoisted(() => {
  const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  return {
    eqCalls: [] as { table: string; col: string; val: unknown }[],
    orCalls: [] as { table: string; expr: string }[],
    runsByTenant: {
      [A]: [{ agent_slug: "alpha", status: "success", parse_ok: true, finished_at: "2026-05-30T00:00:00Z" }],
      [B]: [{ agent_slug: "beta", status: "dispatch_error", parse_ok: false, finished_at: "2026-05-30T00:00:00Z" }],
    } as Record<string, unknown[]>,
    feedbackByTenant: {
      [A]: [] as unknown[],
      [B]: [
        { agent_slug: "alpha", rating: -1, created_by: "u1", created_by_role: "operator" },
        { agent_slug: "alpha", rating: -1, created_by: "u2", created_by_role: "operator" },
        { agent_slug: "alpha", rating: -1, created_by: "u3", created_by_role: "operator" },
      ],
    } as Record<string, unknown[]>,
    tenantExists: true,
  };
});

function makeChain(table: string) {
  let tenantFilter: string | null = null;
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  chain.select = ret;
  chain.gte = ret;
  chain.or = (expr: string) => {
    H.orCalls.push({ table, expr });
    return chain;
  };
  chain.order = () => resolve();
  chain.eq = (col: string, val: unknown) => {
    H.eqCalls.push({ table, col, val });
    if (col === "tenant_id") tenantFilter = String(val);
    return chain;
  };
  chain.maybeSingle = () =>
    Promise.resolve({ data: H.tenantExists ? { id: tenantFilter } : null, error: null });
  function resolve() {
    if (table === "agent_runs") return Promise.resolve({ data: H.runsByTenant[tenantFilter ?? ""] ?? [], error: null });
    if (table === "agent_feedback") return Promise.resolve({ data: H.feedbackByTenant[tenantFilter ?? ""] ?? [], error: null });
    return Promise.resolve({ data: [], error: null });
  }
  (chain as { then?: unknown }).then = (onF: (v: unknown) => unknown) => resolve().then(onF);
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ from: vi.fn((t: string) => makeChain(t)) })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "staff-1", email: "ravi@zaviagent.com" })),
}));
vi.mock("@/services/agents/visibility", () => ({
  getAgentEffectiveStates: vi.fn(async () => [
    { slug: "alpha", default_state: "enabled", effective_state: "visible", effective_reason: "default_enabled", override_state: null, override_source: null, is_locked: false },
  ]),
}));
vi.mock("@/services/agents/setup-schema", () => ({
  probeSetupCompleteness: vi.fn(async () => ({
    ok: true,
    missing_vault_keys: [],
    missing_connectors: [],
    missing_required_connectors: [],
    missing_optional_connectors: [],
  })),
}));

import { staffTenantAgentHealth } from "../../routes/admin/agent-health";

function mockRes() {
  const r: Partial<Response> & { _status: number; _json: unknown } = {
    _status: 200,
    _json: null,
    status(code: number) {
      this._status = code;
      return this as Response;
    },
    json(body: unknown) {
      this._json = body;
      return this as Response;
    },
  };
  return r as Response & { _status: number; _json: any };
}

beforeEach(() => {
  H.eqCalls.length = 0;
  H.orCalls.length = 0;
  H.tenantExists = true;
});

describe("staffTenantAgentHealth — build ratings", () => {
  it("leaves build ratings (conductor_run) out of the feedback it reads, keeping untargeted rule rows", async () => {
    await staffTenantAgentHealth({ params: { tenant_id: TENANT_A } } as unknown as Request, mockRes());
    expect(H.orCalls).toEqual([{ table: "agent_feedback", expr: "target_type.is.null,target_type.neq.conductor_run" }]);
  });
});

describe("staffTenantAgentHealth — isolation", () => {
  it("scopes EVERY query by the URL tenant_id (no cross-tenant leak)", async () => {
    const res = mockRes();
    await staffTenantAgentHealth({ params: { tenant_id: TENANT_A } } as unknown as Request, res);

    const tenantFilters = H.eqCalls.filter((c) => c.col === "tenant_id");
    expect(tenantFilters.length).toBeGreaterThanOrEqual(2);
    expect(tenantFilters.every((c) => c.val === TENANT_A)).toBe(true);
    expect(H.eqCalls.some((c) => c.val === TENANT_B)).toBe(false);

    const alpha = res._json.agents.find((a: { slug: string }) => a.slug === "alpha");
    expect(alpha.badge).toBe("green");
  });

  it("404s on a missing/foreign tenant (fails closed, not empty fleet)", async () => {
    H.tenantExists = false;
    const res = mockRes();
    await staffTenantAgentHealth({ params: { tenant_id: "deadbeef-0000-0000-0000-000000000000" } } as unknown as Request, res);
    expect(res._status).toBe(404);
  });

  it("latest run failed (non-whitelisted status) + no success → not green", async () => {
    const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const saved = H.runsByTenant[A];
    H.runsByTenant[A] = [{ agent_slug: "alpha", status: "failed", parse_ok: false, finished_at: "2026-05-30T00:00:00Z" }];
    try {
      const res = mockRes();
      await staffTenantAgentHealth({ params: { tenant_id: A } } as unknown as Request, res);
      const alpha = res._json.agents.find((a: { slug: string }) => a.slug === "alpha");
      expect(alpha.badge).not.toBe("green");
      expect(alpha.badge).toBe("red");
    } finally {
      H.runsByTenant[A] = saved;
    }
  });
});
