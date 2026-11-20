import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/marketing/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketing/pricing")>();
  return { ...actual, getLivePricing: vi.fn(async () => actual.PRICING_FALLBACK) };
});

import ShopifyPricingPage from "./page";
import { PRICING_FALLBACK } from "@/lib/marketing/pricing";

describe("Shopify pricing page", () => {
  it("shows every plan as Shopify-billed information without an off-platform checkout", async () => {
    const html = renderToStaticMarkup(await ShopifyPricingPage());
    for (const plan of ["Free", "Starter", "Growth", "Pro"]) expect(html).toContain(plan);
    for (const tier of ["starter", "growth", "pro"] as const) {
      const plan = PRICING_FALLBACK.tiers.find((candidate) => candidate.slug === tier);
      expect(html).toContain(`$${(plan?.sixMonthUsd ?? 0) * 2}/year`);
    }
    expect(html).toContain("Shopify shows the exact charge for approval");
    expect(html).toContain("Shopify merchants subscribe only in Shopify admin; this page has no checkout");
    expect(html).toContain("Everything in Starter, plus:");
    expect(html).toContain("every 30 days");
    expect(html).not.toContain("/api/billing/checkout");
    expect(html).not.toContain("stripe");
  });
});
