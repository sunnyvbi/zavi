import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  rpc: vi.fn(),
  resolve: vi.fn(),
  consent: vi.fn(),
  disabled: new Set<string>(),
  statusError: false,
  selected: null as string | null,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.role }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "allowed" }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.lock }));
vi.mock("@/services/ads-wallet/consent", () => ({
  SHARED_WALLET_CONSENT_VERSION: "shared_ads_wallet_v1",
  SHARED_WALLET_CONSENT_TEXT: "Shared consent",
  sharedWalletConsent: async () => true,
  requireSharedWalletConsent: m.consent,
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: m.resolve }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filters[col] = v;
          return q;
        },
        maybeSingle: async () => {
          if (table === "ads_account_binding_details")
            return {
              data: {
                id: filters.id, tenant_id: tenant, account_id: "acct", platform: "linkedin",
                provider_account_id: "501", currency: "USD", verified_at: "2026-10-01",
                credential_source: "tenant_connector", credential_ref: "linkedin_ads.access_token",
                credential_tenant_id: tenant, funding_source: "provider", legacy_key: null,
              },
              error: null,
            };
          if (table === "ads_account_binding_status") {
            if (m.statusError) return { data: null, error: { message: "down" } };
            const id = filters.account_binding_id as string;
            return { data: { account_binding_id: id, disabled_at: m.disabled.has(id) ? "2026-10-20T00:00:00Z" : null }, error: null };
          }
          return { data: null, error: { message: `unexpected ${table}` } };
        },
      };
      return q;
    },
  }),
}));
import { adsSelectAccount } from "../accounts";

const ID = "10000000-0000-4000-8000-000000000001";
const req = (body: unknown) => ({ body, params: { platform: "linkedin" }, method: "POST" }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.resetAllMocks();
  m.disabled = new Set();
  m.statusError = false;
  m.selected = null;
  m.auth.mockResolvedValue({ tenant_id: "verified", user_id: "owner" });
  m.role.mockResolvedValue(true);
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.resolve.mockResolvedValue({ token: "t", account: { id: "501" } });
  m.rpc.mockImplementation(async (_tenant: string, name: string, args: { p_binding_id: string }) => {
    if (name !== "ads_select_account_binding") return { data: null, error: { message: `unexpected ${name}` } };
    if (m.disabled.has(args.p_binding_id)) return { data: null, error: { message: "account selection unavailable" } };
    m.selected = args.p_binding_id;
    return { data: null, error: null };
  });
});

it("refuses a stopped account with a clear 409 and never calls LinkedIn or the selection write", async () => {
  m.disabled.add(ID);
  const r = res();
  await adsSelectAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(409);
  expect(r.json).toHaveBeenCalledWith({
    error: {
      code: "ads_account_disabled",
      message: "This account is stopped for new campaigns. Choose Use this account again to turn it back on, or pick another account.",
    },
  });
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.selected).toBeNull();
});

it("selects an account that is in use", async () => {
  const r = res();
  await adsSelectAccount(req({ account_binding_id: ID }), r);
  expect(r.status).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({ ok: true });
  expect(m.resolve).toHaveBeenCalledWith("verified", expect.objectContaining({ id: ID }), true, false);
  expect(m.selected).toBe(ID);
});

it("keeps a non-disabled selection failure as 503 ads_binding_unavailable", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { message: "account selection unavailable" } });
  const r = res();
  await adsSelectAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  expect(r.json).toHaveBeenCalledWith({
    error: { code: "ads_binding_unavailable", message: "The campaign account could not be verified. Refresh before trying again." },
  });
});

it("does not guess when the account status cannot be read", async () => {
  m.statusError = true;
  const r = res();
  await adsSelectAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  expect(r.json.mock.calls[0][0].error.code).toBe("ads_accounts_unavailable");
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.rpc).not.toHaveBeenCalled();
});
