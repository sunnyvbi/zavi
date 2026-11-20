
import {
  acquireShopifyRefreshLease,
  getPendingShopifyInstall,
  listShopifyTokenRefreshCandidates,
  markShopifyComposioTokenSynced,
  persistRotatedShopifyGrant,
  releaseShopifyRefreshLease,
  type ShopifyTokenRefreshCandidate,
} from "@/services/connectors/shopify/pending-install";
import type { ShopifyInstallRef } from "@/services/connectors/shopify/hmac";
import { refreshShopifyGrant } from "@/services/connectors/shopify/oauth";
import {
  composioPatchBearerToken,
  composioVerifyActive,
  composioVerifyOwned,
} from "@/services/connectors/composio/api";

const REFRESH_RUNWAY_MS = 40 * 60 * 1000;
const MAX_PER_SWEEP = 100;

type RefreshLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export type ShopifyTokenRefreshDeps = {
  list(dueBefore: Date, limit: number): Promise<ShopifyTokenRefreshCandidate[]>;
  get(ref: ShopifyInstallRef): ReturnType<typeof getPendingShopifyInstall>;
  refresh(shop: string, refreshToken: string): ReturnType<typeof refreshShopifyGrant>;
  rotate: typeof persistRotatedShopifyGrant;
  acquireLease: typeof acquireShopifyRefreshLease;
  releaseLease: typeof releaseShopifyRefreshLease;
  verifyOwned: typeof composioVerifyOwned;
  patch: typeof composioPatchBearerToken;
  verifyActive: typeof composioVerifyActive;
  markSynced: typeof markShopifyComposioTokenSynced;
};

const defaultDeps: ShopifyTokenRefreshDeps = {
  list: listShopifyTokenRefreshCandidates,
  get: getPendingShopifyInstall,
  refresh: refreshShopifyGrant,
  rotate: persistRotatedShopifyGrant,
  acquireLease: acquireShopifyRefreshLease,
  releaseLease: releaseShopifyRefreshLease,
  verifyOwned: composioVerifyOwned,
  patch: composioPatchBearerToken,
  verifyActive: composioVerifyActive,
  markSynced: markShopifyComposioTokenSynced,
};

export async function refreshShopifyBearerTokens(
  now: Date,
  logger: RefreshLogger,
  deps: ShopifyTokenRefreshDeps = defaultDeps,
): Promise<{ scanned: number; synced: number; failed: number; skipped: number }> {
  const dueBefore = new Date(now.getTime() + REFRESH_RUNWAY_MS);
  const candidates = await deps.list(dueBefore, MAX_PER_SWEEP);
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const ref = { installation_id: candidate.installation_id, generation: candidate.generation };
    let leased = false;
    try {
      leased = await deps.acquireLease(ref);
    } catch (error) {
      failed += 1;
      logger.warn(`shopify-token-refresh: lease failed (${(error as Error).message})`);
      continue;
    }
    if (!leased) { skipped += 1; continue; }
    try {
      let pending = await deps.get(ref);
      if (!pending || pending.composio_account_id !== candidate.connected_account_id) {
        throw new Error("stale_installation");
      }
      const scope = {
        user_id: candidate.tenant_id,
        auth_config_id: candidate.auth_config_id,
        connected_account_id: candidate.connected_account_id,
      };
      if (!(await deps.verifyOwned(scope))) throw new Error("account_scope_mismatch");

      if (!candidate.token_sync_pending || pending.access_token_expires_at.getTime() <= dueBefore.getTime()) {
        if (pending.refresh_token_expires_at.getTime() <= now.getTime()) {
          throw new Error("refresh_grant_expired");
        }
        const oldRefreshToken = pending.refresh_token;
        const grant = await deps.refresh(pending.shop, oldRefreshToken);
        if (!(await deps.rotate(ref, oldRefreshToken, grant))) throw new Error("refresh_cas_lost");
        pending = await deps.get(ref);
        if (!pending || pending.composio_account_id !== candidate.connected_account_id) {
          throw new Error("installation_changed_after_refresh");
        }
      }

      await deps.patch({
        connected_account_id: candidate.connected_account_id,
        access_token: pending.access_token,
      });
      if (!(await deps.verifyActive(scope))) throw new Error("account_not_active_after_patch");
      if (!(await deps.markSynced(ref, candidate.connected_account_id, pending.access_token))) {
        throw new Error("sync_cas_lost");
      }
      synced += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`shopify-token-refresh: candidate failed (${(error as Error).message})`);
    } finally {
      try { await deps.releaseLease(ref); } catch {  }
    }
  }

  logger.info(`shopify-token-refresh: scanned=${candidates.length} synced=${synced} failed=${failed} skipped=${skipped}`);
  return { scanned: candidates.length, synced, failed, skipped };
}

