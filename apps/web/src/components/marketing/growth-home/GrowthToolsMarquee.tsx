
/* eslint-disable @next/next/no-img-element */

import { StepGlyph } from "./stepIcons";

const HEADING = "Connects to the tools you already run";

const TOOLS: { name: string; img?: string }[] = [
  { name: "Google Analytics" },
  { name: "Google Search Console" },
  { name: "HubSpot" },
  { name: "Salesforce" },
  { name: "Slack" },
  { name: "Meta Ads" },
  { name: "Google Ads" },
  { name: "LinkedIn" },
  { name: "Shopify" },
  { name: "TikTok" },
  { name: "Reddit" },
  { name: "X" },
  { name: "YouTube" },
  { name: "Instagram" },
  { name: "Microsoft Teams", img: "/logos/teams.svg" },
];

export function GrowthToolsMarquee() {
  const loop = [...TOOLS, ...TOOLS];
  return (
    <section className="w-full overflow-hidden bg-white py-14 lg:py-16">
      <h2 className="mx-auto max-w-[760px] px-6 text-center text-[clamp(1.9rem,4vw,3rem)] font-bold leading-[1.1] tracking-[-0.02em] text-[#0e0f11]">
        {HEADING}
      </h2>
      {}
      <div className="zavi-ad-row zavi-ad-mask mt-10 overflow-hidden">
        <div className="zavi-tool-marquee flex w-max items-center gap-10 sm:gap-14">
          {loop.map((t, i) => (
            <span
              key={`${t.name}-${i}`}
              aria-hidden={i >= TOOLS.length}
              className="inline-flex shrink-0 items-center gap-3"
            >
              <span className="flex size-7 shrink-0 items-center justify-center">
                {t.img ? (
                  <img src={t.img} alt="" width={24} height={24} className="size-6" loading="lazy" />
                ) : (
                  <StepGlyph name={t.name} className="size-7" />
                )}
              </span>
              <span className="whitespace-nowrap text-[20px] font-semibold text-[#0e0f11]">{t.name}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
