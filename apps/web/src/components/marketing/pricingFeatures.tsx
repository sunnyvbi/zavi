
import { PRICING_CONFIG, tierHasPricingFeature, type PricingFeature } from "@zavi/shared";
import type { PlanTier, TierSlug } from "@/lib/marketing/pricing";
import { ChannelMark, readChannelLine } from "@/components/marketing/pricingChannels";

export type { PricingFeature };

export const PRICING_FEATURES: readonly PricingFeature[] = PRICING_CONFIG.features;

export function tierHasFeature(tier: TierSlug, f: PricingFeature): boolean {
  return tierHasPricingFeature(tier, f);
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="mt-px size-4 flex-none text-[#0E9F6E]" fill="none" aria-hidden>
      <path d="M4.5 10.5L8.5 14.5L15.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Dash() {
  return (
    <span aria-hidden className="mt-px flex size-4 flex-none items-center justify-center text-[#c4c4c4]">
      -
    </span>
  );
}

function ChannelLine({ name }: { name: string }) {
  const { mark } = readChannelLine(name);
  return (
    <li data-channel={name} className="flex items-center gap-2 text-[13px] leading-[18px] text-[#1f1f1f]">
      {mark ? <ChannelMark mark={mark} /> : <Check />}
      <span className="min-w-0">{name}</span>
    </li>
  );
}

export function FeatureRow({ feature, included }: { feature: PricingFeature; included: boolean }) {
  if (!included) {
    return (
      <div data-feature={feature.key} data-included="false" className="flex gap-2 text-[13px] leading-[18px] text-[#a3a3a3]">
        <span className="sr-only">Not included: </span>
        <Dash />
        <span className="min-w-0">{feature.label}</span>
      </div>
    );
  }
  return (
    <div data-feature={feature.key} data-included="true" className="text-[13px] leading-[18px] text-[#1f1f1f]">
      <div className="flex gap-2">
        <Check />
        <span className={`min-w-0 ${feature.channels ? "font-semibold" : ""}`}>{feature.label}</span>
      </div>
      {feature.channels && (
        <ul className="mt-2 flex flex-col gap-2 pl-6">
          {feature.channels.map((c) => (
            <ChannelLine key={c.name} name={c.name} />
          ))}
        </ul>
      )}
    </div>
  );
}

const nf = new Intl.NumberFormat("en-US");

export function taglineFor(slug: TierSlug, tiers: readonly PlanTier[]): string {
  const line = TIER_TAGLINE[slug];
  if (!line.includes("{x}")) return line;
  const starter = tiers.find((t) => t.slug === "starter")?.monthlyCredits ?? 0;
  const growth = tiers.find((t) => t.slug === "growth")?.monthlyCredits ?? 0;
  const ratio = starter > 0 && growth > 0 ? Math.round((growth / starter) * 10) / 10 : 0;
  return ratio > 1 ? line.replace("{x}", `${ratio}x`) : line.replace("{x} the credits", "More credits");
}

const TIER_TAGLINE: Record<TierSlug, string> = {
  free: "Plan your growth, free forever",
  starter: "Run your organic growth",
  growth: "{x} the credits, plus creator UGC, TikTok and YouTube",
  pro: "Add paid ads and engineering",
};

export function TierCredits({ tier, starterMonthly }: { tier: PlanTier; starterMonthly: number }) {
  const multiple =
    tier.slug !== "starter" && tier.monthlyCredits > 0 && starterMonthly > 0
      ? Math.round(tier.monthlyCredits / starterMonthly)
      : 0;
  return (
    <div className="flex min-h-[48px] flex-col gap-2 text-[14px] font-medium leading-5 text-[#1f1f1f]">
      {tier.monthlyCredits > 0 && (
        <p>
          <span className="font-semibold">{nf.format(tier.monthlyCredits)}</span> credits monthly
          {multiple > 1 && <span className="text-[#027bff]">{` (${multiple}× Starter)`}</span>}
        </p>
      )}
      <p>
        {tier.monthlyCredits > 0 ? "+ " : ""}
        <span className="font-semibold">{nf.format(tier.dailyCredits)}</span> credits added daily*
        {tier.monthlyCredits > 0 ? "" : ". No card."}
      </p>
    </div>
  );
}
