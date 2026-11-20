import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { PricingPlans } from "@/components/marketing/PricingPlans";
import { getLivePricing, liveTier } from "@/lib/marketing/pricing";

export async function generateMetadata(): Promise<Metadata> {
  const pricing = await getLivePricing();
  const starter = liveTier(pricing, "starter");
  const growth = liveTier(pricing, "growth");
  const pro = liveTier(pricing, "pro");
  const desc = `Zavi pricing: Free, Starter $${starter.usd}/mo, Growth $${growth.usd}/mo and Pro $${pro.usd}/mo. Every plan gets ${pricing.freeDailyCredits.toLocaleString()} credits a day, no card needed. Paid plans add monthly credits, organic growth channels, and on Pro, paid ads, engineer and fundraising agents.`;
  return marketingPageMetadata("/pricing", "Pricing | Zavi", desc);
}

export default async function PricingPage() {
  const [{ cta, email }, pricing] = await Promise.all([resolveMarketingSession(), getLivePricing()]);
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-ink selection:text-cream">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />
      <PricingPlans
        tiers={pricing.tiers}
        freeDailyCredits={pricing.freeDailyCredits}
        signedIn={email !== null}
        sixMonthAvailable={pricing.sixMonthAvailable}
        sixMonthMonths={pricing.sixMonthMonths}
        sixMonthDiscountPct={pricing.sixMonthDiscountPct}
      />
      <GrowthFooter startHref="/start" />
    </main>
  );

}
