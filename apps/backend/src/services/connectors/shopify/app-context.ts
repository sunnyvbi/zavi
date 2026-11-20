import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { connectionsForShop } from "./store";
import { exchangeShopifyOnlineToken, verifyShopifyIdToken, type ShopifyOnlineGrant } from "./session";
import { resolveLinkedShopifyAppMember } from "./app-identity";

export type ShopifyViewerRole = "owner" | "admin" | "member" | "viewer";

export type ShopifyAppContext = {
  shop: string;
  tenant_id: string;
  tenant_name: string;
  user_id: string | null;
  role: ShopifyViewerRole;
  grant: ShopifyOnlineGrant;
};

export class ShopifyAppContextError extends Error {
  constructor(readonly code: "shop_not_connected" | "shop_ambiguous" | "workspace_missing" | "user_not_linked") {
    super(code);
    this.name = "ShopifyAppContextError";
  }
}

export async function resolveShopifyAppContext(authorization: unknown): Promise<ShopifyAppContext> {
  const session = await verifyShopifyIdToken(authorization);
  const grant = await exchangeShopifyOnlineToken(session);
  const connections = await connectionsForShop(session.shop);
  const tenantIds = [...new Set(connections.map((connection) => connection.tenant_id))];
  if (tenantIds.length === 0) throw new ShopifyAppContextError("shop_not_connected");
  if (tenantIds.length !== 1) throw new ShopifyAppContextError("shop_ambiguous");
  const tenant_id = tenantIds[0];
  const tid = asTenantId(tenant_id);
  const { data: tenant, error: tenantError } = await tenantClient(tid)
    .from("tenants")
    .select("display_name")
    .maybeSingle<{ display_name: string }>();
  if (tenantError || !tenant) throw new ShopifyAppContextError("workspace_missing");

  const linked = await resolveLinkedShopifyAppMember({
    tenant_id,
    shop: session.shop,
    shopify_user_id: session.shopify_user_id,
  });
  if (linked) {
    return { shop: session.shop, tenant_id, tenant_name: tenant.display_name, ...linked, grant };
  }

  if (!grant.associated_user.email_verified) throw new ShopifyAppContextError("user_not_linked");
  const { data, error } = await tenantRpc(tid, "resolve_shopify_app_member", {
    p_tenant_id: tenant_id,
    p_email: grant.associated_user.email,
  });
  if (error) throw new Error(`shopify_member_resolve_failed:${error.message}`);
  const row = (data as Array<{ user_id?: unknown; role?: unknown }> | null)?.[0];
  if (typeof row?.user_id !== "string" || !["owner", "admin", "member", "viewer"].includes(String(row.role))) {
    throw new ShopifyAppContextError("user_not_linked");
  }
  const user_id = row.user_id;
  const role = row.role as ShopifyViewerRole;
  return { shop: session.shop, tenant_id, tenant_name: tenant.display_name, user_id, role, grant };
}
