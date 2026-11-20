"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Check, LayoutGrid, Plus, X } from "lucide-react";
import { caveat } from "../fonts";
import {
  CHANNELS,
  ChannelIcon,
  GROUP_LABEL,
  PLANS,
  cents,
  money,
  monthlyPrice,
  type Plan,
} from "./pricingData";

const TRUST_GLYPHS: Record<string, ReactNode> = {
  card: (
    <>
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
    </>
  ),
  cancel: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  onboard: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </>
  ),
  support: (
    <>
      <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z" />
      <path d="M21 16v2a4 4 0 0 1-4 4h-5" />
    </>
  ),
};

const TRUST: { label: string; glyph: keyof typeof TRUST_GLYPHS; crossed?: boolean }[] = [
  { label: "No credit card", glyph: "card", crossed: true },
  { label: "Cancel anytime", glyph: "cancel" },
  { label: "Onboard in minutes", glyph: "onboard" },
  { label: "Founder-led support", glyph: "support" },
];

function TrustRow({ className = "" }: { className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center justify-center gap-x-8 gap-y-3 ${className}`}>
      {TRUST.map((t) => (
        <li key={t.label} className="flex items-center gap-3 text-[16px] font-medium text-[#0e0f11]">
          <span
            aria-hidden="true"
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-b from-[#f4f4f5] to-[#e4e4e7] text-[#71717b] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(16,18,20,0.08)] ring-1 ring-black/[0.04]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              {TRUST_GLYPHS[t.glyph]}
            </svg>
            {t.crossed && (
              <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#9f9fa9] text-white ring-2 ring-white">
                <X strokeWidth={3} className="h-2.5 w-2.5" />
              </span>
            )}
          </span>
          {t.label}
        </li>
      ))}
    </ul>
  );
}

function MonthsFreeBadge({ dark }: { dark: boolean }) {
  return (
    <span
      className={`${caveat.className} relative inline-block -rotate-6 px-2.5 py-0.5 text-[21px] leading-none ${
        dark ? "text-[#4ade80]" : "text-[#16a34a]"
      }`}
    >
      2+ months free
      <svg
        aria-hidden="true"
        viewBox="0 0 140 44"
        preserveAspectRatio="none"
        className="absolute -inset-x-1 -inset-y-1 h-[calc(100%+8px)] w-[calc(100%+8px)]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      >
        <path d="M10 24C6 11 44 4 78 5s54 7 52 18-44 16-78 15S13 36 9 22" />
      </svg>
    </span>
  );
}

function PlanCard({ plan, annual, startHref }: { plan: Plan; annual: boolean; startHref: string }) {
  const dark = plan.theme === "dark";
  const price = monthlyPrice(plan, annual);
  const paid = plan.monthly > 0;
  const muted = dark ? "text-white/60" : "text-[#595959]";
  const billing = paid ? (annual ? `$${money(cents(12 * price))} billed yearly` : "Billed monthly") : "Free forever";

  return (
    <li
      className={`relative flex flex-col rounded-[28px] p-7 sm:p-8 ${
        dark
          ? "border border-white/[0.08] bg-[#1c1a19] text-white"
          : "border border-black/[0.06] bg-white text-[#0e0f11] shadow-[0_40px_90px_-40px_rgba(16,18,20,0.45)] lg:-my-5 lg:py-12"
      }`}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[24px] font-bold leading-none tracking-[-0.02em]">{plan.name}</h3>
        {annual && paid && <MonthsFreeBadge dark={dark} />}
      </div>
      <p className="mt-5 flex items-end gap-2">
        <span className="text-[52px] font-bold leading-none tracking-[-0.03em] tabular-nums">${money(price)}</span>
        {paid && <span className={`pb-1.5 text-[20px] ${muted}`}>/mo</span>}
        {annual && paid && (
          <s className={`pb-1.5 text-[20px] ${dark ? "text-white/35" : "text-black/30"}`}>${plan.monthly}</s>
        )}
      </p>
      <p className={`mt-2 text-[16px] ${muted}`}>{billing}</p>
      <p className={`mt-4 text-[16px] ${dark ? "text-white/80" : "text-[#1f1f1f]"}`}>{plan.tagline}</p>
      <hr className={`my-6 ${dark ? "border-white/10" : "border-black/[0.08]"}`} />
      <div className="relative">
        <Link
          href={startHref}
          prefetch={false}
          className={`flex h-14 items-center justify-center rounded-2xl text-[16px] font-semibold transition-opacity duration-200 hover:opacity-90 ${
            dark ? "bg-white text-[#0e0f11]" : "bg-[#0e0f11] text-white shadow-[0_12px_28px_-12px_rgba(16,18,20,0.6)]"
          }`}
        >
          {plan.cta}
        </Link>
        {plan.popular && (
          <span className="absolute -top-3 right-3 rounded-full bg-[#1fa463] px-2.5 py-1 text-[12px] font-semibold text-white shadow-[0_4px_12px_rgba(31,164,99,0.35)]">
            Most popular
          </span>
        )}
      </div>
      <p className={`mt-3 text-center text-[16px] ${muted}`}>{plan.note}</p>
      <div className="mt-7 flex items-start gap-3">
        <Check
          aria-hidden="true"
          strokeWidth={2.5}
          className={`mt-0.5 h-5 w-5 shrink-0 ${dark ? "text-[#4ade80]" : "text-[#16a34a]"}`}
        />
        <p className="text-[16px] font-medium leading-snug">{plan.includes}</p>
      </div>
      <div className="mt-3 space-y-4 pl-1">
        {plan.groups.map((group) => (
          <div key={group}>
            {plan.groups.length > 1 && (
              <p
                className={`mb-1 pl-8 text-[12px] font-semibold uppercase tracking-[0.12em] ${
                  dark ? "text-white/40" : "text-black/40"
                }`}
              >
                {GROUP_LABEL[group]}
              </p>
            )}
            <ul>
              {CHANNELS.filter((c) => c.group === group).map((c) => (
                <li key={c.id}>
                  <details className="group">
                    <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 rounded-lg [&::-webkit-details-marker]:hidden">
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-transform duration-200 group-open:rotate-45 ${
                          dark ? "border-white/20 text-white/60" : "border-black/15 text-black/45"
                        }`}
                      >
                        <Plus aria-hidden="true" strokeWidth={2.5} className="h-3 w-3" />
                      </span>
                      <ChannelIcon channel={c} dark={dark} />
                      <span className="text-[16px]">{c.name}</span>
                    </summary>
                    <p className={`pb-2 pl-[68px] text-[16px] leading-snug ${muted}`}>{c.outcome}</p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </li>
  );
}

export function GrowthPricingPlans({ startHref }: { startHref: string }) {
  const [annual, setAnnual] = useState(false);
  const toggle = (on: boolean) =>
    `h-11 cursor-pointer rounded-full px-6 text-[16px] font-medium transition-colors duration-200 ${
      on ? "bg-[#0e0f11] text-white" : "text-[#0e0f11] hover:bg-black/[0.03]"
    }`;

  return (
    <section className="w-full text-[#0e0f11]">
      <div className="relative mx-auto flex max-w-[1180px] flex-col items-center px-6 pt-36 text-center sm:pt-44 lg:px-10">
        <h1 className="max-w-[16ch] text-balance text-[clamp(2.4rem,5.4vw,4.25rem)] font-bold leading-[1.04] tracking-[-0.035em] text-[#0e0f11]">
          Get more customers, one approved change at a time.
        </h1>
        <p className="mt-5 max-w-[52ch] text-[20px] leading-relaxed text-[#595959]">
          One AI growth team for SEO, social and ads. Start free and upgrade when you&apos;re ready.
        </p>
        <Link
          href="#compare-plans"
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-full border border-black/[0.08] bg-white px-4 text-[14px] font-medium text-[#0e0f11] shadow-[0_1px_2px_rgba(16,18,20,0.05)] transition-colors duration-200 hover:bg-black/[0.02] lg:absolute lg:right-10 lg:top-44 lg:mt-0"
        >
          <LayoutGrid aria-hidden="true" className="h-4 w-4" />
          Compare
        </Link>
        <TrustRow className="mt-9" />
        <div className="relative mt-10">
          <div role="group" aria-label="Billing period" className="inline-flex rounded-full border border-black/[0.1] bg-white p-1">
            <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)} className={toggle(!annual)}>
              Monthly
            </button>
            <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)} className={toggle(annual)}>
              Annual <span className={annual ? "text-[#7ee2a8]" : "text-[#16a34a]"}>−20%</span>
            </button>
          </div>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-full top-1/2 ml-3 hidden -translate-y-1/2 items-center gap-1 sm:flex"
          >
            <svg
              viewBox="0 0 48 24"
              className="h-6 w-12 text-[#16a34a]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M46 14C34 20 18 19 5 11" />
              <path d="M11 5 4 11l8 4" />
            </svg>
            <span className={`${caveat.className} -rotate-3 whitespace-nowrap text-[22px] text-[#16a34a]`}>
              2+ months free
            </span>
          </span>
        </div>
      </div>
      <div className="mt-12 bg-[#f6f6f7] px-6 py-14 lg:px-10 lg:py-20">
        <ul className="mx-auto grid max-w-[1180px] items-start gap-5 lg:grid-cols-3">
          {PLANS.map((p) => (
            <PlanCard key={p.id} plan={p} annual={annual} startHref={startHref} />
          ))}
        </ul>
      </div>
    </section>
  );
}
