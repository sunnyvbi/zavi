import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  logEvent: vi.fn(async () => undefined),
  preview: vi.fn(async () => true),
  dbClient: vi.fn(),
  pendingInstall: vi.fn(),
  graphql: vi.fn(),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));
vi.mock("@/services/growth/preview-upgrade", () => ({ requestPreviewUpgrade: m.preview }));
vi.mock("@/services/tenant-client", () => ({ storeBillingClient: () => m.dbClient() }));
vi.mock("../store", () => ({ connectionsForShop: vi.fn(async () => []) }));
vi.mock("../pending-install", () => ({ getPendingShopifyInstall: m.pendingInstall }));
vi.mock("../graphql", () => ({ shopifyGraphql: m.graphql }));
import { loadCurrentActiveSubscriptionIds, makeShopifyBillingHandler, type ShopifyOutcome } from "../billing";

const T = "11111111-1111-1111-1111-111111111111";
const GID = "gid://shopify/AppSubscription/9";

function deps(overrides: Partial<Parameters<typeof makeShopifyBillingHandler>[0]> = {}) {
  const d = {
    eventProcessed: vi.fn(async () => false),
    markProcessed: vi.fn(async () => undefined),
    resolveTenantBySubscription: vi.fn(async () => null as string | null),
    resolveTenantByShop: vi.fn(async () => null as string | null),
    resolveTenantByConnection: vi.fn(async () => T as string | null),
    resolveBillingSnapshot: vi.fn(async () => ({ source: "shopify", status: "canceled", watermark: 1_700_000_001_000 })),
    currentActiveSubscriptionIds: vi.fn(async () => [] as readonly string[]),
    applyState: vi.fn(async () => ({ error: null, outcome: "applied" as ShopifyOutcome | null })),
    applyVerifiedState: vi.fn(async () => ({ error: null, outcome: "applied" as ShopifyOutcome | null })),
    setMonthlyCredits: vi.fn(async () => ({ error: null })),
    requestPreviewRerun: vi.fn(async () => true),
    ...overrides,
  };
  return { d, h: makeShopifyBillingHandler(d) };
}

const event = (sub: Record<string, unknown> | null, extra: Partial<{ eventId: string; topic: string }> = {}) => ({
  eventId: extra.eventId ?? "wh_1",
  topic: extra.topic ?? "app_subscriptions/update",
  shop: "acme.myshopify.com",
  eventMs: 1_700_000_000_000,
  subscription: sub,
});

beforeEach(() => {
  m.logEvent.mockClear();
  m.dbClient.mockReset().mockImplementation(() => { throw new Error("db not expected"); });
  m.pendingInstall.mockReset();
  m.graphql.mockReset();
});

describe("subscriptionUpdated", () => {
  it("grants the tier, refreshes credits and queues the upgraded channels for an ACTIVE plan", async () => {
    const { d, h } = deps();
    const r = await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Growth", status: "ACTIVE" }));
    expect(r).toEqual({ ok: true, outcome: "applied" });
    expect(d.applyState).toHaveBeenCalledWith({ tenant_id: T, shop: "acme.myshopify.com", shopify_subscription_id: GID, tier: "growth", status: "active", event_ms: 1_700_000_000_000 });
    expect(d.setMonthlyCredits).toHaveBeenCalledWith(T, 1_700_000_000);
    expect(d.requestPreviewRerun).toHaveBeenCalledWith(T);
    expect(d.markProcessed).toHaveBeenCalledWith("wh_1", "app_subscriptions/update");
  });

  it("resolves the workspace by the subscription first, then the shop's own Shopify row, then its single connection", async () => {
    const { d, h } = deps({ resolveTenantBySubscription: vi.fn(async () => "sub-tenant") });
    await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }));
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "sub-tenant" }));
    expect(d.resolveTenantByShop).not.toHaveBeenCalled();
    expect(d.resolveTenantByConnection).not.toHaveBeenCalled();
  });

  it("applies nothing when no workspace owns the shop", async () => {
    const { d, h } = deps({ resolveTenantByConnection: vi.fn(async () => null) });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }))).toEqual({ ok: true, unbound: true });
    expect(d.applyState).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "shopify_billing_unbound" }));
  });

  it("a cancelled plan drops the tier without queueing channels", async () => {
    const { d, h } = deps({ resolveTenantBySubscription: vi.fn(async () => T) });
    await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "CANCELLED" }));
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: null, status: "canceled" }));
    expect(d.setMonthlyCredits).toHaveBeenCalled();
    expect(d.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("lets the watermark decide a cancellation for an unknown subscription id", async () => {
    const { d, h } = deps({
      resolveTenantBySubscription: vi.fn(async () => null),
      resolveTenantByShop: vi.fn(async () => T),
    });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "CANCELLED" })))
      .toEqual({ ok: true, outcome: "applied" });
    expect(d.resolveTenantByShop).toHaveBeenCalledWith("acme.myshopify.com", true);
    expect(d.resolveTenantByConnection).not.toHaveBeenCalled();
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ tier: null, status: "canceled" }));
    expect(d.markProcessed).toHaveBeenCalledWith("wh_1", "app_subscriptions/update");
  });

  it("revives a stale paid event only when Shopify still lists that exact subscription as active", async () => {
    const applyState = vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome }));
    const applyVerifiedState = vi.fn(async () => ({ error: null, outcome: "applied" as ShopifyOutcome }));
    const { d, h } = deps({
      applyState,
      applyVerifiedState,
      currentActiveSubscriptionIds: vi.fn(async () => [GID]),
    });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" })))
      .toEqual({ ok: true, outcome: "applied" });
    expect(applyVerifiedState).toHaveBeenCalledWith(expect.objectContaining({
      shopify_subscription_id: GID,
      expected_event_ms: 1_700_000_001_000,
      event_ms: 1_700_000_002_000,
    }));
    expect(d.setMonthlyCredits).toHaveBeenCalledWith(T, 1_700_000_000);
  });

  it("verifies and revives an ACTIVE replacement that shares the cancellation watermark", async () => {
    const applyVerifiedState = vi.fn(async () => ({ error: null, outcome: "applied" as ShopifyOutcome }));
    const { h } = deps({
      applyState: vi.fn(async () => ({ error: null, outcome: "replay" as ShopifyOutcome })),
      applyVerifiedState,
      currentActiveSubscriptionIds: vi.fn(async () => [GID]),
    });
    expect(await h.subscriptionUpdated({
      ...event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }),
      eventMs: 1_700_000_001_000,
    })).toEqual({ ok: true, outcome: "applied" });
    expect(applyVerifiedState).toHaveBeenCalledWith(expect.objectContaining({
      expected_event_ms: 1_700_000_001_000,
      event_ms: 1_700_000_002_000,
    }));
  });

  it("never revives an old paid event that Shopify no longer lists as active", async () => {
    const applyState = vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome }));
    const currentActiveSubscriptionIds = vi.fn(async () => ["gid://shopify/AppSubscription/new"]);
    const { d, h } = deps({ applyState, currentActiveSubscriptionIds });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" })))
      .toEqual({ ok: true, outcome: "stale" });
    expect(currentActiveSubscriptionIds).toHaveBeenCalledWith("acme.myshopify.com", T);
    expect(applyState).toHaveBeenCalledTimes(1);
    expect(d.setMonthlyCredits).not.toHaveBeenCalled();
  });

  it("does not call Shopify for an ordinary stale replay against an active row", async () => {
    const currentActiveSubscriptionIds = vi.fn(async () => [GID]);
    const { h } = deps({
      applyState: vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome })),
      resolveBillingSnapshot: vi.fn(async () => ({ source: "shopify", status: "active", watermark: 1_700_000_001_000 })),
      currentActiveSubscriptionIds,
    });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" })))
      .toEqual({ ok: true, outcome: "stale" });
    expect(currentActiveSubscriptionIds).not.toHaveBeenCalled();
  });

  it("does not revive when the billing watermark changes after Shopify verification", async () => {
    const { d, h } = deps({
      applyState: vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome })),
      currentActiveSubscriptionIds: vi.fn(async () => [GID]),
      applyVerifiedState: vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome })),
    });
    await expect(h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" })))
      .rejects.toThrow("verified_shopify_state_changed");
    expect(d.setMonthlyCredits).not.toHaveBeenCalled();
    expect(d.markProcessed).not.toHaveBeenCalled();
  });

  it("fails closed when Shopify cannot verify a stale paid event", async () => {
    const applyState = vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome }));
    const { d, h } = deps({
      applyState,
      currentActiveSubscriptionIds: vi.fn(async () => { throw new Error("Shopify unavailable"); }),
    });
    await expect(h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" })))
      .rejects.toThrow("Shopify unavailable");
    expect(applyState).toHaveBeenCalledTimes(1);
    expect(d.markProcessed).not.toHaveBeenCalled();
    expect(d.setMonthlyCredits).not.toHaveBeenCalled();
  });

  it("a duplicate event is acknowledged without a write", async () => {
    const { d, h } = deps({ eventProcessed: vi.fn(async () => true) });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }))).toEqual({ ok: true, duplicate: true });
    expect(d.applyState).not.toHaveBeenCalled();
  });

  it("a pending plan is ignored and not recorded", async () => {
    const { d, h } = deps();
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "PENDING" }))).toEqual({ ok: true, ignored: "PENDING" });
    expect(d.markProcessed).not.toHaveBeenCalled();
  });

  it("an unknown plan name throws so Shopify retries and staff see it", async () => {
    const { d, h } = deps();
    await expect(h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Enterprise", status: "ACTIVE" }))).rejects.toThrow("unknown_plan");
    expect(d.applyState).not.toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "shopify_unknown_plan" }));
  });

  it.each(["stripe_active", "store_active", "refund_blocked", "shop_in_use", "other_shop_active", "grandfathered"] as ShopifyOutcome[])("%s is recorded as a conflict and grants nothing", async (outcome) => {
    const { d, h } = deps({ applyState: vi.fn(async () => ({ error: null, outcome })) });
    expect(await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }))).toEqual({ ok: true, outcome });
    expect(d.setMonthlyCredits).not.toHaveBeenCalled();
    expect(d.markProcessed).toHaveBeenCalled();
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "shopify_state_conflict", tenant_id: T }));
  });

  it("a stale event is recorded for billing reconciliation", async () => {
    const { h } = deps({ applyState: vi.fn(async () => ({ error: null, outcome: "stale" as ShopifyOutcome })) });
    await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }));
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "shopify_state_stale", tenant_id: T }));
  });

  it("a replay re-runs the credit refresh", async () => {
    const { d, h } = deps({ applyState: vi.fn(async () => ({ error: null, outcome: "replay" as ShopifyOutcome })) });
    await h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }));
    expect(d.setMonthlyCredits).toHaveBeenCalled();
  });

  it("throws when the write or the credit refresh fails, so nothing is marked processed", async () => {
    const a = deps({ applyState: vi.fn(async () => ({ error: { message: "boom" }, outcome: null })) });
    await expect(a.h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }))).rejects.toThrow("boom");
    expect(a.d.markProcessed).not.toHaveBeenCalled();
    const b = deps({ setMonthlyCredits: vi.fn(async () => ({ error: { message: "credits" } })) });
    await expect(b.h.subscriptionUpdated(event({ admin_graphql_api_id: GID, name: "Zavi Pro", status: "ACTIVE" }))).rejects.toThrow("credits");
    expect(b.d.markProcessed).not.toHaveBeenCalled();
  });
});

describe("current Shopify subscription verification", () => {
  function grantLookup() {
    const maybeSingle = vi.fn(async () => ({ data: { id: "install-1", generation: 4 }, error: null }));
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    const select = vi.fn(() => query);
    m.dbClient.mockReturnValue({ from: vi.fn(() => ({ select })) });
  }

  it("reads exact active subscription IDs with the stored grant", async () => {
    grantLookup();
    m.pendingInstall.mockResolvedValue({
      shop: "acme.myshopify.com",
      access_token: "access",
      access_token_expires_at: new Date(Date.now() + 60_000),
    });
    m.graphql.mockResolvedValue({ currentAppInstallation: { activeSubscriptions: [{ id: GID }] } });
    await expect(loadCurrentActiveSubscriptionIds("acme.myshopify.com", T)).resolves.toEqual([GID]);
    expect(m.graphql).toHaveBeenCalledWith(expect.objectContaining({ shop: "acme.myshopify.com", accessToken: "access" }));
  });

  it("fails closed before GraphQL when the stored grant is expired", async () => {
    grantLookup();
    m.pendingInstall.mockResolvedValue({
      shop: "acme.myshopify.com",
      access_token: "expired",
      access_token_expires_at: new Date(Date.now() - 1),
    });
    await expect(loadCurrentActiveSubscriptionIds("acme.myshopify.com", T)).rejects.toThrow("grant unavailable");
    expect(m.graphql).not.toHaveBeenCalled();
  });

  it("treats a missing installation grant as not verified instead of retrying forever", async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const query = { eq: vi.fn(), maybeSingle };
    query.eq.mockReturnValue(query);
    m.dbClient.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => query) })) });
    await expect(loadCurrentActiveSubscriptionIds("acme.myshopify.com", T)).resolves.toEqual([]);
    expect(m.pendingInstall).not.toHaveBeenCalled();
    expect(m.graphql).not.toHaveBeenCalled();
  });
});

describe("appUninstalled", () => {
  it("ends the shop's Shopify plan", async () => {
    const { d, h } = deps({ resolveTenantByShop: vi.fn(async () => T) });
    expect(await h.appUninstalled(event(null, { topic: "app/uninstalled", eventId: "wh_u" }))).toEqual({ ok: true, outcome: "applied" });
    expect(d.applyState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, shopify_subscription_id: null, tier: null, status: "canceled" }));
    expect(d.requestPreviewRerun).not.toHaveBeenCalled();
  });

  it("does nothing for a shop with no Shopify plan", async () => {
    const { d, h } = deps();
    expect(await h.appUninstalled(event(null, { topic: "app/uninstalled" }))).toEqual({ ok: true, ignored: "no_shopify_plan" });
    expect(d.applyState).not.toHaveBeenCalled();
    expect(d.resolveTenantByConnection).not.toHaveBeenCalled();
  });
});
