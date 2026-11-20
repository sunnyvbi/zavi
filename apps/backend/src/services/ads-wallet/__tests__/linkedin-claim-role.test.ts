import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBinding } from "../bindings";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  get: vi.fn(),
  verify: vi.fn(),
  secret: vi.fn(),
  role: "CAMPAIGN_MANAGER" as string | null,
  total: undefined as number | undefined,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  platformSecretRpc: m.secret,
  tenantClient: () => {
    throw new Error("no table read expected");
  },
}));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: async <T,>(_t: string, call: (token: string) => Promise<T>) => call("customer-token"),
}));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => ({
  ...(await original<typeof import("@/services/connectors/linkedin-ads/http")>()),
  linkedinAdsGet: m.get,
}));
vi.mock("../bindings", () => ({
  verifyAccountBinding: m.verify,
  bindCampaign: vi.fn(),
  getAccountBinding: vi.fn(),
  legacyChatgptAccount: vi.fn(),
  selectAccountBinding: vi.fn(),
}));
vi.mock("../consent", () => ({ requireSharedWalletConsent: vi.fn() }));

import { connectCustomerAccount } from "../accounts";
import { resolveLinkedinAccount } from "../adapters/linkedin-account";
import { linkedinAdsConnector } from "@/services/connectors/linkedin-ads/oauth";

const own: AccountBinding = {
  id: "b",
  tenant_id: "tenant-A",
  account_id: "canonical",
  platform: "linkedin",
  provider_account_id: "42",
  currency: "USD",
  verified_at: "now",
  credential_source: "tenant_connector",
  credential_ref: "linkedin_ads.access_token",
  credential_tenant_id: "tenant-A",
  funding_source: "provider",
  legacy_key: null,
};
const managed: AccountBinding = {
  ...own,
  credential_source: "platform",
  credential_ref: "linkedin_ads_managed_account1",
  credential_tenant_id: null,
  funding_source: "wallet",
};

const registerCalls = () => m.rpc.mock.calls.filter((c) => c[1] === "ads_register_customer_account");
const releaseCalls = () => m.rpc.mock.calls.filter((c) => c[1] === "ads_release_customer_account_claim");

beforeEach(() => {
  vi.resetAllMocks();
  m.role = "CAMPAIGN_MANAGER";
  m.total = undefined;
  m.secret.mockResolvedValue({ data: "managed-secret", error: null });
  m.rpc.mockImplementation(async (_t: string, name: string) =>
    name === "ads_register_customer_account" ? { data: "binding-new", error: null } : { data: 1, error: null },
  );
  m.get.mockImplementation(async (_token: string, path: string) =>
    path === "adAccountUsers"
      ? {
          elements: [
            { account: "urn:li:sponsoredAccount:7", role: "ACCOUNT_MANAGER" },
            ...(m.role ? [{ account: "urn:li:sponsoredAccount:42", role: m.role }] : []),
          ],
          ...(m.total !== undefined ? { paging: { total: m.total } } : {}),
        }
      : { id: 42, currency: "USD", status: "ACTIVE" },
  );
});

describe("claiming a LinkedIn ad account requires campaign-management access", () => {
  it.each(["VIEWER", "CREATIVE_MANAGER", null])("a login with role %s cannot take the exclusive claim", async (role) => {
    m.role = role;
    await expect(connectCustomerAccount("tenant-A", "linkedin", "42", false)).rejects.toMatchObject({
      code: "ads_account_read_only",
    });
    expect(registerCalls()).toEqual([]);
  });

  it("a read-only claim is refused on the account settings path too, before the register RPC", async () => {
    m.role = "VIEWER";
    await expect(connectCustomerAccount("tenant-A", "linkedin", "42")).rejects.toMatchObject({ code: "ads_account_read_only" });
    expect(registerCalls()).toEqual([]);
  });

  it("checks the role with a fresh read, never a cached grant", async () => {
    await connectCustomerAccount("tenant-A", "linkedin", "42", false);
    const roleRead = m.get.mock.calls.find((c) => c[1] === "adAccountUsers")!;
    expect(roleRead[4]).toMatchObject({ fresh: true });
  });

  it.each(["CAMPAIGN_MANAGER", "ACCOUNT_MANAGER", "ACCOUNT_BILLING_ADMIN"])("a %s login claims the account", async (role) => {
    m.role = role;
    expect(await connectCustomerAccount("tenant-A", "linkedin", "42", false)).toBe("binding-new");
    expect(registerCalls()).toHaveLength(1);
    expect(registerCalls()[0][2]).toMatchObject({ p_provider_account_id: "42", p_currency: "USD" });
  });
});

describe("only an explicit disconnect releases the claim", () => {
  it("keeps this tenant's claim when its own connection reads as view-only, even on a complete role list", async () => {
    m.role = "VIEWER";
    m.total = 2;
    await expect(resolveLinkedinAccount("tenant-A", own, true)).rejects.toMatchObject({ code: "ads_account_read_only" });
    expect(releaseCalls()).toEqual([]);
  });

  it("workspace B cannot take the account after workspace A's view-only blip, and A launches again once its role is back", async () => {
    const claims = new Map<string, string>([["42", "tenant-A"]]);
    m.rpc.mockImplementation(async (tenant: string, name: string, args: { p_provider_account_id: string | null }) => {
      if (name === "ads_release_customer_account_claim") {
        for (const [acct, owner] of claims) if (owner === tenant && (args.p_provider_account_id === null || args.p_provider_account_id === acct)) claims.delete(acct);
        return { data: 1, error: null };
      }
      if (name === "ads_register_customer_account") {
        const owner = claims.get(args.p_provider_account_id!);
        if (owner && owner !== tenant) return { data: null, error: { message: "account ownership conflict" } };
        claims.set(args.p_provider_account_id!, tenant);
        return { data: `binding-${tenant}`, error: null };
      }
      return { data: 1, error: null };
    });
    m.role = "VIEWER";
    m.total = 2;
    await expect(resolveLinkedinAccount("tenant-A", own, true)).rejects.toMatchObject({ code: "ads_account_read_only" });
    await expect(resolveLinkedinAccount("tenant-A", own, true)).rejects.toMatchObject({ code: "ads_account_read_only" });
    expect(claims.get("42")).toBe("tenant-A");
    m.role = "CAMPAIGN_MANAGER";
    m.total = undefined;
    await expect(connectCustomerAccount("tenant-B", "linkedin", "42", false)).rejects.toMatchObject({ code: "ads_account_owned_elsewhere" });
    expect(claims.get("42")).toBe("tenant-A");
    await expect(resolveLinkedinAccount("tenant-A", own, true)).resolves.toMatchObject({ account: { id: "42" } });
    await linkedinAdsConnector.onDisconnect!("tenant-A");
    expect(claims.has("42")).toBe(false);
    expect(await connectCustomerAccount("tenant-B", "linkedin", "42", false)).toBe("binding-tenant-B");
  });

  it("does not release on a partial role list, where the role may be on a later page", async () => {
    m.role = null;
    m.total = 1500;
    await expect(resolveLinkedinAccount("tenant-A", own, true)).rejects.toMatchObject({ code: "ads_account_read_only" });
    expect(releaseCalls()).toEqual([]);
  });

  it.each([
    ["a bare empty list", { elements: [] }],
    ["an empty list with an empty paging block", { elements: [], paging: {} }],
    ["a list with no elements key", {}],
    ["a role list without a total", { elements: [{ account: "urn:li:sponsoredAccount:7", role: "ACCOUNT_MANAGER" }] }],
    ["a VIEWER role without a total", { elements: [{ account: "urn:li:sponsoredAccount:42", role: "VIEWER" }] }],
    ["a total larger than the list", { elements: [], paging: { total: 3 } }],
    ["a total smaller than the list", { elements: [{ account: "urn:li:sponsoredAccount:7", role: "ACCOUNT_MANAGER" }], paging: { total: 0 } }],
  ])("does not release on %s, a reply that may be transient or partial", async (_label, reply) => {
    m.get.mockImplementation(async (_token: string, path: string) => (path === "adAccountUsers" ? reply : { id: 42, currency: "USD", status: "ACTIVE" }));
    await expect(resolveLinkedinAccount("tenant-A", own, true)).rejects.toMatchObject({ code: "ads_account_read_only" });
    expect(releaseCalls()).toEqual([]);
  });

  it.each([
    ["a complete list without this account", { elements: [{ account: "urn:li:sponsoredAccount:7", role: "ACCOUNT_MANAGER" }], paging: { total: 1 } }],
    ["a complete list where this account is VIEWER", { elements: [{ account: "urn:li:sponsoredAccount:42", role: "VIEWER" }], paging: { start: 0, count: 1000, total: 1 } }],
  ])("keeps the claim on %s, since a role can come back", async (_label, reply) => {
    m.get.mockImplementation(async (_token: string, path: string) => (path === "adAccountUsers" ? reply : { id: 42, currency: "USD", status: "ACTIVE" }));
    await expect(resolveLinkedinAccount("tenant-A", own, true)).rejects.toMatchObject({ code: "ads_account_read_only" });
    expect(releaseCalls()).toEqual([]);
  });

  it("never releases a Zavi-managed account binding", async () => {
    m.role = "VIEWER";
    await expect(resolveLinkedinAccount("tenant-A", managed, true)).rejects.toMatchObject({ code: "ads_credentials_unavailable" });
    expect(releaseCalls()).toEqual([]);
  });


  it("does not release when the connection still manages the account", async () => {
    await resolveLinkedinAccount("tenant-A", own, true);
    expect(releaseCalls()).toEqual([]);
  });

  it("disconnecting LinkedIn Ads releases every claim of the disconnecting tenant", async () => {
    await linkedinAdsConnector.onDisconnect!("tenant-A");
    expect(releaseCalls()).toEqual([
      ["tenant-A", "ads_release_customer_account_claim", { p_platform: "linkedin", p_provider_account_id: null }],
    ]);
  });
});
