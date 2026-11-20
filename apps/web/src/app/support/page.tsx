import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { CalBookingEmbed } from "./CalBookingEmbed";

export const metadata: Metadata = marketingPageMetadata(
  "/support",
  "Support | Zavi",
  "Get help with your Zavi account, integrations, or any questions about using Zavi. Email support@zaviagent.com or book a support call with our team.",
);

export default async function SupportPage() {
  const { cta, email } = await resolveMarketingSession();

  return (
    <main
      className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-ink selection:bg-ink selection:text-white`}
    >
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      {}
      <div className="flex flex-col gap-6 px-3 pb-10 pt-5 md:gap-[50px] md:px-4 md:pb-20 md:pt-10">
        {}
        <section className="relative mx-auto w-full max-w-[1240px] overflow-hidden rounded-block border border-[#f0f0f0] bg-white">
          {}
          <img
            src="/hero/zavi-support-hero-bg.webp"
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
          />
          <div className="relative px-6 py-8 md:px-[45px]">
            <p className="text-[13px] font-normal uppercase leading-[19px] tracking-[2px] text-[#191919]">
              Support
            </p>
            <h1 className="pt-2 text-[32px] font-semibold leading-[1.1] tracking-[-0.83px] text-[#191919] md:text-[40px] md:leading-[40px]">
              Zavi Support
            </h1>
            <p className="pt-3 text-[16px] leading-[20px] tracking-[-0.11px] text-[#787268]">
              Get help with your Zavi account, integrations, or any questions about using Zavi.
            </p>
            <div className="mt-6 max-w-[770px] text-[16px] leading-[26px] tracking-[0.16px] text-[#0e0f11] md:text-[20px] md:leading-[28px] md:tracking-[0.18px]">
              <p>
                Email us at{" "}
                <a
                  href="mailto:support@zaviagent.com"
                  className="font-semibold underline underline-offset-2 transition-opacity hover:opacity-70"
                >
                  support@zaviagent.com
                </a>
                . We typically respond within 24 hours.
                <br className="hidden md:block" />
                {" "}Prefer to speak with us? Book a support call with our team.
              </p>
            </div>
          </div>
        </section>

        {}
        {}
        <section className="mx-auto w-full max-w-[1091px] rounded-block bg-[#f9f9f9] p-4 md:p-[25px]">
          <CalBookingEmbed />
        </section>
      </div>

      <GrowthFooter startHref="/start" />
    </main>
  );
}
