import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  detach: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({
          data: { id: "dom-1", tenant_id: "tenant-a", render_service_id: "srv-1", render_custom_domain_id: "cd-1", hostname: "shop.example.com", status: "verified" },
          error: null,
        }),
      };
      return b;
    },
    rpc: (...a: unknown[]) => mocks.rpc(...a),
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  setCustomDomainVerifyState: vi.fn(),
}));
vi.mock("@/services/provisioning/render-custom-domain", () => ({
  verifyRenderCustomDomain: vi.fn(),
  detachRenderCustomDomain: (...a: unknown[]) => mocks.detach(...a),
  getRenderCustomDomainStatus: vi.fn(),
  attachRenderCustomDomain: vi.fn(),
  customDomainDnsRecords: () => [],
}));

import { deleteCustomDomainHandler } from "../website-custom-domains";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as { error?: { code: string } } }) };
}

const req = { params: { id: "dom-1" }, headers: {} } as unknown as Request;

describe("custom-domain delete keeps the row when Render still holds the hostname", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
  });

  it("502s and keeps the row when the Render detach fails", async () => {
    mocks.detach.mockRejectedValue(new Error("render custom-domain detach failed (500): boom"));
    const { res, result } = response();
    await deleteCustomDomainHandler(req, res);
    expect(result().status).toBe(502);
    expect(result().body.error?.code).toBe("render_error");
    expect(mocks.detach).toHaveBeenCalledWith("srv-1", "cd-1");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("drops the row once Render has released the hostname", async () => {
    mocks.detach.mockResolvedValue(undefined);
    const { res, result } = response();
    await deleteCustomDomainHandler(req, res);
    expect(result().status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("delete_tenant_custom_domain", { p_id: "dom-1" });
  });

  it("drops the row when hosting credentials are not configured (nothing to detach)", async () => {
    mocks.detach.mockRejectedValue(new CredentialNotConfigured("RENDER_API_KEY"));
    const { res, result } = response();
    await deleteCustomDomainHandler(req, res);
    expect(result().status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("delete_tenant_custom_domain", { p_id: "dom-1" });
  });
});
