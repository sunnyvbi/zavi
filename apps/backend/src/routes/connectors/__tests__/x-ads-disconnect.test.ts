import { beforeEach, describe, expect, it, vi } from "vitest";
const audit = vi.hoisted(() => ({ record: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: audit.record }));
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { rpc, requireAuth, serverClientFromBearer } = vi.hoisted(() => ({
  rpc: vi.fn(), requireAuth: vi.fn(), serverClientFromBearer: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth }));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer }));
vi.mock("@/services/tenant-client", () => ({ oauthCallbackClient: vi.fn() }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: vi.fn() }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));
vi.mock("@/services/connectors/x-ads/oauth1", () => ({ accessToken: vi.fn(), requestToken: vi.fn() }));
vi.mock("@/services/connectors/x-ads/client", () => ({ listXAdAccountsRaw: vi.fn() }));

import { xAdsDisconnect } from "../x-ads";

function mockRes() {
  const status = vi.fn();
  const json = vi.fn();
  const res = { status, json };
  status.mockReturnValue(res);
  json.mockReturnValue(res);
  return { res: res as unknown as Response, status, json };
}
const req = {
  body: { tenant_id: "other-tenant", slug: "x_social" },
  query: { tenant_id: "other-tenant" },
} as unknown as Request;

beforeEach(() => {
  audit.record.mockClear();
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ user_id: "user-A", tenant_id: "tenant-A", access_token: "caller-jwt" });
  serverClientFromBearer.mockReturnValue({ rpc });
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("X Ads disconnect", () => {
  it("uses the caller's identity and tenant to tear down only X Ads", async () => {
    const { res, json } = mockRes();
    await xAdsDisconnect(req, res);
    expect(serverClientFromBearer).toHaveBeenCalledWith("caller-jwt");
    expect(rpc).toHaveBeenCalledWith("disconnect_connector", {
      p_tenant_id: "tenant-A", p_slug: "x_ads", p_server_id: "x_ads",
    });
    expect(json).toHaveBeenCalledWith({ ok: true });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("does not touch credentials when unauthenticated", async () => {
    requireAuth.mockResolvedValue(null);
    await xAdsDisconnect(req, mockRes().res);
    expect(serverClientFromBearer).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", 403, "not_admin"],
    ["PGRST202", 500, "rpc_missing"],
    ["42883", 500, "rpc_missing"],
    ["XX000", 500, "rpc_failed"],
  ])("maps database error %s to %s %s", async (code, statusCode, responseCode) => {
    rpc.mockResolvedValue({ error: { code, message: "Database rejected disconnect" } });
    const { res, status, json } = mockRes();
    await xAdsDisconnect(req, res);
    expect(status).toHaveBeenCalledWith(statusCode);
    expect(json).toHaveBeenCalledWith({ error: { code: responseCode, message: expect.any(String) } });
    expect(json).not.toHaveBeenCalledWith({ ok: true });
  });

  it("registers the dedicated endpoint before the generic fallback", () => {
    const routes = readFileSync(join(__dirname, "../../index.ts"), "utf8");
    const dedicated = routes.indexOf('app.post("/api/connectors/x_ads/disconnect", xAdsDisconnect)');
    const generic = routes.indexOf('app.post("/api/connectors/:connector/disconnect", connectorDisconnect)');
    expect(dedicated).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(dedicated);
  });
});
