import crypto from "node:crypto";
import { shopifyRpc } from "@/services/tenant-client";
import type { ShopifyInstallRef } from "./hmac";
import type { ShopifyTokenGrant } from "./oauth";

export type PendingShopifyInstall = ShopifyInstallRef & {
  shop: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
  scopes: string[];
  composio_account_id: string | null;
  superseded_composio_account_ids: string[];
};

export type ShopifyInstallStatus = {
  shop: string;
  composio_account_id: string | null;
  claimed_tenant_id: string | null;
  claimed_at: string | null;
  has_pending_grant: boolean;
};

export type ShopifyTokenRefreshCandidate = ShopifyInstallRef & {
  tenant_id: string;
  connected_account_id: string;
  auth_config_id: string;
  token_sync_pending: boolean;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
};

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function mintShopifyOAuthState(shop: string, state: string): Promise<void> {
  const { error } = await shopifyRpc("mint_shopify_oauth_state", {
    p_state_hash: sha256(state),
    p_shop: shop,
    p_ttl_seconds: 600,
  });
  if (error) throw new Error(`shopify_state_mint_failed:${error.message}`);
}

export async function consumeShopifyOAuthState(shop: string, state: string): Promise<boolean> {
  const { data, error } = await shopifyRpc("consume_shopify_oauth_state", {
    p_state_hash: sha256(state),
    p_shop: shop,
  });
  if (error) throw new Error(`shopify_state_consume_failed:${error.message}`);
  return data === true;
}

export async function storePendingShopifyInstall(
  shop: string,
  grant: ShopifyTokenGrant,
): Promise<ShopifyInstallRef> {
  const { data, error } = await shopifyRpc("store_shopify_pending_installation", {
    p_shop: shop,
    p_access_token: grant.access_token,
    p_refresh_token: grant.refresh_token,
    p_access_token_expires_at: grant.access_token_expires_at.toISOString(),
    p_refresh_token_expires_at: grant.refresh_token_expires_at.toISOString(),
    p_scopes: grant.scopes,
  });
  if (error) throw new Error(`shopify_pending_store_failed:${error.message}`);
  const row = (data as Array<{
    installation_id?: unknown;
    installation_generation?: unknown;
  }> | null)?.[0];
  if (typeof row?.installation_id !== "string" || typeof row.installation_generation !== "number") {
    throw new Error("shopify_pending_store_failed:missing_result");
  }
  return {
    installation_id: row.installation_id,
    generation: row.installation_generation,
  };
}

export async function getPendingShopifyInstall(ref: ShopifyInstallRef): Promise<PendingShopifyInstall | null> {
  const { data, error } = await shopifyRpc("get_shopify_pending_installation", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
  });
  if (error) throw new Error(`shopify_pending_read_failed:${error.message}`);
  const row = (data as Array<Record<string, unknown>> | null)?.[0];
  if (!row) return null;
  if (
    typeof row.shop !== "string" ||
    typeof row.access_token !== "string" ||
    typeof row.refresh_token !== "string" ||
    typeof row.access_token_expires_at !== "string" ||
    typeof row.refresh_token_expires_at !== "string"
  ) {
    throw new Error("shopify_pending_read_failed:bad_result");
  }
  return {
    ...ref,
    shop: row.shop,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    access_token_expires_at: new Date(row.access_token_expires_at),
    refresh_token_expires_at: new Date(row.refresh_token_expires_at),
    scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    composio_account_id: typeof row.composio_account_id === "string" ? row.composio_account_id : null,
    superseded_composio_account_ids: Array.isArray(row.superseded_composio_account_ids)
      ? row.superseded_composio_account_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export async function getShopifyInstallStatus(ref: ShopifyInstallRef): Promise<ShopifyInstallStatus | null> {
  const { data, error } = await shopifyRpc("get_shopify_installation_status", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
  });
  if (error) throw new Error(`shopify_install_status_failed:${error.message}`);
  const row = (data as Array<Record<string, unknown>> | null)?.[0];
  if (!row || typeof row.shop !== "string") return null;
  return {
    shop: row.shop,
    composio_account_id: typeof row.composio_account_id === "string" ? row.composio_account_id : null,
    claimed_tenant_id: typeof row.claimed_tenant_id === "string" ? row.claimed_tenant_id : null,
    claimed_at: typeof row.claimed_at === "string" ? row.claimed_at : null,
    has_pending_grant: row.has_pending_grant === true,
  };
}

export async function reservePendingShopifyInstall(ref: ShopifyInstallRef, tenantId: string): Promise<boolean> {
  const { data, error } = await shopifyRpc("reserve_shopify_pending_installation", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
    p_tenant_id: tenantId,
  });
  if (error) throw new Error(`shopify_pending_reserve_failed:${error.message}`);
  return data === true;
}

export async function rotatePendingShopifyTokens(
  ref: ShopifyInstallRef,
  expectedRefreshToken: string,
  grant: ShopifyTokenGrant,
): Promise<boolean> {
  const { data, error } = await shopifyRpc("rotate_shopify_pending_tokens", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
    p_expected_refresh_token: expectedRefreshToken,
    p_access_token: grant.access_token,
    p_refresh_token: grant.refresh_token,
    p_access_token_expires_at: grant.access_token_expires_at.toISOString(),
    p_refresh_token_expires_at: grant.refresh_token_expires_at.toISOString(),
  });
  if (error) throw new Error(`shopify_pending_rotate_failed:${error.message}`);
  return data === true;
}

const ROTATE_PERSIST_ATTEMPTS = 3;
const ROTATE_PERSIST_BACKOFF_MS = 300;

export async function persistRotatedShopifyGrant(
  ref: ShopifyInstallRef,
  expectedRefreshToken: string,
  grant: ShopifyTokenGrant,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ROTATE_PERSIST_ATTEMPTS; attempt++) {
    try {
      return await rotatePendingShopifyTokens(ref, expectedRefreshToken, grant);
    } catch (e) {
      lastError = e;
      if (attempt < ROTATE_PERSIST_ATTEMPTS) await sleep(ROTATE_PERSIST_BACKOFF_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("shopify_pending_rotate_failed");
}

export async function acquireShopifyRefreshLease(ref: ShopifyInstallRef, ttlSeconds = 60): Promise<boolean> {
  const { data, error } = await shopifyRpc("acquire_shopify_refresh_lease", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`shopify_refresh_lease_failed:${error.message}`);
  return data === true;
}

export async function releaseShopifyRefreshLease(ref: ShopifyInstallRef): Promise<void> {
  const { error } = await shopifyRpc("release_shopify_refresh_lease", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
  });
  if (error) throw new Error(`shopify_refresh_lease_release_failed:${error.message}`);
}

export async function setPendingComposioAccount(
  ref: ShopifyInstallRef,
  tenantId: string,
  accountId: string,
  previousAccountId: string | null,
): Promise<boolean> {
  const { data, error } = await shopifyRpc("set_shopify_pending_composio_account", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
    p_tenant_id: tenantId,
    p_composio_account_id: accountId,
    p_previous_composio_account_id: previousAccountId,
  });
  if (error) throw new Error(`shopify_pending_composio_failed:${error.message}`);
  return data === true;
}

export async function completePendingShopifyInstall(
  ref: ShopifyInstallRef,
  tenantId: string,
  accountId: string,
): Promise<boolean> {
  const { data, error } = await shopifyRpc("complete_shopify_pending_installation", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
    p_tenant_id: tenantId,
    p_composio_account_id: accountId,
  });
  if (error) throw new Error(`shopify_pending_complete_failed:${error.message}`);
  return data === true;
}

export async function listShopifyTokenRefreshCandidates(
  dueBefore: Date,
  limit = 100,
): Promise<ShopifyTokenRefreshCandidate[]> {
  const { data, error } = await shopifyRpc("list_shopify_token_refresh_candidates", {
    p_due_before: dueBefore.toISOString(),
    p_limit: limit,
  });
  if (error) throw new Error(`shopify_refresh_list_failed:${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
    if (
      typeof row.installation_id !== "string" ||
      typeof row.installation_generation !== "number" ||
      typeof row.tenant_id !== "string" ||
      typeof row.connected_account_id !== "string" ||
      typeof row.auth_config_id !== "string" ||
      typeof row.access_token_expires_at !== "string" ||
      typeof row.refresh_token_expires_at !== "string"
    ) return [];
    return [{
      installation_id: row.installation_id,
      generation: row.installation_generation,
      tenant_id: row.tenant_id,
      connected_account_id: row.connected_account_id,
      auth_config_id: row.auth_config_id,
      token_sync_pending: row.token_sync_pending === true,
      access_token_expires_at: new Date(row.access_token_expires_at),
      refresh_token_expires_at: new Date(row.refresh_token_expires_at),
    }];
  });
}

export async function markShopifyComposioTokenSynced(
  ref: ShopifyInstallRef,
  connectedAccountId: string,
  expectedAccessToken: string,
): Promise<boolean> {
  const { data, error } = await shopifyRpc("mark_shopify_composio_token_synced", {
    p_installation_id: ref.installation_id,
    p_generation: ref.generation,
    p_connected_account_id: connectedAccountId,
    p_expected_access_token: expectedAccessToken,
  });
  if (error) throw new Error(`shopify_refresh_sync_failed:${error.message}`);
  return data === true;
}

export async function listPendingShopifyAccountsForShop(shop: string): Promise<string[]> {
  const { data, error } = await shopifyRpc("list_shopify_pending_composio_accounts_for_shop", { p_shop: shop });
  if (error) throw new Error(`shopify_pending_list_failed:${error.message}`);
  return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : [];
}

export async function deletePendingShopifyInstallForShop(shop: string): Promise<string[]> {
  const { data, error } = await shopifyRpc("delete_shopify_pending_installation_for_shop", {
    p_shop: shop,
  });
  if (error) throw new Error(`shopify_pending_delete_failed:${error.message}`);
  return Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : [];
}

export async function deletePendingShopifyInstallForTenant(shop: string, tenantId: string): Promise<boolean> {
  const { data, error } = await shopifyRpc("delete_shopify_installation_for_tenant", {
    p_shop: shop,
    p_tenant_id: tenantId,
  });
  if (error) throw new Error(`shopify_pending_tenant_delete_failed:${error.message}`);
  return data === true;
}
