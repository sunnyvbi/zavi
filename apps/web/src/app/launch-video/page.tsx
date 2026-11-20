import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { TOOLS_PATH } from "@/lib/workspace/starters";
import { LaunchVideoEntry } from "./LaunchVideoEntry";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";

export const metadata: Metadata = marketingPageMetadata(
  "/launch-video",
  "Make a launch video for your product | Zavi",
  "Describe your product and get a launch video back in about two minutes.",
);

const POINTS = [
  "Script, visuals and render, done for you",
  "Arrives by email when it is ready",
];

export default async function LaunchVideoPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="relative min-h-screen overflow-hidden bg-white text-[#0e0f11] selection:bg-ink selection:text-cream">
      {}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[1100px]">
        <img
          src="/start-bg.webp"
          alt=""
          className="absolute inset-0 h-full w-full select-none object-cover opacity-50"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(50% 45% at 18% 12%, rgba(242,153,74,0.36) 0%, rgba(242,153,74,0.14) 40%, rgba(242,153,74,0) 70%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-white" />
      </div>
      <GrowthHeader cta={cta} email={email} />
      <section className="relative w-full pb-16 pt-[120px] lg:pb-24">
        <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6">
          <Link
            href={TOOLS_PATH}
            className="inline-flex items-center gap-2 text-[14px] font-medium text-[#595959] transition-colors duration-200 hover:text-[#0e0f11]"
          >
            <ArrowLeft aria-hidden="true" className="size-4" /> All tools
          </Link>
          <div className="mx-auto mt-6 w-full max-w-[720px]">
            <div className="flex flex-col items-center text-center">
              <h1 className="text-[clamp(2rem,5vw,3.25rem)] font-extrabold leading-[1.06] tracking-[-0.03em] text-[#0e0f11]">
                A launch video for your product
              </h1>
              <p className="mt-4 max-w-[520px] text-[16px] leading-relaxed text-[#595959]">
                Tell Zavi what you are launching and who it is for. It writes the script,
                designs it, and renders the video.
              </p>
              {}
              <ul className="mt-5 flex flex-wrap justify-center gap-x-6 gap-y-2">
                {POINTS.map((p) => (
                  <li key={p} className="flex items-center gap-2 text-[14px] text-[#595959]">
                    <Check aria-hidden="true" strokeWidth={2.5} className="size-4 shrink-0 text-[#167f50]" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>

            {}
            <div className="mt-12 min-h-[560px]">
              <LaunchVideoEntry />
            </div>
          </div>
        </div>
      </section>
      <GrowthFooter startHref={email ? "/workspace" : "/start"} />
    </main>
  );
}
