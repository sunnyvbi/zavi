import type { Metadata } from "next";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { jakartaHeavy } from "@/components/marketing/growth-home/fonts";
import { EYEBROW } from "@/components/marketing/growth-home/growthUi";
import { TutorialsGrid } from "@/components/marketing/tutorials/TutorialsGrid";

export const metadata: Metadata = marketingPageMetadata(
  "/tutorials",
  "Zavi tutorials",
  "Short videos that show how to do one thing in Zavi: set it up, fix your site, write posts, build a page, run a channel on a schedule and approve your first ad.",
);

export default async function TutorialsPage() {
  const { cta, email } = await resolveMarketingSession();
  const startHref = "/start";
  return (
    <>
      <GrowthHeader cta={cta} email={email} />
      <main className="min-h-screen shrink-0 bg-white text-[#0e0f11]">
        <div className="mx-auto w-full max-w-[1200px] px-6 pt-28 pb-10 sm:pt-36">
          <p className={EYEBROW}>Tutorials</p>
          <h1
            className={`${jakartaHeavy.className} mt-4 text-[clamp(2.2rem,5.4vw,3.6rem)] leading-[1.05] font-extrabold tracking-[-0.03em]`}
          >
            Zavi tutorials
          </h1>
          <p className="mt-5 max-w-[60ch] text-[18px] leading-relaxed text-[#595959]">
            Short videos, one task each. Start at the top, or jump to the one you need.
          </p>
        </div>
        <div className="pb-20">
          <TutorialsGrid startHref={startHref} />
        </div>
      </main>
      <GrowthFooter startHref={startHref} />
    </>
  );
}
