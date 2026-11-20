import { describe, expect, it } from "vitest";
import { shopifyEventMs, shopifyPlanName, shopifyStateForPayload, tierForShopifyPlanName } from "../shopify-rail";

describe("shopify plan names", () => {
  it("round-trips every paid tier", () => {
    expect(shopifyPlanName("starter")).toBe("Zavi Starter");
    expect(tierForShopifyPlanName("Zavi Starter")).toBe("starter");
    expect(tierForShopifyPlanName("zavi growth ")).toBe("growth");
    expect(tierForShopifyPlanName("Zavi Pro")).toBe("pro");
  });

  it("refuses anything else", () => {
    expect(tierForShopifyPlanName("Zavi Free")).toBeNull();
    expect(tierForShopifyPlanName("Starter")).toBeNull();
    expect(tierForShopifyPlanName(undefined)).toBeNull();
  });
});

describe("shopifyStateForPayload", () => {
  const id = "gid://shopify/AppSubscription/1";

  it("an ACTIVE plan grants its tier", () => {
    expect(shopifyStateForPayload({ admin_graphql_api_id: id, name: "Zavi Growth", status: "ACTIVE" })).toEqual({ kind: "state", subscriptionId: id, tier: "growth", status: "active" });
  });

  it("a FROZEN plan keeps the tier as past due", () => {
    expect(shopifyStateForPayload({ admin_graphql_api_id: id, name: "Zavi Pro", status: "frozen" })).toEqual({ kind: "state", subscriptionId: id, tier: "pro", status: "past_due" });
  });

  it.each(["CANCELLED", "EXPIRED", "DECLINED"])("%s ends the plan whatever its name", (status) => {
    expect(shopifyStateForPayload({ admin_graphql_api_id: id, name: "whatever", status })).toEqual({ kind: "state", subscriptionId: id, tier: null, status: "canceled" });
  });

  it.each(["PENDING", "ACCEPTED", ""])("ignores %s", (status) => {
    expect(shopifyStateForPayload({ admin_graphql_api_id: id, name: "Zavi Pro", status }).kind).toBe("ignore");
  });

  it("an ACTIVE plan with an unknown name is reported, not granted", () => {
    expect(shopifyStateForPayload({ admin_graphql_api_id: id, name: "Zavi Enterprise", status: "ACTIVE" })).toEqual({ kind: "unknown_plan", name: "Zavi Enterprise" });
  });

  it("ignores a payload without a subscription id", () => {
    expect(shopifyStateForPayload({ name: "Zavi Pro", status: "ACTIVE" })).toEqual({ kind: "ignore", reason: "no_subscription_id" });
    expect(shopifyStateForPayload(null).kind).toBe("ignore");
  });
});

describe("shopifyEventMs", () => {
  it("prefers the triggered-at header, then updated_at, then now", () => {
    expect(shopifyEventMs("2026-10-30T10:00:00Z", "2026-10-30T09:00:00Z", 5)).toBe(Date.parse("2026-10-30T10:00:00Z"));
    expect(shopifyEventMs("", "2026-10-30T09:00:00Z", 5)).toBe(Date.parse("2026-10-30T09:00:00Z"));
    expect(shopifyEventMs("nope", undefined, 5)).toBe(5);
  });
});
