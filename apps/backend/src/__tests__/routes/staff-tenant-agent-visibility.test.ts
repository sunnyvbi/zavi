import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const H = vi.hoisted(() => ({
  tenantsRow: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
  globalDisabled: [] as string[],
  killRows: [] as { agent_slug: string; source: string }[],
  rpcSpy: vi.fn(
    async (): Promise<{ error: { message: string } | null }> => ({
      error: null,
    }),
  ),
  auditSpy: vi.fn(async () => undefined),
}));

function fromImpl(name: string) {
  if (name === "tenants") {
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: H.tenantsRow, error: null }) }) }),
    };
  }
  if (name === "system_config") {
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { blob: { disabled_agent_slugs: H.globalDisabled } }, error: null }) }) }),
    };
  }
  return { select: () => ({ eq: () => Promise.resolve({ data: H.killRows, error: null }) }) };
}

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ from: vi.fn(fromImpl), rpc: H.rpcSpy })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "staff-1", email: "ravi@zaviagent.com" })),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: H.auditSpy }));
vi.mock("@/services/agents/registry", () => ({
  listAgents: vi.fn(() => [
    { slug: "alpha", name: "Alpha", metadata_praxis: {} },
    { slug: "beta", name: "Beta", metadata_praxis: {} },
    { slug: "gamma", name: "Gamma", metadata_praxis: {} },
  ]),
  listAlwaysOnSlugs: vi.fn(() => []),
  listDefaultDisabledSlugs: vi.fn(() => []),
  getAgentDefaultState: vi.fn(() => "enabled"),
}));

import {
  staffTenantVisibilityGet,
  staffTenantVisibilityPost,
} from "../../routes/admin/agent-visibility-tenant";

function mkRes() {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}
const TID = "11111111-1111-4111-8111-111111111111";

describe("staff per-tenant visibility", () => {
  beforeEach(() => {
    H.tenantsRow = { id: TID };
    H.globalDisabled = [];
    H.killRows = [];
    H.rpcSpy.mockClear();
    H.auditSpy.mockClear();
  });

  it("GET 404 when tenant missing", async () => {
    H.tenantsRow = null;
    const { res, status } = mkRes();
    await staffTenantVisibilityGet({ query: { tenant_id: "nope" } } as unknown as Request, res);
    expect(status()).toBe(404);
  });

  it("GET returns per-agent effective state", async () => {
    H.globalDisabled = ["gamma"];
    H.killRows = [{ agent_slug: "alpha", source: "staff" }];
    const { res, status, body } = mkRes();
    await staffTenantVisibilityGet({ query: { tenant_id: TID } } as unknown as Request, res);
    expect(status()).toBe(200);
    const slugs = (body() as { slugs: { slug: string; hidden_global: boolean; hidden_tenant: boolean; source: string | null }[] }).slugs;
    expect(slugs.find((s) => s.slug === "alpha")).toMatchObject({ hidden_tenant: true, source: "staff" });
    expect(slugs.find((s) => s.slug === "gamma")).toMatchObject({ hidden_global: true });
  });

  it("POST unknown slug → atomic 400, no rpc", async () => {
    const { res, status } = mkRes();
    await staffTenantVisibilityPost({ body: { tenant_id: TID, hidden_slugs: ["ghost"] } } as unknown as Request, res);
    expect(status()).toBe(400);
    expect(H.rpcSpy).not.toHaveBeenCalled();
  });

  it("POST global-hidden slug → ignored_global, not applied", async () => {
    H.globalDisabled = ["beta"];
    const { res, status, body } = mkRes();
    await staffTenantVisibilityPost({ body: { tenant_id: TID, hidden_slugs: ["beta", "alpha"] } } as unknown as Request, res);
    expect(status()).toBe(200);
    const b = body() as { applied_hidden: string[]; ignored_global: string[] };
    expect(b.ignored_global).toEqual(["beta"]);
    expect(b.applied_hidden).toEqual(["alpha"]);
    expect(H.rpcSpy).toHaveBeenCalledWith("staff_set_tenant_agent_hidden", expect.objectContaining({ p_agent_slug: "alpha", p_hide: true }));
  });

  it("POST: a failed RPC → 500, NO audit (no silent success)", async () => {
    H.rpcSpy.mockImplementationOnce(async () => ({
      error: { message: "rls denied" },
    }));
    const { res, status, body } = mkRes();
    await staffTenantVisibilityPost(
      { body: { tenant_id: TID, hidden_slugs: ["alpha"] } } as unknown as Request,
      res,
    );
    expect(status()).toBe(500);
    expect((body() as { error: { code: string } }).error.code).toBe("rpc_failed");
    expect(H.auditSpy).not.toHaveBeenCalled();
  });

  it("POST: globally-hidden staff-locked slug is NOT removed by an unrelated save", async () => {
    H.globalDisabled = ["beta"];
    H.killRows = [{ agent_slug: "beta", source: "staff" }];
    const { res, status } = mkRes();
    await staffTenantVisibilityPost(
      { body: { tenant_id: TID, hidden_slugs: ["alpha"] } } as unknown as Request,
      res,
    );
    expect(status()).toBe(200);
    expect(H.rpcSpy).not.toHaveBeenCalledWith(
      "staff_set_tenant_agent_hidden",
      expect.objectContaining({ p_agent_slug: "beta", p_hide: false }),
    );
  });

  it("POST diff: adds new staff hide, removes dropped staff row, audits", async () => {
    H.killRows = [{ agent_slug: "gamma", source: "staff" }, { agent_slug: "beta", source: "tenant" }];
    const { res, status } = mkRes();
    await staffTenantVisibilityPost({ body: { tenant_id: TID, hidden_slugs: ["alpha"] } } as unknown as Request, res);
    expect(status()).toBe(200);
    expect(H.rpcSpy).toHaveBeenCalledWith("staff_set_tenant_agent_hidden", expect.objectContaining({ p_agent_slug: "alpha", p_hide: true }));
    expect(H.rpcSpy).toHaveBeenCalledWith("staff_set_tenant_agent_hidden", expect.objectContaining({ p_agent_slug: "gamma", p_hide: false }));
    expect(H.rpcSpy).not.toHaveBeenCalledWith("staff_set_tenant_agent_hidden", expect.objectContaining({ p_agent_slug: "beta" }));
    expect(H.auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "agent_visibility.tenant.update" }));
  });
});
