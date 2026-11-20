/* eslint-disable @next/next/no-img-element */

import type { ReactNode } from "react";

export function LegalHero({
  kicker,
  title,
  subtitle,
}: {
  kicker: string;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="pt-4 md:pt-8">
      <div className="relative mx-auto w-[calc(100%-1.5rem)] max-w-[1460px] overflow-hidden rounded-block border border-[#f0f0f0] md:w-[calc(100%-2rem)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-block">
          {}
          <img
            src="/pricing-bg.webp"
            alt=""
            aria-hidden
            className="absolute max-w-none select-none"
            style={{ width: "128.23%", height: "419.77%", left: "-8.72%", top: "-124.12%" }}
          />
          {}
          <div className="absolute h-[925px] w-[979px] left-[-501px] top-[-751px]">
            <div className="absolute inset-[-24.42%_-23.07%]">
              <img src="/hero-glow.svg" alt="" aria-hidden className="block h-full w-full max-w-none" />
            </div>
          </div>
        </div>
        <div className="relative flex flex-col items-start px-6 py-10 md:px-[45px] md:py-[40px]">
          <div className="kicker text-[#191919]">{kicker}</div>
          <h1 className="mt-2 text-[30px] font-semibold leading-[1.0] tracking-[-0.83px] text-[#191919] md:text-[40px]">
            {title}
          </h1>
          {subtitle ? (
            <div className="mt-3 max-w-[560px] text-[16px] leading-[20px] text-[#787268]">
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
