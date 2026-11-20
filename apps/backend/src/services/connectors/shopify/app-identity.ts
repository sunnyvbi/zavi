import { asTenantId, shopifyRpc, tenantClient, tenantRpc } from "@/services/tenant-client";

export type LinkedShopifyAppMember = {
  user_id: string;
  role: "owner" | "admin" | "member" | "viewer";
};

export async function shopifyWorkspaceAdminRole(tenant_id: string, user_id: string): Promise<"owner" | "admin" | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_users")
    .select("role")
    .eq("user_id", user_id)
    .maybeSingle<{ role: string }>();
  if (error) throw new Error(`shopify_workspace_role_failed:${error.message}`);
  return data?.role === "owner" || data?.role === "admin" ? data.role : null;
}

export async function shopifyAppMemberLinkAvailable(args: {
  tenant_id: string;
  shop: string;
  shopify_user_id: string;
}): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(args.tenant_id), "shopify_app_member_link_available", {
    p_shop: args.shop,
    p_shopify_user_id: args.shopify_user_id,
  });
  if (error) throw new Error(`shopify_app_member_link_check_failed:${error.message}`);
  return data === true;
}

export async function linkShopifyAppMember(args: {
  tenant_id: string;
  shop: string;
  shopify_user_id: string;
  user_id: string;
}): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(args.tenant_id), "link_shopify_app_member", {
    p_shop: args.shop,
    p_shopify_user_id: args.shopify_user_id,
    p_user_id: args.user_id,
  });
  if (error) throw new Error(`shopify_app_member_link_failed:${error.message}`);
  return data === args.user_id;
}

export async function resolveLinkedShopifyAppMember(args: {
  tenant_id: string;
  shop: string;
  shopify_user_id: string;
}): Promise<LinkedShopifyAppMember | null> {
  const { data, error } = await tenantRpc(asTenantId(args.tenant_id), "resolve_shopify_app_member_link", {
    p_shop: args.shop,
    p_shopify_user_id: args.shopify_user_id,
  });
  if (error) throw new Error(`shopify_app_member_resolve_failed:${error.message}`);
  const row = (data as Array<{ user_id?: unknown; role?: unknown }> | null)?.[0];
  if (typeof row?.user_id !== "string" || !["owner", "admin", "member", "viewer"].includes(String(row.role))) return null;
  return { user_id: row.user_id, role: row.role as LinkedShopifyAppMember["role"] };
}

export async function deleteTenantShopifyAppMemberLinks(tenant_id: string, shop: string): Promise<void> {
  const { error } = await tenantRpc(asTenantId(tenant_id), "delete_shopify_app_member_links", { p_shop: shop });
  if (error) throw new Error(`shopify_app_member_delete_failed:${error.message}`);
}

export async function deleteShopifyAppMemberLinksForShop(shop: string): Promise<void> {
  const { error } = await shopifyRpc("delete_shopify_app_member_links_for_shop", { p_shop: shop });
  if (error) throw new Error(`shopify_app_member_delete_failed:${error.message}`);
}
