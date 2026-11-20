import type { Metadata } from "next";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthHero } from "@/components/marketing/growth-home/GrowthHero";
import { getLivePillSlug } from "@/lib/marketing/liveUpcar";
import { GrowthFounderVideo } from "@/components/marketing/growth-home/GrowthFounderVideo";
import { GrowthThreeSteps } from "@/components/marketing/growth-home/GrowthThreeSteps";
import { GrowthCostTable } from "@/components/marketing/growth-home/GrowthCostTable";
import { GrowthAutopilot } from "@/components/marketing/growth-home/GrowthAutopilot";
import { GrowthWhyTeams } from "@/components/marketing/growth-home/GrowthWhyTeams";
import { GrowthRealAds } from "@/components/marketing/growth-home/GrowthRealAds";
import { GrowthToolsMarquee } from "@/components/marketing/growth-home/GrowthToolsMarquee";
import { GrowthFaq } from "@/components/marketing/growth-home/GrowthFaq";
import { HOME_FAQ } from "@/components/marketing/homeFaq";
import { GrowthDownloadApp } from "@/components/marketing/growth-home/GrowthDownloadApp";
import { getIosAppStoreLive } from "@/lib/marketing/iosAppStatus";
import { GrowthFinalCta } from "@/components/marketing/growth-home/GrowthFinalCta";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import MeetWithZavi from "@/components/marketing/MeetWithZavi";
import { ZaviTestBubble } from "@/components/marketing/ZaviTestBubble";
import { HomeStructuredData } from "@/components/marketing/StructuredData";
import { getLivePricing } from "@/lib/marketing/pricing";
import { onboardingAttributionHref, urlAttribution, withUrlAttribution } from "@/lib/marketing/liveFrom";

export const dynamic = "force-dynamic";

const WWW_ORIGIN = "https://www.zaviagent.com";

export async function generateMetadata(): Promise<Metadata> {
  const { freeDailyCredits } = await getLivePricing();
  return {
    title: "Zavi: AI Growth Agent For Your Business",
    description:
      `Zavi is an AI growth agent for your business. It reads your business, writes the growth plan, runs the channels with your approval, and tells you what changed. Start free with ${freeDailyCredits.toLocaleString()} credits every day, no card and no sales call. Free credits reset daily; paid credits pool monthly for bigger builds.`,
    alternates: { canonical: `${WWW_ORIGIN}/` },
    robots: { index: true, follow: true },
  };
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ cta, email }, iosLive, livePillSlug, { freeDailyCredits }, query] = await Promise.all([
    resolveMarketingSession(),
    getIosAppStoreLive(),
    getLivePillSlug(),
    getLivePricing(),
    searchParams ?? {},
  ]);
  const attribution = urlAttribution(query);
  const heroCtaHref = withUrlAttribution("/start", attribution);
  const loginHref = Object.keys(attribution).length
    ? `/login?${new URLSearchParams({ next: withUrlAttribution("/workspace", attribution) })}`
    : "/login";
  const headerCta = { ...cta, href: onboardingAttributionHref(cta.href, attribution) };
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-violet selection:text-white">

      <HomeStructuredData freeDailyCredits={freeDailyCredits} />

      <GrowthHeader cta={headerCta} email={email} loginHref={loginHref} />

      {}
      {}
      <GrowthHero startHref={heroCtaHref} livePillSlug={livePillSlug} />
      {}
      <GrowthFounderVideo startHref={heroCtaHref} />
      {}
      <GrowthThreeSteps />
      {}
      {}
      {}
      {}
      <GrowthWhyTeams />
      {}
      <GrowthRealAds />
      {}
      <GrowthToolsMarquee />
      {}
      <MeetWithZavi startHref={heroCtaHref} />
      {}
      {}
      <GrowthCostTable startHref={heroCtaHref} />
      {}
      <GrowthAutopilot />
      {}
      <GrowthDownloadApp iosLive={iosLive} />

      {}

      {}
      <GrowthFaq items={HOME_FAQ} />

      {}
      <GrowthFinalCta startHref={heroCtaHref} />

      <GrowthFooter startHref={heroCtaHref} />

      {}
      <ZaviTestBubble freeDailyCredits={freeDailyCredits} startHref={heroCtaHref} />
    </main>
  );
}
