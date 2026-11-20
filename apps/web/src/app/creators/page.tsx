
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { CREATOR_AREA_CTA, resolveCreatorsPageSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { CreatorHero } from "@/components/marketing/creators-landing/CreatorHero";
import { FormatsMarquee } from "@/components/marketing/creators-landing/FormatsMarquee";
import { JobStory } from "@/components/marketing/creators-landing/JobStory";
import { MoneyFlow } from "@/components/marketing/creators-landing/MoneyFlow";
import { ClosingPanel } from "@/components/marketing/creators-landing/ClosingPanel";
import { jakartaHeavy } from "@/components/marketing/growth-home/fonts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = marketingPageMetadata(
  "/creators",
  "Zavi for creators | Get paid to make videos for businesses",
  "Set your prices, get booked by businesses inside Zavi, and get paid through Stripe. Free to join.",
);

export default async function CreatorsLandingPage() {
  if (!CREATOR_MARKETPLACE_ENABLED) notFound();

  const { cta, email } = await resolveCreatorsPageSession();
  const signedIn = email !== null;
  const creatorArea = cta.href === CREATOR_AREA_CTA.href ? CREATOR_AREA_CTA : null;

  return (
    <>
      <GrowthHeader cta={cta} email={email} />
      {}
      <main className={`${jakartaHeavy.className} min-h-screen shrink-0 overflow-x-clip bg-white text-[#0e0f11]`}>
        <CreatorHero creatorArea={creatorArea} />
        <FormatsMarquee />
        <JobStory />
        <MoneyFlow />
        <ClosingPanel creatorArea={creatorArea} />
      </main>
      <GrowthFooter startHref={creatorArea ? CREATOR_AREA_CTA.href : signedIn ? "/workspace" : "/start"} />
    </>
  );
}
