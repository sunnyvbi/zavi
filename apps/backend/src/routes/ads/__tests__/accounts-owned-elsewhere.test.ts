import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const OTHER_TENANT_ID = "9a1c7e44-2b3d-4f5e-8a6b-c0d1e2f30405";
const OTHER_TENANT_SLUG = "bakery-309b8b";
const OTHER_TENANT_NAME = "Bakery";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  read: vi.fn(),
  token: vi.fn(),
  role: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "cakely", user_id: "owner" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "allowed" }));
vi.mock("@/services/agents/entitlement", () => ({
  checkAgentTier: async () => ({ allowed: true, enforced: true }),
}));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({ from: m.from }),
}));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: (tenant: string, fn: (token: string) => unknown) => m.token(tenant, fn),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  readLinkedinAccount: m.read,
  assertLinkedinCampaignRole: m.role,
}));

import { adsConnectAccount } from "../accounts";
import { connectCustomerAccount } from "@/services/ads-wallet/accounts";

const req = (body: unknown) =>
  ({ body, params: { platform: "linkedin" }, method: "POST" }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};
const conflict = {
  data: null,
  error: {
    code: "P0001",
    message: "account ownership conflict",
    details: `credential_tenant_id=${OTHER_TENANT_ID} slug=${OTHER_TENANT_SLUG} name=${OTHER_TENANT_NAME}`,
    hint: null,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  m.token.mockImplementation((_t: string, fn: (token: string) => unknown) => fn("tok"));
  m.read.mockResolvedValue({ id: "559880687", currency: "USD" });
  m.role.mockResolvedValue(undefined);
  m.from.mockImplementation(() => {
    throw new Error("no table read expected after a refused registration");
  });
});

it("refuses a LinkedIn account owned by another workspace with its own code, plain copy and no foreign identity", async () => {
  m.rpc.mockResolvedValue(conflict);
  const r = res();
  await adsConnectAccount(req({ mode: "customer", account_id: "559880687" }), r);
  expect(m.rpc).toHaveBeenCalledTimes(1);
  expect(m.rpc).toHaveBeenCalledWith("cakely", "ads_register_customer_account", {
    p_platform: "linkedin",
    p_provider_account_id: "559880687",
    p_currency: "USD",
    p_credential_ref: "linkedin_ads.access_token",
  });
  expect(r.status).toHaveBeenCalledWith(409);
  const body = r.json.mock.calls[0][0];
  expect(body).toEqual({
    error: {
      code: "ads_account_owned_elsewhere",
      message:
        "This ad account is already connected to another Zavi workspace. Choose a different account, or disconnect it from the other workspace first.",
    },
  });
  const wire = JSON.stringify(body);
  for (const leak of [OTHER_TENANT_ID, OTHER_TENANT_SLUG, OTHER_TENANT_NAME, "credential_tenant_id", "P0001"])
    expect(wire).not.toContain(leak);
  expect(wire).not.toContain("could not be verified");
  expect(m.from).not.toHaveBeenCalled();
});

it("keeps the launch path refusal distinct when the account is registered without selecting it", async () => {
  m.rpc.mockResolvedValue(conflict);
  await expect(connectCustomerAccount("cakely", "linkedin", "559880687", false)).rejects.toMatchObject({
    code: "ads_account_owned_elsewhere",
  });
});

it.each([
  { data: null, error: { code: "P0001", message: "unsupported account credential" } },
  { data: null, error: { code: "P0001", message: "account ownership conflict on a different row" } },
  { data: null, error: { code: "40001", message: "could not serialize access" } },
  { data: null, error: { code: "PGRST202", message: "Could not find the function" } },
  { data: 42, error: null },
])("maps every other registration failure %o to ads_accounts_unavailable", async (out) => {
  m.rpc.mockResolvedValue(out);
  const r = res();
  await adsConnectAccount(req({ mode: "customer", account_id: "559880687" }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  expect(r.json.mock.calls[0][0]).toEqual({
    error: {
      code: "ads_accounts_unavailable",
      message: "Ad accounts could not be verified. Refresh and try again.",
    },
  });
});
