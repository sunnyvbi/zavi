export type ShopifyInstallOutcome =
  | { kind: "login" }
  | { kind: "ready"; shop: string; linkTenantId?: string }
  | { kind: "connected"; url: string }
  | { kind: "error"; message: string };

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export const SHOPIFY_INSTALL_MISSING = "This install link is incomplete. Open Zavi from your Shopify admin to try again.";
export const SHOPIFY_INSTALL_FAILED = "Could not load this Shopify installation. Try again from your Shopify admin.";
export const SHOPIFY_CLAIM_FAILED = "Could not finish the Shopify connection. Try again.";

export async function loadShopifyInstall(token: string, fetcher: Fetcher): Promise<ShopifyInstallOutcome> {
  if (!token) return { kind: "error", message: SHOPIFY_INSTALL_MISSING };
  let res: Response;
  try {
    res = await fetcher(`/api/connectors/shopify/install/status?token=${encodeURIComponent(token)}`);
  } catch {
    return { kind: "error", message: SHOPIFY_INSTALL_FAILED };
  }
  if (res.status === 401) return { kind: "login" };
  const body = (await res.json().catch(() => ({}))) as {
    shop?: string;
    connected?: boolean;
    redirect_url?: string;
    link_tenant_id?: string;
    error?: { message?: string };
  };
  if (res.ok && body.connected) {
    return { kind: "connected", url: body.redirect_url || "/workspace?tab=brain&shopify=connected#integration" };
  }
  if (res.ok && body.shop) {
    return { kind: "ready", shop: body.shop, ...(body.link_tenant_id ? { linkTenantId: body.link_tenant_id } : {}) };
  }
  return { kind: "error", message: body.error?.message?.trim() || SHOPIFY_INSTALL_FAILED };
}

export async function claimShopifyInstall(token: string, fetcher: Fetcher): Promise<ShopifyInstallOutcome> {
  if (!token) return { kind: "error", message: SHOPIFY_INSTALL_MISSING };
  let res: Response;
  try {
    res = await fetcher("/api/connectors/shopify/install/claim", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: "error", message: SHOPIFY_CLAIM_FAILED };
  }
  if (res.status === 401) return { kind: "login" };
  const body = (await res.json().catch(() => ({}))) as {
    redirect_url?: string;
    error?: { message?: string };
  };
  if (res.ok && body.redirect_url) return { kind: "connected", url: body.redirect_url };
  return { kind: "error", message: body.error?.message?.trim() || SHOPIFY_CLAIM_FAILED };
}
