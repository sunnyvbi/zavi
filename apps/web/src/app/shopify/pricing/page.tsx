import type { Metadata } from "next";
import { getLivePricing, tierDisplayName } from "@/lib/marketing/pricing";

export const metadata: Metadata = {
  title: "Zavi plans for Shopify",
  description: "Zavi plans billed through Shopify. Review and approve every paid plan in Shopify admin.",
};

export default async function ShopifyPricingPage() {
  const pricing = await getLivePricing();

  return (
    <main className="min-h-screen bg-[#f6f6f7] px-5 py-12 text-neutral-950 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-neutral-600">Zavi for Shopify</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">Plans billed through Shopify</h1>
          <p className="mt-4 text-base leading-7 text-neutral-600">
            Open Zavi from Shopify admin to choose a paid plan. Shopify shows the exact charge for approval, and the charge appears on your Shopify bill.
          </p>
        </div>

        <section aria-label="Zavi plans" className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {pricing.tiers.map((tier) => (
            <article key={tier.slug} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">{tierDisplayName(tier.slug)}</h2>
              <p className="mt-3 text-3xl font-semibold">
                ${tier.usd}
                {tier.slug !== "free" && <span className="text-sm font-normal text-neutral-500"> every 30 days</span>}
              </p>
              {tier.slug !== "free" && (
                <p className="mt-1 text-sm text-neutral-500">
                  or ${tier.sixMonthUsd * 2}/year
                </p>
              )}
              <p className="mt-2 text-sm text-neutral-600">
                {tier.slug === "free"
                  ? `${pricing.freeDailyCredits.toLocaleString()} credits every day`
                  : `${tier.monthlyCredits.toLocaleString()} monthly credits, plus the daily grant`}
              </p>
              <ul className="mt-5 space-y-2 text-sm leading-5 text-neutral-700">
                {tier.includes.map((line) => (
                  <li key={line} className={line.endsWith(":") ? "font-semibold text-neutral-900" : undefined}>
                    {line.endsWith(":") ? line : `• ${line}`}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        <div className="mt-8 rounded-2xl border border-neutral-200 bg-white p-5 text-sm leading-6 text-neutral-600">
          <p className="font-semibold text-neutral-900">How to subscribe</p>
          <p>Shopify admin → Apps → Zavi → Plan → choose a plan → approve the charge on Shopify.</p>
          <p className="mt-2">Shopify merchants subscribe only in Shopify admin; this page has no checkout.</p>
        </div>
      </div>
    </main>
  );
}
