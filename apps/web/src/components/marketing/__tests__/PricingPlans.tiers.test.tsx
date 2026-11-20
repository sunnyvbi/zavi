import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/fonts", () => ({ jakarta: { variable: "font-jakarta" } }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(), apiUrl: (p: string) => p }));

import { PricingPlans, signedOutPlanHref, tierCtaLabel } from "../PricingPlans";
import { PRICING_FALLBACK } from "@/lib/marketing/pricing";
import { PRICING_FEATURES, tierHasFeature } from "../pricingFeatures";

const RECOMMENDED_BADGE = "Recommended";

describe("PricingPlans tiers", () => {
  it("renders Free, Starter, Growth, Pro with prices and the recommended badge on Growth alone", () => {
    const html = renderToStaticMarkup(<PricingPlans />);
    for (const slug of ["free", "starter", "growth", "pro"]) expect(html).toContain(`data-tier="${slug}"`);
    for (const price of [">0<", ">10<", ">60<", ">120<"]) expect(html).toContain(price);
    const cards = Object.fromEntries(
      html
        .split('data-tier="')
        .slice(1)
        .map((part) => [part.slice(0, part.indexOf('"')), part]),
    );
    expect(Object.keys(cards)).toEqual(["free", "starter", "growth", "pro"]);
    expect(cards.starter).toContain("Regular price </span>$20</del>");
    expect(cards.growth).toContain("Regular price </span>$120</del>");
    expect(cards.pro).toContain("Regular price </span>$240</del>");
    expect(cards.growth).toContain(RECOMMENDED_BADGE);
    for (const slug of ["free", "starter", "pro"]) expect(cards[slug]).not.toContain(RECOMMENDED_BADGE);
    expect(html).toContain("What&#x27;s included");
    expect(cards.pro).toContain("Meta Ads");
    expect(cards.pro).toContain("SMS");
    expect(html).not.toMatch(/Influencer/);
    expect(html).toContain("* Daily credits reset each day and don&#x27;t roll over.");
    expect(html).toContain("Contact Sales");
    expect(html).not.toContain("credit-slider");
  });

  it("every card lists every feature row: checked where the tier has it, dashed where it does not", () => {
    const html = renderToStaticMarkup(<PricingPlans />);
    const cards = Object.fromEntries(
      html
        .split('data-tier="')
        .slice(1)
        .map((part) => [part.slice(0, part.indexOf('"')), part]),
    );
    const row = (slug: string, key: string) => {
      const m = cards[slug].match(new RegExp(`data-feature="${key}" data-included="(true|false)"`));
      return m?.[1];
    };
    for (const slug of ["free", "starter", "growth", "pro"]) {
      expect(cards[slug].match(/data-feature="/g)?.length).toBe(PRICING_FEATURES.length);
    }
    expect(row("free", "decks")).toBe("true");
    expect(row("free", "organic")).toBe("false");
    expect(row("free", "build")).toBe("true");
    expect(row("starter", "organic")).toBe("true");
    expect(row("starter", "build")).toBe("true");
    expect(row("starter", "organic_growth")).toBe("false");
    expect(row("starter", "ads")).toBe("false");
    expect(row("growth", "organic_growth")).toBe("true");
    for (const f of PRICING_FEATURES) if (f.key !== "organic_growth") expect(row("growth", f.key)).toBe(row("starter", f.key));
    for (const f of PRICING_FEATURES) expect(row("pro", f.key)).toBe("true");
  });

  it("tier membership follows each row's minimum tier", () => {
    const browser = PRICING_FEATURES.find((f) => f.key === "browser")!;
    expect(tierHasFeature("free", browser)).toBe(false);
    expect(tierHasFeature("growth", browser)).toBe(true);
    const build = PRICING_FEATURES.find((f) => f.key === "build")!;
    expect(tierHasFeature("free", build)).toBe(true);
  });

  it("paid cards state the monthly pool, the daily grant, and Growth/Pro as a multiple of Starter", () => {
    const html = renderToStaticMarkup(<PricingPlans />);
    expect(html).toContain("(6× Starter)");
    expect(html).toContain("(12× Starter)");
    expect(html).not.toContain("(1× Starter)");
    expect(html).not.toContain("Get Started For Free");
  });

  it("renders server-supplied credit numbers, not constants", () => {
    const tiers = PRICING_FALLBACK.tiers.map((t) => (t.slug === "starter" ? { ...t, monthlyCredits: 12345 } : t));
    expect(renderToStaticMarkup(<PricingPlans tiers={tiers} />)).toContain("12,345");
  });

  it("CTA targets", () => {
    expect(signedOutPlanHref("free", "6mo")).toBe("/start");
    expect(signedOutPlanHref("growth", "6mo")).toBe("/start?plan=growth&term=6mo");
    expect(signedOutPlanHref("starter", "monthly")).toBe("/start?plan=starter&term=monthly");
    expect(tierCtaLabel(PRICING_FALLBACK.tiers[2], "growth")).toBe("Current plan");
    expect(tierCtaLabel(PRICING_FALLBACK.tiers[3], null)).toBe("Start Pro");
  });
});

describe("Growth tagline", () => {
  it("states the multiplier the live credits give, not a hardcoded 6x", () => {
    expect(renderToStaticMarkup(<PricingPlans />)).toContain("6x the credits, plus creator UGC, TikTok and YouTube");
    const tiers = PRICING_FALLBACK.tiers.map((t) =>
      t.slug === "growth" ? { ...t, monthlyCredits: 40_000 } : t,
    );
    expect(renderToStaticMarkup(<PricingPlans tiers={tiers} />)).toContain("5x the credits, plus creator UGC, TikTok and YouTube");
  });
});
