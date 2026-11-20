
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

let authResult: { tenant_id: string; user_id: string; access_token: string; tenant_overridden?: boolean } | null = null;
let roleAllowed = true;
const h = vi.hoisted(() => ({ create: vi.fn(), options: vi.fn(), locked: vi.fn() }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({});
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: unknown, res: Response) => {
    if (roleAllowed) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: h.locked }));
vi.mock("@/services/tools/meta-ads/write/boost_post", () => ({
  BOOST_REASON_TEXT: { page_permission_missing: "x", no_page: "y" },
  createBoostAd: h.create,
  readBoostOptions: h.options,
}));

import { metaBoostCreate, metaBoostOptions } from "../meta-boost";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
const body = { page_id: "100", post_id: "100_7", ad_set_id: "555", request_id: "req-12345678" };

beforeEach(() => {
  authResult = { tenant_id: TENANT, user_id: "u", access_token: "t" };
  roleAllowed = true;
  h.create.mockReset().mockResolvedValue({ ad_id: "ad-1", status: "PAUSED", ads_manager_url: "https://adsmanager.facebook.com/x" });
  h.options.mockReset().mockResolvedValue({ eligible: false, reason_code: "no_page", reason: "y" });
  h.locked.mockReset().mockResolvedValue(null);
});

describe("POST /api/channels/meta_ads/boost", () => {
  it("creates the paused ad for the caller's own tenant", async () => {
    const r = res();
    await metaBoostCreate({ body } as unknown as Request, r as never);
    expect(h.create).toHaveBeenCalledWith(TENANT, { page_id: "100", post_id: "100_7", ad_set_id: "555" });
    expect(r._body).toMatchObject({ ad_id: "ad-1", status: "PAUSED" });
  });

  it("refuses an override session, a non-owner, a locked plan and a malformed id", async () => {
    authResult = { ...authResult!, tenant_overridden: true };
    const a = res();
    await metaBoostCreate({ body } as unknown as Request, a as never);
    expect(a._status).toBe(403);
    authResult = { tenant_id: TENANT, user_id: "u", access_token: "t" };
    roleAllowed = false;
    const b = res();
    await metaBoostCreate({ body } as unknown as Request, b as never);
    expect(b._status).toBe(403);
    roleAllowed = true;
    h.locked.mockResolvedValue({ body: { error: { code: "plan_upgrade_required" } } });
    const c = res();
    await metaBoostCreate({ body } as unknown as Request, c as never);
    expect(c._status).toBe(403);
    h.locked.mockResolvedValue(null);
    const d = res();
    await metaBoostCreate({ body: { ...body, ad_set_id: "act_1" } } as unknown as Request, d as never);
    expect(d._status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("maps a refusal to 409 and a Meta failure to 502", async () => {
    h.create.mockRejectedValueOnce(new ExpectedToolError("meta_ads_boost_page_not_promotable", "no"));
    const a = res();
    await metaBoostCreate({ body } as unknown as Request, a as never);
    expect(a._status).toBe(409);
    h.create.mockRejectedValueOnce(new ExpectedToolError("meta_ads_write_failed", "graph"));
    const b = res();
    await metaBoostCreate({ body } as unknown as Request, b as never);
    expect(b._status).toBe(502);
  });
});

describe("GET /api/channels/meta_ads/boost/options", () => {
  it("passes the picked Page through and returns the service's answer", async () => {
    const r = res();
    await metaBoostOptions({ query: { page_id: "200" } } as unknown as Request, r as never);
    expect(h.options).toHaveBeenCalledWith(TENANT, "200");
    expect(r._body).toMatchObject({ eligible: false, reason_code: "no_page" });
  });
});
