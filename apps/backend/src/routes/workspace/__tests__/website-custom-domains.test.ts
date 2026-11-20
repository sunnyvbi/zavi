
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  row: vi.fn(),
  rpc: vi.fn(),
  svcState: vi.fn(),
  verify: vi.fn(),
  detach: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_auth: unknown, allowed: readonly string[], res: Response) => {
    const role = await mocks.role();
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    }
    return true;
  },
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: mocks.row(), error: null }),
      };
      return b;
    },
    rpc: (...a: unknown[]) => mocks.rpc(...a),
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  setCustomDomainVerifyState: (...a: unknown[]) => mocks.svcState(...a),
}));
vi.mock("@/services/provisioning/render-custom-domain", () => ({
  verifyRenderCustomDomain: (...a: unknown[]) => mocks.verify(...a),
  detachRenderCustomDomain: (...a: unknown[]) => mocks.detach(...a),
  getRenderCustomDomainStatus: (...a: unknown[]) => mocks.status(...a),
  attachRenderCustomDomain: vi.fn(),
  customDomainDnsRecords: () => [],
}));

import {
  verifyCustomDomainHandler,
  deleteCustomDomainHandler,
} from "../website-custom-domains";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body }) };
}

const req = { params: { id: "dom-1" }, headers: {} } as unknown as Request;

describe("custom-domains route — authz + isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.svcState.mockResolvedValue({ data: null, error: null });
    mocks.verify.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue("verified");
  });

  it("verify: 403s a member and never calls Render or the DB", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await verifyCustomDomainHandler(req, res);
    expect(result()).toMatchObject({ status: 403 });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("verify: 404s when the row belongs to another tenant (no cross-tenant reach)", async () => {
    mocks.role.mockResolvedValue("owner");
    mocks.row.mockReturnValue({ id: "dom-1", tenant_id: "tenant-b", render_service_id: "s", render_custom_domain_id: "cd" });
    const { res, result } = response();
    await verifyCustomDomainHandler(req, res);
    expect(result()).toMatchObject({ status: 404 });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("verify: 200s for an owned, attached row and writes verified state", async () => {
    mocks.role.mockResolvedValue("owner");
    mocks.row.mockReturnValue({ id: "dom-1", tenant_id: "tenant-a", render_service_id: "s", render_custom_domain_id: "cd", status: "verifying", dns_records: [] });
    const { res, result } = response();
    await verifyCustomDomainHandler(req, res);
    const out = result() as { status: number; body: { domain?: { status?: string } } };
    expect(out.status).toBe(200);
    expect(out.body.domain?.status).toBe("verified");
    expect(mocks.verify).toHaveBeenCalled();
    expect(mocks.svcState).toHaveBeenCalledWith("tenant-a", { p_id: "dom-1", p_status: "verified", p_last_error: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("verify: writes verifying through the service path, never the caller's JWT client", async () => {
    mocks.role.mockResolvedValue("admin");
    mocks.status.mockResolvedValue("pending");
    mocks.row.mockReturnValue({ id: "dom-1", tenant_id: "tenant-a", render_service_id: "s", render_custom_domain_id: "cd", status: "dns_required", dns_records: [] });
    const { res, result } = response();
    await verifyCustomDomainHandler(req, res);
    expect(result()).toMatchObject({ status: 200 });
    expect(mocks.svcState).toHaveBeenCalledTimes(1);
    expect(mocks.svcState).toHaveBeenCalledWith("tenant-a", { p_id: "dom-1", p_status: "verifying", p_last_error: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("verify: 404 path never reaches the service writer", async () => {
    mocks.role.mockResolvedValue("owner");
    mocks.row.mockReturnValue({ id: "dom-1", tenant_id: "tenant-b", render_service_id: "s", render_custom_domain_id: "cd" });
    const { res } = response();
    await verifyCustomDomainHandler(req, res);
    expect(mocks.svcState).not.toHaveBeenCalled();
  });

  it("delete: 404s when the row belongs to another tenant (no cross-tenant delete)", async () => {
    mocks.role.mockResolvedValue("owner");
    mocks.row.mockReturnValue({ id: "dom-1", tenant_id: "tenant-b", render_service_id: "s", render_custom_domain_id: "cd" });
    const { res, result } = response();
    await deleteCustomDomainHandler(req, res);
    expect(result()).toMatchObject({ status: 404 });
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
