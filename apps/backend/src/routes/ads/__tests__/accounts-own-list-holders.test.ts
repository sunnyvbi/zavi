import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const TENANT = "cakely";
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  role: vi.fn(),
  claims: [] as Array<{ provider_account_id: string; credential_source: string; credential_tenant_id: string | null; claim_released_at: string | null }>,
  claimReads: [] as Array<{ table: string; eq: Array<[string, unknown]>; ids: string[] }>,
  claimsFail: false,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => ({ tenant_id: TENANT, user_id: "owner" }) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "allowed" }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: () => {
      throw new Error("no tenant table read expected");
    },
  }),
  globalClient: () => ({
    from: (table: string) => {
      const read = { table, eq: [] as Array<[string, unknown]>, ids: [] as string[] };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          read.eq.push([c, v]);
          return q;
        },
        in: (_c: string, v: string[]) => {
          read.ids = v;
          return q;
        },
        range: async () => {
          m.claimReads.push(read);
          if (m.claimsFail) return { data: null, error: { message: "boom" } };
          return { data: m.claims.filter((c) => read.ids.includes(c.provider_account_id)), error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/connectors/linkedin-ads/account-list-cache", () => ({ linkedinOpenAccountList: m.list, loginManages: async () => null }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: (_t: string, fn: (token: string) => unknown) => fn("tok"),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ readLinkedinAccount: m.read, assertLinkedinCampaignRole: m.role }));

import { adsAvailableAccounts, adsConnectAccount } from "../accounts";
import { LINKEDIN_MANAGED_NOT_OWN } from "@/services/ads-wallet/accounts";

const DEVELOPERS = { id: "559880687", name: "Developer's Ad Account", currency: "USD", status: "ACTIVE" };
const ZAVI_QA = { id: "559148166", name: "Zavi QA", currency: "USD", status: "ACTIVE" };
const HELD = { id: "777", name: "Bakery Ads", currency: "EUR", status: "ACTIVE" };
const RELEASED = { id: "888", name: "Let go", currency: "USD", status: "ACTIVE" };

const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};
const available = async () => {
  const r = res();
  await adsAvailableAccounts({ params: { platform: "linkedin" }, method: "GET", query: {} } as unknown as Request, r);
  expect(r.status).not.toHaveBeenCalled();
  return r.json.mock.calls[0][0] as { accounts: Array<Record<string, unknown>>; fetched_at: string; just_refreshed: boolean };
};
const connect = async (account_id: string) => {
  const r = res();
  await adsConnectAccount({ body: { mode: "customer", account_id }, params: { platform: "linkedin" }, method: "POST" } as unknown as Request, r);
  return r;
};

beforeEach(() => {
  vi.resetAllMocks();
  m.claimsFail = false;
  m.claimReads = [];
  m.claims = [
    { provider_account_id: ZAVI_QA.id, credential_source: "platform", credential_tenant_id: null, claim_released_at: null },
    { provider_account_id: HELD.id, credential_source: "tenant_connector", credential_tenant_id: "other-tenant", claim_released_at: null },
    { provider_account_id: RELEASED.id, credential_source: "tenant_connector", credential_tenant_id: "other-tenant", claim_released_at: "2026-11-01T00:00:00Z" },
    { provider_account_id: DEVELOPERS.id, credential_source: "tenant_connector", credential_tenant_id: TENANT, claim_released_at: null },
  ];
  m.list.mockResolvedValue({ accounts: [DEVELOPERS, ZAVI_QA, HELD, RELEASED], fetched_at: "2026-11-03T09:00:00.000Z", just_refreshed: false });
  m.read.mockImplementation(async (_tok: string, id: string) => ({ id, currency: "USD" }));
  m.role.mockResolvedValue(undefined);
});

it("leaves Zavi's managed account out of Use your own account and marks the one another workspace holds", async () => {
  const body = await available();
  expect(body).toEqual({
    accounts: [DEVELOPERS, { ...HELD, held_elsewhere: true }, RELEASED],
    fetched_at: "2026-11-03T09:00:00.000Z",
    just_refreshed: false,
  });
  expect(body.accounts.find((a) => a.id === DEVELOPERS.id)).not.toHaveProperty("held_elsewhere");
  expect(body.accounts.find((a) => a.id === RELEASED.id)).not.toHaveProperty("held_elsewhere");
  expect(m.claimReads).toEqual([
    { table: "ads_provider_accounts", eq: [["platform", "linkedin"]], ids: [DEVELOPERS.id, ZAVI_QA.id, HELD.id, RELEASED.id] },
  ]);
});

it("serves the plain list when the claims cannot be read, so the panel still loads", async () => {
  m.claimsFail = true;
  const body = await available();
  expect(body.accounts).toEqual([DEVELOPERS, ZAVI_QA, HELD, RELEASED]);
});

it("refuses Zavi's managed account as an own account without saying another workspace holds it", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "account ownership conflict" } });
  const r = await connect(ZAVI_QA.id);
  expect(r.status).toHaveBeenCalledWith(409);
  const body = r.json.mock.calls[0][0];
  expect(body).toEqual({ error: { code: "ads_account_owned_elsewhere", message: LINKEDIN_MANAGED_NOT_OWN } });
  expect(JSON.stringify(body)).not.toContain("another Zavi workspace");
  expect(m.claimReads.map((c) => c.ids)).toEqual([[ZAVI_QA.id]]);
});

it("still says another workspace for an account another workspace really holds", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "account ownership conflict" } });
  const r = await connect(HELD.id);
  expect(r.status).toHaveBeenCalledWith(409);
  expect(r.json.mock.calls[0][0].error.message).toBe(
    "This ad account is already connected to another Zavi workspace. Choose a different account, or disconnect it from the other workspace first.",
  );
});
