import { describe, it, expect, vi } from "vitest";
import { createMetaAdsProvisioner } from "@/services/provisioning/ads-meta";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("MetaAdsProvisioner (double-gated E3, ad spend)", () => {
  it("gate 1a: missing META_PROVISION_TOKEN → CredentialNotConfigured", async () => {
    const p = createMetaAdsProvisioner({ token: () => null, businessId: () => "biz1", enabled: () => true, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "META_PROVISION_TOKEN",
    });
  });

  it("gate 1b: missing META_BUSINESS_ID → CredentialNotConfigured", async () => {
    const p = createMetaAdsProvisioner({ token: () => "tok", businessId: () => null, enabled: () => true, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "META_BUSINESS_ID",
    });
  });

  it("gate 2: token+biz present but E3 flag OFF → refuses, creates NOTHING", async () => {
    const fetchFn = vi.fn();
    const p = createMetaAdsProvisioner({ token: () => "tok", businessId: () => "biz1", enabled: () => false, fetchFn: fetchFn as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "ADS_PROVISIONING_ENABLED",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("all gates open → creates a child ad account under the BM", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, { id: "act_999" }));
    const p = createMetaAdsProvisioner({ token: () => "tok", businessId: () => "biz1", enabled: () => true, fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });
    expect(r.external_ref).toEqual({ meta_ad_account_id: "act_999" });
    expect(r.vault_keys).toEqual({});
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/biz1/adaccount");
    expect(init?.body).toContain("currency=USD");
    expect(init?.body).toContain("access_token=tok");
  });

  it("teardown deactivates (POST account_status=2) — Meta can't delete", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200, {}));
    const p = createMetaAdsProvisioner({ token: () => "tok", businessId: () => "biz1", enabled: () => true, fetchFn: fetchFn as never });
    await expect(p.teardown({ meta_ad_account_id: "act_999" })).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0][1]?.body).toContain("account_status=2");
  });

  it("kind/provider = ads/meta", () => {
    const p = createMetaAdsProvisioner({ token: () => "t", businessId: () => "b", enabled: () => true });
    expect(p.kind).toBe("ads");
    expect(p.provider).toBe("meta");
  });
});
