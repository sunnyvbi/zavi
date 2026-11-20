import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ verify: vi.fn(), get: vi.fn(), select: vi.fn(), consent: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ verifyAccountBinding: m.verify, getAccountBinding: m.get, selectAccountBinding: m.select }));
vi.mock("@/services/ads-wallet/consent", () => ({ requireSharedWalletConsent: m.consent }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: vi.fn(),
  platformSecretRpc: vi.fn(),
  tenantClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { disabled_at: null }, error: null }) };
      return q;
    },
  }),
}));

import { resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { listLinkedInAdAccountsWithReference } from "../client";
import { countLinkedInAdsCalls, LINKEDIN_ADS_BILLING_HOLD, LINKEDIN_ADS_SETTINGS_REFUSED, linkedinAdsPost, resetLinkedInAdsReadCache } from "../http";
import { chooseAccount, customerAccountChoices } from "@/services/ads-wallet/accounts";
import { ExpectedToolError } from "@/services/tools/types";
import type { AccountBinding } from "@/services/ads-wallet/bindings";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const held = { id: 11, name: "Acme Ads", currency: "USD", status: "ACTIVE", servingStatuses: ["BILLING_HOLD"], reference: "urn:li:organization:42" };
const binding = {
  id: "b1",
  tenant_id: "tenant",
  platform: "linkedin",
  provider_account_id: "11",
  credential_source: "tenant_connector",
  credential_tenant_id: "tenant",
  credential_ref: "linkedin_ads.access_token",
  funding_source: "provider",
} as unknown as AccountBinding;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e as ExpectedToolError);

beforeEach(() => {
  fetchMock.mockReset();
  m.verify.mockReset().mockResolvedValue(undefined);
  m.get.mockReset().mockResolvedValue(binding);
  m.select.mockReset().mockResolvedValue(undefined);
  m.consent.mockReset();
  resetLinkedInAdsReadCache();
  vi.stubGlobal("fetch", fetchMock);
});

it("refuses a write on an account on billing hold with the billing words, using only the account read it already makes", async () => {
  fetchMock.mockResolvedValue(json(held));
  const run = countLinkedInAdsCalls(() => resolveLinkedinAccount("tenant", binding, true));
  const e = await caught(run.result);
  expect(e).toBeInstanceOf(ExpectedToolError);
  expect(e).toMatchObject({ code: "linkedin_ads_write_refused", message: LINKEDIN_ADS_BILLING_HOLD, meta: { billing_hold: true } });
  expect(LINKEDIN_ADS_BILLING_HOLD).toBe("LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again.");
  expect(run.calls).toEqual(["GET adAccounts"]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("lets the review read a held account, so the founder still sees the draft", async () => {
  fetchMock.mockResolvedValue(json(held));
  await expect(resolveLinkedinAccount("tenant", binding)).resolves.toMatchObject({ account: { id: "11", servingStatuses: ["BILLING_HOLD"] } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("lets a runnable account through to the role check", async () => {
  fetchMock.mockResolvedValueOnce(json({ ...held, servingStatuses: ["RUNNABLE"] })).mockResolvedValueOnce(json({ elements: [{ account: "urn:li:sponsoredAccount:11", role: "CAMPAIGN_MANAGER" }] }));
  await expect(resolveLinkedinAccount("tenant", binding, true)).resolves.toMatchObject({ account: { id: "11" } });
});

it("carries the serving statuses through the cached account list", async () => {
  fetchMock.mockResolvedValue(json({ elements: [held, { ...held, id: 12, servingStatuses: undefined }] }));
  expect((await listLinkedInAdAccountsWithReference("tenant")).map((a) => [a.id, a.servingStatuses])).toEqual([["11", ["BILLING_HOLD"]], ["12", []]]);
});

it("turns a LinkedIn refusal that names the billing hold into the billing words, not a settings problem", async () => {
  fetchMock.mockResolvedValue(json({ status: 400, message: "Account 11 is on BILLING_HOLD and cannot serve" }, 400));
  const e = await caught(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}));
  expect(e).toMatchObject({ code: "linkedin_ads_write_refused", message: LINKEDIN_ADS_BILLING_HOLD, meta: { billing_hold: true, http_status: 400 } });
});

it("keeps the settings words for an ordinary refusal", async () => {
  fetchMock.mockResolvedValue(json({ status: 400, message: "dailyBudget is below the minimum" }, 400));
  const e = await caught(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}));
  expect(e.message).toBe(LINKEDIN_ADS_SETTINGS_REFUSED);
  expect(e.meta?.billing_hold).toBeUndefined();
});

it("lets the founder choose a held account for new campaigns: the account and role are still proven, but the hold does not block the choice", async () => {
  fetchMock.mockResolvedValueOnce(json(held)).mockResolvedValueOnce(json({ elements: [{ account: "urn:li:sponsoredAccount:11", role: "CAMPAIGN_MANAGER" }] }));
  const run = countLinkedInAdsCalls(() => chooseAccount("tenant", "linkedin", "b1"));
  await expect(run.result).resolves.toBeUndefined();
  expect(run.calls).toEqual(["GET adAccounts", "GET adAccountUsers"]);
  expect(m.verify).toHaveBeenCalledWith("tenant", binding, "11", "USD");
  expect(m.select).toHaveBeenCalledWith("tenant", "b1");
});

it("still refuses choosing a held account the login cannot manage, and saves nothing", async () => {
  fetchMock.mockResolvedValueOnce(json(held)).mockResolvedValueOnce(json({ elements: [{ account: "urn:li:sponsoredAccount:11", role: "VIEWER" }] }));
  await expect(chooseAccount("tenant", "linkedin", "b1")).rejects.toMatchObject({ code: "ads_account_read_only" });
  expect(m.select).not.toHaveBeenCalled();
});

it("the create-time check on the same held account still refuses with the billing words", async () => {
  fetchMock.mockResolvedValue(json(held));
  await expect(resolveLinkedinAccount("tenant", binding, true)).rejects.toMatchObject({ code: "linkedin_ads_write_refused", message: LINKEDIN_ADS_BILLING_HOLD });
});

it("Find connected accounts asks LinkedIn again instead of serving the account list another screen cached a moment ago", async () => {
  fetchMock.mockResolvedValueOnce(json({ elements: [held] }));
  const { listLinkedInAdAccounts } = await import("../client");
  expect((await listLinkedInAdAccounts("tenant")).map((a) => a.id)).toEqual(["11"]);
  fetchMock.mockResolvedValueOnce(json({ elements: [held, { ...held, id: 12, name: "Newly invited", servingStatuses: ["RUNNABLE"] }] }));
  expect((await customerAccountChoices("tenant", "linkedin")).accounts.map((a) => a.id)).toEqual(["11", "12"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("must catch: an available account the login can only view is marked view_only from the role read already cached, so the page never auto-binds it", async () => {
  fetchMock.mockResolvedValueOnce(json({ elements: [{ account: "urn:li:sponsoredAccount:11", role: "VIEWER" }, { account: "urn:li:sponsoredAccount:12", role: "CAMPAIGN_MANAGER" }], paging: { total: 2 } }));
  const { linkedinManagedAccountIds } = await import("@/services/ads-wallet/adapters/linkedin-account");
  expect([...((await linkedinManagedAccountIds("tok", true)) ?? [])]).toEqual(["12"]);
  fetchMock.mockResolvedValueOnce(json({ elements: [held, { ...held, id: 12, name: "Managed", servingStatuses: ["RUNNABLE"] }] }));
  const { accounts } = await customerAccountChoices("tenant", "linkedin");
  expect(accounts.map((a) => [a.id, "view_only" in a ? a.view_only : false])).toEqual([["11", true], ["12", false]]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
