import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), filters: [] as Array<[string, unknown]>, select: vi.fn(), missing: false, tenant: "tenant-a" }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({
  rpc: m.rpc,
  from: () => {
    let scope: unknown;
    const q = {
      select: (columns: string) => { m.select(columns); return q; },
      eq: (key: string, value: unknown) => { m.filters.push([key, value]); if (key === "tenant_id") scope = value; return q; },
      single: async () => ({ data: m.missing || (scope && scope !== m.tenant) ? null : { id: "order-a", tenant_id: m.tenant }, error: null }),
    };
    return q;
  },
}) }));
import { applyAdsWalletPayment, asTenantId, resolveAdsWalletOrderTenant, tenantClient, tenantRpc } from "../tenant-client";
const args = { p_order_id: "order-a", p_payment_intent_id: "pi-a", p_net_cents: 1000, p_event_created: 100 };
beforeEach(() => { vi.clearAllMocks(); m.filters.length = 0; m.missing = false; m.tenant = "tenant-a"; m.rpc.mockResolvedValue({ data: null, error: null }); });
describe("ads wallet tenant boundary", () => {
  it.each(["ads_wallets", "ads_wallet_orders", "ads_campaign_funding", "ads_campaign_reservations", "ads_account_bindings", "ads_campaign_bindings", "ads_account_binding_details", "ads_campaign_binding_details", "ads_account_selections", "ads_campaign_create_requests"])("scopes %s reads to the caller", table => {
    tenantClient(asTenantId("tenant-a")).from(table).select("*");
    expect(m.filters).toContainEqual(["tenant_id", "tenant-a"]);
  });
  it("resolves only the tenant identity from the persisted webhook order", async () => {
    expect(await resolveAdsWalletOrderTenant("order-a")).toBe("tenant-a");
    expect(m.select).toHaveBeenCalledWith("tenant_id");
    expect(m.filters).toContainEqual(["id", "order-a"]);
  });
  it("fails closed for a missing webhook order", async () => {
    m.missing = true;
    await expect(resolveAdsWalletOrderTenant("order-a")).rejects.toThrow("could not be resolved");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("refuses payment application to another tenant's order", async () => {
    await expect(applyAdsWalletPayment(asTenantId("tenant-b"), args)).rejects.toThrow("does not belong");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("applies a matched order through only the fixed payment RPC", async () => {
    await applyAdsWalletPayment(asTenantId("tenant-a"), args);
    expect(m.rpc).toHaveBeenCalledWith("ads_wallet_apply_payment", args);
  });
  it.each(["ads_wallet_reserve", "ads_wallet_settle_spend", "ads_wallet_claim_refill", "ads_legacy_account_binding", "ads_verify_account_binding", "ads_bind_campaign", "ads_select_account_binding", "ads_claim_campaign_account", "ads_wallet_reserve_bound", "ads_wallet_reserve_chatgpt_daily_bound", "ads_wallet_settle_bound", "ads_wallet_finalize_bound"])("injects tenant identity for %s and rejects overrides", name => {
    tenantRpc(asTenantId("tenant-a"), name);
    expect(m.rpc).toHaveBeenCalledWith(name, { p_tenant_id: "tenant-a" });
    expect(() => tenantRpc(asTenantId("tenant-a"), name, { p_tenant_id: "tenant-b" })).toThrow("!= scope");
  });
});
