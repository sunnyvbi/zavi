import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ row: null as any, error: null as any, rpc: vi.fn(), filters: [] as unknown[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: m.rpc,
  tenantClient: (tenant: string) => ({ from: (table: string) => {
    m.filters.push([tenant,table]);
    const q: any = { select: () => q, eq: (key: string,value: unknown) => { m.filters.push([key,value]); return q; }, maybeSingle: async () => ({ data: m.row,error: m.error }) };
    return q;
  } }),
}));
import { bindCampaign, claimCampaignAccount, findCampaignBinding, getAccountBinding, getCampaignBinding, verifyAccountBinding, type AccountBinding } from "../bindings";
const account: AccountBinding = { id: "binding-a", tenant_id: "tenant-a", account_id: "account-a", platform: "chatgpt", provider_account_id: "provider-a", currency: "USD", verified_at: "2026-10-12", credential_source: "platform", credential_ref: "chatgpt_ads_api_key", credential_tenant_id: null, funding_source: "wallet", legacy_key: "chatgpt_platform" };
beforeEach(() => { vi.resetAllMocks(); m.row = account; m.error = null; m.filters = []; m.rpc.mockResolvedValue({ data: "binding-a", error: null }); });
it("loads an account only through tenant-scoped binding identity", async () => {
  expect(await getAccountBinding("tenant-a","binding-a")).toEqual(account);
  expect(m.filters).toEqual([["tenant-a","ads_account_binding_details"],["id","binding-a"]]);
});
it("rejects a foreign binding or a credential owned by another tenant", async () => {
  await expect(getAccountBinding("tenant-b","binding-a")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
  m.row = { ...account, credential_tenant_id: "tenant-b" };
  await expect(getAccountBinding("tenant-a","binding-a")).rejects.toMatchObject({ code:"ads_account_owned_elsewhere" });
});
it("names the cause when another workspace has taken over the ad account, without ids or the generic refresh line", async () => {
  m.row = { ...account, platform: "linkedin", credential_source: "tenant_connector", credential_ref: "linkedin_ads.access_token", credential_tenant_id: "tenant-b", funding_source: "provider", legacy_key: null };
  const refused = await getAccountBinding("tenant-a","binding-a").then(() => null, (e: Error & { code?: string }) => e);
  expect(refused?.code).toBe("ads_account_owned_elsewhere");
  expect(refused?.message).toMatch(/connected to another Zavi workspace/);
  expect(refused?.message).toMatch(/Pick another account/);
  expect(refused?.message).not.toMatch(/could not be verified|Refresh|tenant-b|binding-a/);
});
it("refuses an ambiguous raw campaign ID instead of choosing a default account", async () => {
  m.row = null; m.error = { code:"PGRST116" };
  await expect(findCampaignBinding("tenant-a","chatgpt","12345")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
  expect(m.rpc).not.toHaveBeenCalled();
});
it("rejects foreign internal campaign IDs", async () => {
  m.row = { id:"campaign-b",tenant_id:"tenant-b" };
  await expect(getCampaignBinding("tenant-a","campaign-b")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
});
it("checks provider account and currency before accepting a credential", async () => {
  await expect(verifyAccountBinding("tenant-a",account,"provider-b","USD")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
  await expect(verifyAccountBinding("tenant-a",account,"provider-a","EUR")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
  expect(m.rpc).not.toHaveBeenCalled();
  await verifyAccountBinding("tenant-a",account,"provider-a","USD");
  expect(m.rpc).toHaveBeenCalledWith("tenant-a","ads_verify_account_binding",{ p_binding_id:"binding-a",p_provider_account_id:"provider-a",p_currency:"USD" });
});
it("treats a failed atomic identity verification as unavailable", async () => {
  m.rpc.mockResolvedValue({ error:{ message:"private" } });
  await expect(verifyAccountBinding("tenant-a",account,"provider-a","USD")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
});
it("pins create requests by tenant, platform and request ID before resolving the account", async () => {
  expect(await claimCampaignAccount("tenant-a","chatgpt","request-a")).toEqual(account);
  expect(m.rpc).toHaveBeenCalledWith("tenant-a","ads_claim_campaign_account",{ p_platform:"chatgpt",p_request_id:"request-a" });
});
it("refuses cross-tenant campaign binding before any RPC", async () => {
  await expect(bindCampaign("tenant-b",account,"12345")).rejects.toMatchObject({ code:"ads_binding_unavailable" });
  expect(m.rpc).not.toHaveBeenCalled();
});
