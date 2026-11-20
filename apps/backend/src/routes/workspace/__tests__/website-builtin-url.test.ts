
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  rpc: vi.fn(),
  setSub: vi.fn(),
  clearSub: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: readonly string[], res: Response) => {
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
        order: () => b,
        maybeSingle: async () => ({ data: null }),
        limit: async () => ({ data: [] }),
      };
      return b;
    },
    rpc: (...a: unknown[]) => mocks.rpc(...a),
  }),
}));
vi.mock("@/services/provisioning/builtin-url", async (orig) => {
  const actual = await orig<typeof import("@/services/provisioning/builtin-url")>();
  return { ...actual, setBuiltinSubdomain: mocks.setSub, clearBuiltinSubdomain: mocks.clearSub };
});
vi.mock("@/services/provisioning/render-custom-domain", () => ({ getRenderCustomDomainStatus: vi.fn(), verifyRenderCustomDomain: vi.fn() }));
vi.mock("@/services/provisioning/cloudflare-dns", () => ({ ensureDnsCname: vi.fn(async () => ({ record_id: null, skipped: true })) }));

import { setBuiltinUrlHandler, deleteBuiltinUrlHandler } from "../website-builtin-url";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body }) };
}

describe("built-in URL route — authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
  });

  it("POST 403s a member and never attaches a subdomain", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await setBuiltinUrlHandler({ body: { label: "cool-app" }, headers: {} } as unknown as Request, res);
    expect(result()).toMatchObject({ status: 403 });
    expect(mocks.setSub).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("DELETE 403s a member and never clears a subdomain", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await deleteBuiltinUrlHandler({ headers: {} } as unknown as Request, res);
    expect(result()).toMatchObject({ status: 403 });
    expect(mocks.clearSub).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("POST 400s an invalid label before any provider call", async () => {
    mocks.role.mockResolvedValue("owner");
    const { res, result } = response();
    await setBuiltinUrlHandler({ body: { label: "bad label!" }, headers: {} } as unknown as Request, res);
    expect(result()).toMatchObject({ status: 400 });
    expect(mocks.setSub).not.toHaveBeenCalled();
  });
});
