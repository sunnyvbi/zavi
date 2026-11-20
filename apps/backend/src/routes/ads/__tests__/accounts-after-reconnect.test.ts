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
import { resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { ExpectedToolError } from "@/services/tools/types";
import type { AccountBinding } from "@/services/ads-wallet/bindings";

type Listed = { id: number; name: string; currency: string; status: string };
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

beforeEach(() => {
  vi.clearAllMocks();
  resetLinkedInAdsReadCache();
  for (const k of Object.keys(logins)) delete logins[k];
  listCalls.length = 0;
  m.auth.mockResolvedValue({ tenant_id: "tenant", user_id: "owner" });
  m.role.mockResolvedValue(true);
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.token.mockResolvedValue("old-login");
  m.choices.mockImplementation(async () => OLD_CHOICES());
  m.meta.mockResolvedValue({ data: { team_id: "old", connected_at: "2026-10-01T00:00:00Z" }, error: null });
  logins["old-login"] = [OLD_ACCOUNT];
  logins["new-login"] = [NEW_ACCOUNT];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    if (new URL(url).pathname.endsWith("/adAccounts")) {
      listCalls.push(token);
      const reply = logins[token];
      if (typeof reply === "number") return { ok: false, status: reply, headers: new Headers(), text: async () => "{}", json: async () => ({}) };
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ elements: reply, metadata: {} }) };
    }
    if (/\/adAccounts\/910000001$/.test(new URL(url).pathname)) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 910000001, currency: "USD", status: "ACTIVE" }) };
    throw new Error(`unexpected LinkedIn read ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("after reconnecting as a login that cannot see the saved account, the same read drops it from selection and the new login's accounts replace it", async () => {
  const before = await page();
  expect(before.selected_id).toBe(OLD_BINDING);
  expect(byId(before, OLD_BINDING)).not.toHaveProperty("not_on_login");
  expect((await page(adsAvailableAccounts)).accounts.map((a) => a.id)).toEqual(["559148166"]);

  m.token.mockResolvedValue("new-login");
  const after = await page();
  expect(after.selected_id).toBeNull();
  expect(after.unseen_selected_id).toBe(OLD_BINDING);
  expect(byId(after, OLD_BINDING)).toMatchObject({ not_on_login: true, provider_account_id: "559148166" });
  expect((await page(adsAvailableAccounts)).accounts.map((a) => a.id)).toEqual(["560026764"]);
});

it("keeps the wallet account usable and selected across the reconnect: it runs on the platform credential", async () => {
  m.choices.mockImplementation(async () => ({ ...OLD_CHOICES(), selected_id: WALLET_BINDING }));
  m.token.mockResolvedValue("new-login");
  const after = await page();
  expect(after.selected_id).toBe(WALLET_BINDING);
  expect(after.unseen_selected_id).toBeNull();
  expect(byId(after, WALLET_BINDING)).not.toHaveProperty("not_on_login");
  expect(byId(after, OLD_BINDING)).toMatchObject({ not_on_login: true });
});

it("treats every own account as gone while LinkedIn Ads is disconnected, and keeps the row so its campaigns stay on the page", async () => {
  m.token.mockResolvedValue(null);
  const after = await page();
  expect(after.selected_id).toBeNull();
  expect(after.accounts).toHaveLength(2);
  expect(byId(after, OLD_BINDING)).toMatchObject({ not_on_login: true });
  expect(byId(after, WALLET_BINDING)).not.toHaveProperty("not_on_login");
});

it("never hides an account on a failed read: a rate limit is not proof the login lost it", async () => {
  m.token.mockResolvedValue("new-login");
  logins["new-login"] = 429;
  const after = await page();
  expect(after.selected_id).toBe(OLD_BINDING);
  expect(byId(after, OLD_BINDING)).not.toHaveProperty("not_on_login");
});

it("rereads before calling an account gone, so one added to the login since the list was cached stays selected", async () => {
  logins["old-login"] = [NEW_ACCOUNT];
  await page(adsAvailableAccounts);
  listCalls.length = 0;
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
  logins["old-login"] = [NEW_ACCOUNT, OLD_ACCOUNT];
  const after = await page();
  expect(listCalls).toEqual(["old-login"]);
  expect(after.selected_id).toBe(OLD_BINDING);
  expect(byId(after, OLD_BINDING)).not.toHaveProperty("not_on_login");
  vi.restoreAllMocks();
});

it("non-regression guard: a canceled account is not offered as usable", async () => {
  logins["old-login"] = [{ ...OLD_ACCOUNT, status: "CANCELED" }];
  const after = await page();
  expect(after.selected_id).toBeNull();
});

it("non-regression guard: a settled login costs no extra LinkedIn read on repeat page reads", async () => {
  await page();
  await page();
  expect(listCalls).toEqual(["old-login"]);
});

it("non-regression guard: a wallet campaign still resolves on the platform secret with the tenant connector gone, so it stays pausable", async () => {
  m.token.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "not connected"));
  m.secret.mockResolvedValue({ data: "platform-token", error: null });
  const binding = { id: WALLET_BINDING, tenant_id: "tenant", platform: "linkedin", provider_account_id: "910000001", credential_source: "platform", credential_tenant_id: null, credential_ref: "linkedin_ads_managed_one", funding_source: "wallet" } as unknown as AccountBinding;
  const { token, account } = await resolveLinkedinAccount("tenant", binding, false, false, true);
  expect(token).toBe("platform-token");
  expect(account.id).toBe("910000001");
  expect(m.token).not.toHaveBeenCalled();
});

it("gives a reconnect a new stamp even when the new login sees exactly the same accounts, so an error from the old login can be dropped", async () => {
  logins["new-login"] = [OLD_ACCOUNT];
  const before = (await page()) as { connection?: string | null; selected_id: string | null };
  m.token.mockResolvedValue("new-login");
  m.meta.mockResolvedValue({ data: { team_id: "old", connected_at: "2026-10-30T00:00:00Z" }, error: null });
  const after = (await page()) as { connection?: string | null; selected_id: string | null };
  expect(before.connection).toMatch(/^[0-9a-f]{16}$/);
  expect(after.connection).toMatch(/^[0-9a-f]{16}$/);
  expect(after.connection).not.toBe(before.connection);
  expect(after.selected_id).toBe(OLD_BINDING);
});

it("says none once disconnected, and keeps answering with no stamp when that one read fails", async () => {
  m.meta.mockResolvedValue({ data: null, error: null });
  m.token.mockResolvedValue(null);
  expect(((await page()) as { connection?: string | null }).connection).toBe("none");
  m.meta.mockResolvedValue({ data: null, error: { message: "db down" } });
  const failed = (await page()) as { connection?: string | null; accounts: unknown[] };
  expect(failed.connection).toBeNull();
  expect(failed.accounts).toHaveLength(2);
  m.meta.mockRejectedValue(new Error("db gone"));
  expect(((await page()) as { connection?: string | null }).connection).toBeNull();
});

it("never leaks the connector row: the stamp does not contain the team id or the connection time", async () => {
  m.meta.mockResolvedValue({ data: { team_id: "secretteam", connected_at: "2026-10-01T00:00:00Z" }, error: null });
  expect(JSON.stringify(await page())).not.toMatch(/secretteam|2026-10-01/);
});

it("non-regression guard: the old login's list landing after the new login's cannot be served to the new login", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String((init?.headers as Record<string, string>).Authorization).endsWith("old-login")) await gate;
    return real(url, init);
  });
  const slow = page(adsAvailableAccounts);
  await vi.waitFor(() => expect(m.token).toHaveBeenCalled());
  m.token.mockResolvedValue("new-login");
  expect((await page(adsAvailableAccounts)).accounts.map((a) => a.id)).toEqual(["560026764"]);
  release();
  await slow;
  expect((await page(adsAvailableAccounts)).accounts.map((a) => a.id)).toEqual(["560026764"]);
});
