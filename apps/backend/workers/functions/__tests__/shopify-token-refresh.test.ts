import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshShopifyBearerTokens,
  type ShopifyTokenRefreshDeps,
} from "../shopify-token-refresh";

const NOW = new Date("2026-10-28T00:00:00.000Z");
const REF = { installation_id: "123e4567-e89b-42d3-a456-426614174000", generation: 2 };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    ...REF,
    tenant_id: "tenant-1",
    connected_account_id: "ca-shop",
    auth_config_id: "ac-shop-bearer",
    token_sync_pending: false,
    access_token_expires_at: new Date(NOW.getTime() + 10 * 60_000),
    refresh_token_expires_at: new Date(NOW.getTime() + 30 * 86_400_000),
    ...overrides,
  };
}

function pending(access = "access-old", refresh = "refresh-old", accessMinutes = 10) {
  return {
    ...REF,
    shop: "zavi-test-store.myshopify.com",
    access_token: access,
    refresh_token: refresh,
    scopes: ["read_products"],
    access_token_expires_at: new Date(NOW.getTime() + accessMinutes * 60_000),
    refresh_token_expires_at: new Date(NOW.getTime() + 30 * 86_400_000),
    composio_account_id: "ca-shop",
    superseded_composio_account_ids: [],
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };
let deps: ShopifyTokenRefreshDeps;

beforeEach(() => {
  logger.info.mockReset();
  logger.warn.mockReset();
  deps = {
    list: vi.fn(async () => [candidate()]),
    get: vi.fn()
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending("access-new", "refresh-new", 60)),
    refresh: vi.fn(async () => ({
      access_token: "access-new",
      refresh_token: "refresh-new",
      scopes: ["read_products"],
      access_token_expires_at: new Date(NOW.getTime() + 60 * 60_000),
      refresh_token_expires_at: new Date(NOW.getTime() + 60 * 86_400_000),
    })),
    rotate: vi.fn(async () => true),
    acquireLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
    verifyOwned: vi.fn(async () => true),
    patch: vi.fn(async () => undefined),
    verifyActive: vi.fn(async () => true),
    markSynced: vi.fn(async () => true),
  };
});

describe("refreshShopifyBearerTokens", () => {
  it("refreshes in Zavi, PATCHes Composio, verifies scope, then CAS-marks the token synced", async () => {
    await expect(refreshShopifyBearerTokens(NOW, logger, deps)).resolves.toEqual({ scanned: 1, synced: 1, failed: 0, skipped: 0 });
    expect(deps.list).toHaveBeenCalledWith(new Date(NOW.getTime() + 40 * 60_000), 100);
    expect(deps.acquireLease).toHaveBeenCalledWith(REF);
    expect(deps.releaseLease).toHaveBeenCalledWith(REF);
    expect(deps.refresh).toHaveBeenCalledWith("zavi-test-store.myshopify.com", "refresh-old");
    expect(deps.rotate).toHaveBeenCalledWith(REF, "refresh-old", expect.objectContaining({ access_token: "access-new" }));
    expect(deps.patch).toHaveBeenCalledWith({ connected_account_id: "ca-shop", access_token: "access-new" });
    expect(deps.verifyActive).toHaveBeenCalledWith({
      user_id: "tenant-1",
      auth_config_id: "ac-shop-bearer",
      connected_account_id: "ca-shop",
    });
    expect(deps.markSynced).toHaveBeenCalledWith(REF, "ca-shop", "access-new");
  });

  it("repairs a pending Composio sync without rotating a still-fresh token again", async () => {
    vi.mocked(deps.list).mockResolvedValueOnce([candidate({
      token_sync_pending: true,
      access_token_expires_at: new Date(NOW.getTime() + 55 * 60_000),
    })]);
    vi.mocked(deps.get).mockReset().mockResolvedValueOnce(pending("access-current", "refresh-current", 55));
    await expect(refreshShopifyBearerTokens(NOW, logger, deps)).resolves.toEqual({ scanned: 1, synced: 1, failed: 0, skipped: 0 });
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.rotate).not.toHaveBeenCalled();
    expect(deps.patch).toHaveBeenCalledWith({ connected_account_id: "ca-shop", access_token: "access-current" });
  });

  it("fails closed before PATCH when the account is not list-scoped to the exact tenant and config", async () => {
    vi.mocked(deps.verifyOwned).mockResolvedValueOnce(false);
    await expect(refreshShopifyBearerTokens(NOW, logger, deps)).resolves.toEqual({ scanned: 1, synced: 0, failed: 1, skipped: 0 });
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.patch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("account_scope_mismatch"));
  });

  it("skips a store whose refresh lease another process holds, without touching Shopify or Composio", async () => {
    vi.mocked(deps.acquireLease).mockResolvedValueOnce(false);
    await expect(refreshShopifyBearerTokens(NOW, logger, deps)).resolves.toEqual({ scanned: 1, synced: 0, failed: 0, skipped: 1 });
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.patch).not.toHaveBeenCalled();
    expect(deps.releaseLease).not.toHaveBeenCalled();
  });

  it("surfaces an expired refresh grant without sending the expired access token to Composio", async () => {
    vi.mocked(deps.get).mockReset().mockResolvedValueOnce({
      ...pending(),
      refresh_token_expires_at: new Date(NOW.getTime() - 1),
    });
    await expect(refreshShopifyBearerTokens(NOW, logger, deps)).resolves.toEqual({ scanned: 1, synced: 0, failed: 1, skipped: 0 });
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.patch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("refresh_grant_expired"));
  });
});
