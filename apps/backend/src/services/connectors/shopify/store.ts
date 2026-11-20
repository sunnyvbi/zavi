import { asTenantId, shopifyRpc, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { composioGetAccount, composioDisconnect } from "@/services/connectors/composio/api";
import { deleteComposioRow } from "@/services/connectors/composio/connection-row";
import { normalizeShopDomain } from "./hmac";
import { deleteShopifyAppMemberLinksForShop, deleteTenantShopifyAppMemberLinks } from "./app-identity";
import {
  deletePendingShopifyInstallForShop,
  deletePendingShopifyInstallForTenant,
  listPendingShopifyAccountsForShop,
} from "./pending-install";

export const SHOPIFY_SLUG = "composio.shopify";

export type ShopConnection = { tenant_id: string; connected_account_id: string };

export async function saveShopDomain(
  tenant_id: string,
  connected_account_id: string,
  shop: string,
): Promise<boolean> {
  const normalized = normalizeShopDomain(shop);
  if (!normalized) return false;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("connector_metadata")
    .update({ team_name: normalized })
    .eq("slug", SHOPIFY_SLUG)
    .eq("team_id", connected_account_id)
    .select("tenant_id")
    .maybeSingle();
  if (error || !data) {
    void logEvent({
      level: "warn",
      source: "shopify.connect",
      code: "shopify_shop_save_failed",
      message: error?.message ?? "connector row not found after save",
      tenant_id,
    });
    return false;
  }
  return true;
}

export async function rememberShopDomain(tenant_id: string, connected_account_id: string): Promise<string | null> {
  let shop: string | null = null;
  try {
    const account = await composioGetAccount(connected_account_id);
    shop = account.subdomain ? normalizeShopDomain(`${account.subdomain}.myshopify.com`) : null;
  } catch (e) {
    void logEvent({ level: "warn", source: "shopify.connect", code: "shopify_account_read_failed", message: (e as Error).message, tenant_id });
    return null;
  }
  if (!shop) {
    void logEvent({ level: "warn", source: "shopify.connect", code: "shopify_shop_missing", tenant_id });
    return null;
  }
  return (await saveShopDomain(tenant_id, connected_account_id, shop)) ? shop : null;
}

export async function storedShop(tenant_id: string): Promise<string | null> {
  const { data } = await tenantClient(asTenantId(tenant_id))
    .from("connector_metadata")
    .select("team_name")
    .eq("slug", SHOPIFY_SLUG)
    .maybeSingle();
  return normalizeShopDomain((data as { team_name?: string | null } | null)?.team_name);
}

export async function tenantHasShop(tenant_id: string, shop: string): Promise<boolean> {
  return (await storedShop(tenant_id)) === shop;
}

export async function connectionsForShop(shop: string): Promise<ShopConnection[]> {
  const { data, error } = await shopifyRpc("shopify_connections_for_shop", { p_shop: shop });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ tenant_id?: unknown; connected_account_id?: unknown }>)
    .filter((r) => typeof r.tenant_id === "string" && typeof r.connected_account_id === "string" && r.connected_account_id)
    .map((r) => ({ tenant_id: r.tenant_id as string, connected_account_id: r.connected_account_id as string }));
}

export async function connectedTenantForShop(shop: string): Promise<string | "ambiguous" | null> {
  const tenantIds = [...new Set((await connectionsForShop(shop)).map((connection) => connection.tenant_id))];
  if (tenantIds.length === 0) return null;
  return tenantIds.length === 1 ? tenantIds[0] : "ambiguous";
}

export async function disconnectShop(shop: string, via: string): Promise<number> {
  await deleteShopifyAppMemberLinksForShop(shop);
  for (const pendingAccountId of await listPendingShopifyAccountsForShop(shop)) {
    await composioDisconnect(pendingAccountId);
  }
  await deletePendingShopifyInstallForShop(shop);
  const rows = await connectionsForShop(shop);
  let incomplete = 0;
  for (const row of rows) {
    try {
      await composioDisconnect(row.connected_account_id);
    } catch (e) {
      incomplete += 1;
      void logEvent({ level: "warn", source: "shopify.webhook", code: "shopify_revoke_failed", message: (e as Error).message, tenant_id: row.tenant_id });
      continue;
    }
    const delErr = await deleteComposioRow(row.tenant_id, SHOPIFY_SLUG, row.connected_account_id);
    if (delErr) {
      incomplete += 1;
      void logEvent({ level: "warn", source: "shopify.webhook", code: "shopify_row_delete_failed", message: delErr.message, tenant_id: row.tenant_id });
      continue;
    }
    void logEvent({ level: "info", source: "shopify.webhook", code: "shopify_store_disconnected", tenant_id: row.tenant_id, meta: { via } });
  }
  if (incomplete > 0) throw new Error(`shopify_disconnect_incomplete:${incomplete}`);
  return rows.length;
}

export async function disconnectTenantShop(
  tenantId: string,
  shop: string,
  connectedAccountId: string,
  via: string,
): Promise<void> {
  await composioDisconnect(connectedAccountId);
  const grantErased = await deletePendingShopifyInstallForTenant(shop, tenantId);
  await deleteTenantShopifyAppMemberLinks(tenantId, shop);
  const delErr = await deleteComposioRow(tenantId, SHOPIFY_SLUG, connectedAccountId);
  if (delErr) throw new Error(`shopify_row_delete_failed:${delErr.message}`);
  void logEvent({
    level: grantErased ? "info" : "warn",
    source: "shopify.disconnect",
    code: grantErased ? "shopify_store_disconnected" : "shopify_store_disconnected_no_install_row",
    tenant_id: tenantId,
    meta: { via },
  });
}
