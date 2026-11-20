import { describe, expect, it } from "vitest";
import { CREATOR_MARKETPLACE_ENABLED, creatorMarketplaceApiPath } from "./availability";

describe("creator marketplace availability", () => {
  it("is enabled, so no API path is blocked by default", () => {
    expect(CREATOR_MARKETPLACE_ENABLED).toBe(true);
    expect(creatorMarketplaceApiPath("/api/humans/orders", "POST")).toBe(false);
    expect(creatorMarketplaceApiPath("/api/creator/signup", "POST")).toBe(false);
  });

  it.each([
    "/api/creator/signup",
    "/api/creator/briefs",
    "/api/creator/affiliate",
    "/api/humans/creators/search",
    "/api/humans/orders/quote",
    "/api/humans/orders/order-1/checkout",
    "/api/creators/invite/prefill",
    "/API/Humans/orders/quote",
  ])("blocks marketplace path %s", (path) => {
    expect(creatorMarketplaceApiPath(path, "GET", false)).toBe(true);
  });

  it.each([
    "/api/creator/home",
    "/api/creator/jobs/order-1",
    "/api/creator/earnings",
    "/api/creators/threads",
    "/api/creators/threads/thread-1/messages",
    "/api/creators/threads/thread-1/offers",
    "/api/humans/orders",
    "/api/humans/orders/order-1/actions",
    "/api/creators/library",
    "/api/creators/library/asset-1/download",
    "/api/creators/invite/unsubscribe",
    "/api/shopify/app-home",
  ])("keeps non-marketplace path %s", (path) => {
    expect(creatorMarketplaceApiPath(path, "GET", false)).toBe(false);
  });

  it("blocks writes that could create supply while keeping existing-job reads", () => {
    expect(creatorMarketplaceApiPath("/api/creator/profile", "PATCH", false)).toBe(false);
    expect(creatorMarketplaceApiPath("/api/humans/orders", "POST", false)).toBe(true);
    expect(creatorMarketplaceApiPath("/api/humans/orders/order-1", "GET", false)).toBe(false);
    expect(creatorMarketplaceApiPath("/api/creators/threads/thread-1/messages", "POST", false)).toBe(false);
    expect(creatorMarketplaceApiPath("/api/creators/threads/thread-1/offers", "POST", false)).toBe(true);
    expect(creatorMarketplaceApiPath("/api/creators/threads", "POST", false)).toBe(true);
    expect(creatorMarketplaceApiPath("/api/creators/member-1/threads", "POST", false)).toBe(true);
  });
});
