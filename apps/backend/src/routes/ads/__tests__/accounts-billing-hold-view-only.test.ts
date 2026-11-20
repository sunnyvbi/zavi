import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const OLD_BINDING = "10000000-0000-4000-8000-000000000001";
const NEW_BINDING = "10000000-0000-4000-8000-000000000002";
const WALLET_BINDING = "10000000-0000-4000-8000-000000000003";
const OLD_CHOICES = () => ({
  accounts: [
    { id: OLD_BINDING, platform: "linkedin", provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false },
    { id: WALLET_BINDING, platform: "linkedin", provider_account_id: "910000001", funding_source: "wallet", currency: "USD", disabled: false },
  ],
  managed: [{ account_id: "managed", label: "Zavi account", platform: "linkedin" }],
  selected_id: OLD_BINDING,
});
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  token: vi.fn(),
  choices: vi.fn(),
  secret: vi.fn(),
  verify: vi.fn(),
  meta: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.role }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "blocked" }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.lock }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: m.token, forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", async (original) => ({
  ...(await original<typeof import("@/services/tenant-client")>()),
  platformSecretRpc: m.secret,
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: m.meta }) }) }) }),
}));
vi.mock("@/services/ads-wallet/bindings", async (original) => ({ ...(await original<typeof import("@/services/ads-wallet/bindings")>()), verifyAccountBinding: m.verify }));
vi.mock("@/services/ads-wallet/accounts", async (original) => ({ ...(await original<typeof import("@/services/ads-wallet/accounts")>()), accountChoices: m.choices }));

import { adsAccounts, adsAvailableAccounts } from "../accounts";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { linkedinManagedAccountIds } from "@/services/ads-wallet/adapters/linkedin-account";

type Listed = { id: number; name: string; currency: string; status: string; servingStatuses?: string[] };
const OLD_ACCOUNT: Listed = { id: 559148166, name: "Zavi QA", currency: "USD", status: "ACTIVE" };
const NEW_ACCOUNT: Listed = { id: 560026764, name: "Mohit's Ad Account", currency: "USD", status: "ACTIVE" };
const logins: Record<string, Listed[] | number> = {};
const listCalls: string[] = [];
const req = () => ({ params: { platform: "linkedin" }, method: "GET", query: {} }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};
const page = async (read: (req: Request, res: Response) => Promise<unknown> = adsAccounts) => {
  const r = res();
  await read(req(), r);
  expect(r.status).not.toHaveBeenCalled();
  return r.json.mock.calls[0][0] as { accounts: Array<Record<string, unknown>>; selected_id: string | null; unseen_selected_id?: string | null };
};
const byId = (body: { accounts: Array<Record<string, unknown>> }, id: string) => body.accounts.find((a) => a.id === id)!;

const calls: string[] = [];
let roles: Array<{ account: string; role: string }> = [];
beforeEach(() => {
  vi.clearAllMocks();
  resetLinkedInAdsReadCache();
  calls.length = 0;
  roles = [];
  m.auth.mockResolvedValue({ tenant_id: "tenant", user_id: "owner" });
  m.role.mockResolvedValue(true);
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.token.mockResolvedValue("old-login");
  m.choices.mockImplementation(async () => OLD_CHOICES());
  m.meta.mockResolvedValue({ data: { team_id: "old", connected_at: "2026-10-01T00:00:00Z" }, error: null });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/adAccounts"))
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ elements: [{ ...OLD_ACCOUNT, servingStatuses: ["BILLING_HOLD"] }, NEW_ACCOUNT], metadata: {} }) };
    if (path.endsWith("/adAccountUsers"))
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ elements: roles, paging: { total: roles.length } }) };
    throw new Error(`unexpected LinkedIn read ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("money: flags the founder's own account on LinkedIn billing hold in the panel and in the account picker, from the one account list read", async () => {
  const panel = await page();
  expect(byId(panel, OLD_BINDING)).toMatchObject({ billing_hold: true });
  expect(byId(panel, WALLET_BINDING)).not.toHaveProperty("billing_hold");
  const available = await page(adsAvailableAccounts);
  expect(available.accounts.map((a) => [a.id, a.billing_hold ?? false])).toEqual([["559148166", true], ["560026764", false]]);
  expect(calls.filter((p) => p.endsWith("/adAccounts"))).toHaveLength(1);
});

it("marks an own account the login can only view, using the role read Zavi already cached, and makes no role call of its own", async () => {
  await page();
  expect(byId(await page(), OLD_BINDING)).not.toHaveProperty("view_only");
  expect(calls.filter((p) => p.endsWith("/adAccountUsers"))).toHaveLength(0);
  roles = [{ account: "urn:li:sponsoredAccount:559148166", role: "VIEWER" }];
  await linkedinManagedAccountIds("old-login", false);
  const before = calls.length;
  const panel = await page();
  expect(byId(panel, OLD_BINDING)).toMatchObject({ view_only: true });
  expect(byId(panel, WALLET_BINDING)).not.toHaveProperty("view_only");
  expect(calls.length).toBe(before);
});

it("does not mark an own account the login manages", async () => {
  roles = [{ account: "urn:li:sponsoredAccount:559148166", role: "CAMPAIGN_MANAGER" }];
  await linkedinManagedAccountIds("old-login", false);
  expect(byId(await page(), OLD_BINDING)).not.toHaveProperty("view_only");
});
