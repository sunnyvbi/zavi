import { beforeEach, expect, it, vi } from "vitest";
import type { AccountBinding } from "../bindings";
const m = vi.hoisted(() => ({
  secret: vi.fn(),
  token: vi.fn(),
  get: vi.fn(),
  verify: vi.fn(),
  log: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({ platformSecretRpc: m.secret, tenantRpc: m.release, asTenantId: (v: string) => v }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  linkedinAdsToken: m.token,
  withLinkedInAdsToken: async <T,>(tenantId: string, call: (token: string) => Promise<T>) => call(await m.token(tenantId)),
}));
vi.mock("@/services/connectors/linkedin-ads/http", async (original) => ({
  ...(await original<typeof import("@/services/connectors/linkedin-ads/http")>()),
  linkedinAdsGet: m.get,
}));
vi.mock("../bindings", () => ({ verifyAccountBinding: m.verify }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
import { resolveLinkedinAccount } from "../adapters/linkedin-account";
const bound: AccountBinding = {
  id: "b",
  tenant_id: "t",
  account_id: "canonical",
  platform: "linkedin",
  provider_account_id: "42",
  currency: "USD",
  verified_at: "now",
  credential_source: "platform",
  credential_ref: "linkedin_ads_managed_account1",
  credential_tenant_id: null,
  funding_source: "wallet",
  legacy_key: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  m.secret.mockResolvedValue({ data: "managed-secret", error: null });
  m.token.mockResolvedValue("customer-secret");
  m.get.mockImplementation(async (_token, path) =>
    path === "adAccountUsers"
      ? {
          elements: [
            { account: "urn:li:sponsoredAccount:42", role: "CAMPAIGN_MANAGER" },
          ],
        }
      : { id: 42, currency: "USD", status: "ACTIVE" },
  );
});
it("reads only the pinned managed credential, never the tenant's current connector", async () => {
  expect((await resolveLinkedinAccount("t", bound, true)).token).toBe(
    "managed-secret",
  );
  expect(m.secret).toHaveBeenCalledWith("get_platform_secret", {
    p_key: bound.credential_ref,
  });
  expect(m.token).not.toHaveBeenCalled();
});
it("proves customer ownership and uses only the tenant's credential", async () => {
  const own = {
    ...bound,
    credential_source: "tenant_connector" as const,
    credential_tenant_id: "t",
    credential_ref: "linkedin_ads.access_token",
    funding_source: "provider" as const,
  };
  expect((await resolveLinkedinAccount("t", own, true)).token).toBe(
    "customer-secret",
  );
  expect(m.secret).not.toHaveBeenCalled();
});
it.each([
  { tenant_id: "foreign" },
  { platform: "chatgpt" },
  { credential_ref: "other-platform-secret" },
  { credential_tenant_id: "foreign" },
  { funding_source: "provider" },
])("refuses a mismatched binding %o before credentials", async (change) => {
  await expect(
    resolveLinkedinAccount("t", { ...bound, ...change } as AccountBinding),
  ).rejects.toThrow();
  expect(m.secret).not.toHaveBeenCalled();
  expect(m.token).not.toHaveBeenCalled();
});
const viewerOnly = () =>
  m.get.mockImplementation(async (_token, path) =>
    path === "adAccountUsers"
      ? {
          elements: [{ account: "urn:li:sponsoredAccount:42", role: "VIEWER" }],
          paging: { total: 1 },
        }
      : { id: 42, currency: "USD", status: "ACTIVE" },
  );
it("read-only advertiser access on the founder's own account cannot authorize campaign writes, and tells them to ask their admin", async () => {
  viewerOnly();
  m.release.mockResolvedValue({ data: 1, error: null });
  const own = {
    ...bound,
    credential_source: "tenant_connector" as const,
    credential_tenant_id: "t",
    credential_ref: "linkedin_ads.access_token",
    funding_source: "provider" as const,
  };
  await expect(resolveLinkedinAccount("t", own, true)).rejects.toMatchObject({
    code: "ads_account_read_only",
    message: expect.stringMatching(/Ask an account admin in LinkedIn Campaign Manager/),
  });
  expect((await resolveLinkedinAccount("t", own)).account.id).toBe("42");
});
it("when Zavi's own managed login loses its campaign role, a wallet founder is told Zavi must fix it, never to ask their own admin", async () => {
  viewerOnly();
  const refused = await resolveLinkedinAccount("t", bound, true).then(() => null, (e: Error & { code?: string }) => e);
  expect(refused?.code).toBe("ads_credentials_unavailable");
  expect(refused?.message).toMatch(/needs attention from Zavi/);
  expect(refused?.message).toMatch(/use your own LinkedIn ad account/);
  expect(refused?.message).not.toMatch(/admin|Campaign Manager|role/i);
  expect(m.release).not.toHaveBeenCalled();
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "ads_wallet.managed_linkedin_role_missing", tenant_id: "t" }));
  expect((await resolveLinkedinAccount("t", bound)).account.id).toBe("42");
});
it("refuses a provider identity mismatch before verification", async () => {
  m.get.mockResolvedValue({ id: 99, currency: "USD", status: "ACTIVE" });
  await expect(resolveLinkedinAccount("t", bound)).rejects.toMatchObject({
    code: "ads_account_mismatch",
  });
  expect(m.verify).not.toHaveBeenCalled();
});
