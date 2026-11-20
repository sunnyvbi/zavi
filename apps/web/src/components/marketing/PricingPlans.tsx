"use client";
/* eslint-disable @next/next/no-img-element */

import { attributionLink } from "@/lib/marketing/attributionLinks";
import { useEffect, useState } from "react";
import { withAffiliateClick } from "@/lib/analytics/affiliate";
import Link from "next/link";
import { jakarta } from "@/fonts";
import { apiFetch } from "@/lib/api";
import { trackEvent } from "@/lib/analytics/events";
import { MANAGED_IN_STORE_COPY } from "@/lib/workspace/billingSubscription";
import { clearPendingPlan } from "@/lib/workspace/pendingPlan";
import {
  PRICING_FALLBACK,
  isTierSlug,
  type BillingTerm,
  type PlanTier,
  type TierSlug,
} from "@/lib/marketing/pricing";
import { SixMonthDeal, StruckPrice } from "@/components/marketing/SixMonthDeal";
import {
  FeatureRow,
  PRICING_FEATURES,
  TierCredits,
  taglineFor,
  tierHasFeature,
} from "@/components/marketing/pricingFeatures";

const BOOK_A_CALL = "/support";

export const DEFAULT_FREE_DAILY_CREDITS = PRICING_FALLBACK.freeDailyCredits;

const POPULAR_TIER: TierSlug = "growth";

const nf = new Intl.NumberFormat("en-US");

const SIX_MONTH_UNAVAILABLE =
  "Six-month billing isn't open yet. Choose Monthly, or book an intro and we'll set it up.";

const CHECKOUT_UNAVAILABLE =
  "Checkout isn't open for this plan yet. Please try again shortly, or book an intro and we'll set it up.";

const PRICING_LOGIN = `/login?next=${encodeURIComponent("/pricing")}`;

function Check({ className = "text-[#0e0f11]", size = "size-5" }: { className?: string; size?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${size} flex-none ${className}`} fill="none" aria-hidden>
      <path d="M4.5 10.5L8.5 14.5L15.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function signedOutPlanHref(tier: TierSlug, term: BillingTerm): string {
  return tier === "free" ? "/start" : `/start?plan=${tier}&term=${term}`;
}

export function tierCtaLabel(tier: PlanTier, currentTier: TierSlug | null): string {
  if (currentTier === tier.slug) return "Current plan";
  if (tier.slug === "free") return "Start for free";
  return `Start ${tier.name}`;
}

export function TierPrice({ tier, term }: { tier: PlanTier; term: BillingTerm }) {
  const sixMonth = term === "6mo" && tier.usd > 0;
  return (
    <div className="flex flex-wrap items-baseline">
      <p className="font-bold leading-[62px] tracking-[-0.44px] text-[#1a1a18]">
        <span className="relative top-2 mr-px inline-block align-top text-[28px] leading-[34px]">$</span>
        <span className="text-[44px]">{nf.format(sixMonth ? tier.sixMonthPerMonthUsd : tier.usd)}</span>
        <span className="text-[20px] font-semibold leading-[25px]">/mo</span>
      </p>
      {sixMonth && <StruckPrice usd={tier.usd} className="ml-2.5 text-[24px] leading-[28px]" />}
    </div>
  );
}

function TermButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-h-[44px] items-center gap-2 rounded-blockLg px-4 text-[14px] leading-6 text-[#0e0f11] transition ${
        active
          ? "bg-white font-semibold shadow-[0px_1px_4px_0px_rgba(16,18,20,0.1),0px_1px_4px_0px_rgba(16,18,20,0.05)]"
          : "font-medium hover:bg-white/60"
      }`}
    >
      {children}
    </button>
  );
}

function PricingCards({
  tiers,
  signedIn,
  months,
  discountPct,
  sixMonthAvailable,
}: {
  tiers: PlanTier[];
  signedIn: boolean;
  months: number;
  discountPct: number;
  sixMonthAvailable: boolean;
}) {
  const [busy, setBusy] = useState<TierSlug | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [currentTier, setCurrentTier] = useState<TierSlug | null>(null);
  const [term, setTerm] = useState<BillingTerm>(sixMonthAvailable ? "6mo" : "monthly");
  const starterMonthly = tiers.find((t) => t.slug === "starter")?.monthlyCredits ?? 0;

  const pickTerm = (next: BillingTerm) => {
    trackEvent("pricing_term_changed", { term: next });
    setTerm(next);
    setErr(null);
  };

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/billing/credits");
        if (!res.ok) return;
        const j = (await res.json()) as { tier?: unknown };
        if (!cancelled && isTierSlug(j.tier)) setCurrentTier(j.tier);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  async function startTier(tier: TierSlug) {
    trackEvent("pricing_plan_selected", { tier, term, signed_in: signedIn, location: "pricing_page" });
    if (tier === "free") {
      clearPendingPlan();
      window.location.href = attributionLink("/start", window.location.href);
      return;
    }
    if (!signedIn) {
      window.location.href = attributionLink(signedOutPlanHref(tier, term), window.location.href);
      return;
    }
    setErr(null);
    setBusy(tier);
    try {
      const res = await apiFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withAffiliateClick({ tier, term })),
      });
      if (res.status === 401) {
        window.location.href = PRICING_LOGIN;
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        redirect?: string;
        error?: { code?: string; message?: string };
      };
      const dest = data.url || data.redirect;
      if (dest) {
        trackEvent(data.url ? "checkout_started" : "billing_portal_opened", { tier, term });
        window.location.href = dest;
        return;
      }
      const code = data.error?.code;
      if (code === "managed_in_store") {
        setErr(data.error?.message ?? MANAGED_IN_STORE_COPY);
        return;
      }
      if (term === "6mo" && (code === "price_not_configured" || code === "price_misconfigured")) {
        setErr(SIX_MONTH_UNAVAILABLE);
        return;
      }
      if (res.status === 503 || code === "billing_not_configured" || code === "price_not_configured") {
        setErr(CHECKOUT_UNAVAILABLE);
        return;
      }
      if (code === "same_plan" || code === "pending_change") {
        setErr(data.error?.message ?? "Could not change your plan.");
        return;
      }
      setErr("Could not start checkout. Please try again or book an intro.");
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="w-full px-4 md:px-6">
      <div className="mb-8 flex justify-center">
        <div
          role="group"
          aria-label="Billing period"
          className="inline-flex items-center gap-1 rounded-blockLg border border-[#f0f0f0] bg-[#f5f5f4] p-1"
        >
          <TermButton active={term === "monthly"} onClick={() => pickTerm("monthly")}>
            Monthly
          </TermButton>
          <TermButton active={term === "6mo"} onClick={() => pickTerm("6mo")}>
            {`${months} Months`}
            <span className="rounded-full bg-[#027bff] px-2 py-0.5 text-[12px] font-bold leading-4 text-white">
              {`${discountPct}% OFF`}
            </span>
          </TermButton>
        </div>
      </div>
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-stretch gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {tiers.map((t) => {
          const current = currentTier === t.slug;
          const popular = t.slug === POPULAR_TIER;
          return (
            <div
              key={t.slug}
              data-tier={t.slug}
              className={`relative flex flex-col overflow-hidden rounded-block border shadow-[0px_1px_4px_0px_rgba(16,18,20,0.1),0px_1px_4px_0px_rgba(16,18,20,0.05)] ${
                popular
                  ? "border-[#e6f2ff] bg-[linear-gradient(208.37deg,#ffffff_0.3%,#e6f2ff_99.7%)]"
                  : "bg-white"
              } ${current ? "border-[#0E9F6E] ring-2 ring-[#0E9F6E]/30" : popular ? "" : "border-[#f0f0f0]"}`}
            >
              <div className="flex flex-col gap-4 px-7 pb-3 pt-8">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2.5">
                    <h3 className="text-[20px] font-semibold leading-7 text-[#1a1a18]">{t.name}</h3>
                    {popular && (
                      <span className="rounded-full bg-[#e6f2ff] px-2 py-[2px] text-[12px] font-medium leading-4 tracking-[0.01px] text-[#027bff]">
                        Recommended
                      </span>
                    )}
                    {current && (
                      <span className="ml-auto rounded-full bg-[#0E9F6E] px-2 py-0.5 text-[12px] font-semibold text-white">
                        Your plan
                      </span>
                    )}
                  </div>
                  <p className="-mt-1.5 text-[13px] leading-5 text-[#595959]">{taglineFor(t.slug, tiers)}</p>
                  <TierPrice tier={t} term={term} />
                </div>

                {}
                {term === "6mo" && (
                  <div className="min-h-[44px]">{t.usd > 0 && <SixMonthDeal tier={t} months={months} />}</div>
                )}

                <button
                  onClick={() => startTier(t.slug)}
                  disabled={busy !== null || current}
                  className={`flex min-h-[48px] items-center justify-center rounded-full px-4 text-[16px] font-semibold leading-6 transition ${
                    current
                      ? "cursor-default border border-[#f0f0f0] bg-white text-[#8c8c8c]"
                      : popular
                        ? "bg-[#027bff] text-white hover:bg-[#0069db]"
                        : "bg-[#0e0f11] text-white hover:bg-[#26282b]"
                  } ${busy === t.slug ? "opacity-60" : ""}`}
                >
                  {busy === t.slug ? "Starting…" : tierCtaLabel(t, currentTier)}
                </button>

                <TierCredits tier={t} starterMonthly={starterMonthly} />
              </div>

              <div className="flex flex-col gap-2.5 px-4 pb-5 pt-3.5">
                <div className="h-px w-full bg-[#e8e7e4]" />
                <p className="text-[11px] font-semibold uppercase leading-none tracking-[0.6px] text-[#8a8a84]">
                  What&apos;s included
                </p>
                {PRICING_FEATURES.map((f) => (
                  <FeatureRow key={f.key} feature={f} included={tierHasFeature(t.slug, f)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {err && <p role="alert" className="mt-4 text-center text-base text-coral">{err}</p>}
      <p className="mx-auto mt-4 max-w-[1280px] px-1 text-[12px] leading-4 text-[#8a8a84]">
        * Daily credits reset each day and don&apos;t roll over.
      </p>

      {}
      <div className="mx-auto mt-6 flex max-w-[1280px] flex-wrap items-center justify-between gap-4 rounded-blockLg border border-[#f0f0f0] bg-white px-7 py-4 shadow-[0px_1px_4px_0px_rgba(16,18,20,0.1),0px_1px_4px_0px_rgba(16,18,20,0.05)]">
        <div className="flex min-w-[220px] flex-1 items-center gap-2.5">
          <p className="text-[16px] font-semibold leading-6 text-[#1a1a18]">
            Enterprise{" "}
            <span className="font-medium text-[#595959]">
              More credits, invoicing, security review and an SLA.
            </span>
          </p>
        </div>
        <a
          href={BOOK_A_CALL}
          className="flex min-h-[44px] items-center justify-center rounded-blockLg bg-[#0e0f11] px-4 text-[14px] font-semibold leading-6 text-white transition hover:bg-[#26282b]"
        >
          Contact Sales
        </a>
      </div>
    </section>
  );
}

function Hero({ freeDailyCredits, fromUsd }: { freeDailyCredits: number; fromUsd: number | null }) {
  const bullets = [
    `${nf.format(freeDailyCredits)} free credits every day.`,
    "No credit card, no sales call.",
    fromUsd ? `Paid plans from $${nf.format(fromUsd)} a month.` : "Paid credits pool monthly.",
  ];
  return (
    <section className="relative w-full overflow-hidden px-4 pb-10 pt-16 md:px-6 md:pb-16 md:pt-24">
      {}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <img src="/pricing-bg.webp" alt="" aria-hidden className="absolute inset-x-0 top-0 h-[560px] w-full select-none object-cover" />
        <div className="absolute inset-0" style={{ background: "radial-gradient(45% 40% at 12% 6%, rgba(242,153,74,0.22) 0%, rgba(242,153,74,0) 60%)" }} />
        <div className="absolute inset-0" style={{ background: "radial-gradient(46% 40% at 92% 4%, rgba(96,172,255,0.18) 0%, rgba(96,172,255,0) 62%)" }} />
        <div className="absolute inset-x-0 top-[340px] h-[260px]" style={{ background: "linear-gradient(to bottom, rgba(255,255,255,0) 0%, #ffffff 86%)" }} />
      </div>
      <div className="mx-auto flex max-w-[860px] flex-col items-center gap-6 text-center">
        <h1 className="text-[34px] font-bold leading-[1.12] tracking-[-0.03em] text-[#0b0b0f] md:text-[52px] md:leading-[72px] md:tracking-[-2px]">
          {}
          Grow your business with an agent that{" "}
          <span className="relative ml-[8px] inline-block whitespace-nowrap">
            {}
            <span
              aria-hidden
              className="absolute bottom-[2px] left-[-6px] right-[-14px] top-[2px] rounded-[15px] blur-[0.5px]"
              style={{
                backgroundImage:
                  "radial-gradient(70% 130% at 3% 6%, rgba(242,153,74,0.18) 0%, rgba(242,153,74,0) 42%), linear-gradient(100deg, #ffffff 0%, #f0f6fe 26%, #d8e9fc 50%, #aed3f8 74%, #7cbaf5 100%)",
              }}
            />
            <span className="relative pl-[12px] text-black">does the work.</span>
          </span>
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
          {bullets.map((b) => (
            <div key={b} className="flex items-center gap-2">
              {}
              <Check className="text-[#1f1f1f]" />
              <span className="text-[13px] font-medium tracking-[0.13px] text-[#1f1f1f]">{b}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CreditsAndCosts() {
  return (
    <section className="w-full px-4 py-16 md:px-6 md:py-24">
      <div className="relative mx-auto flex max-w-[1368px] flex-col overflow-hidden rounded-blockLg border border-[#f0f0f0] bg-white">
        {}
        <div className="relative grid items-center gap-8 px-8 py-10 md:grid-cols-2 md:px-16 md:py-12">
          {}
          <img
            src="/hero/zavi-hero-light-bg.webp"
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0 h-full w-full select-none object-cover"
          />
          <div className="relative z-10 flex flex-col items-start gap-6">
            <h2 className="text-[34px] font-bold leading-[1.15] tracking-[-0.44px] text-[#0e0f11] md:text-[44px] md:leading-[62px]">
              Credits power everything Zavi does
            </h2>
            <p className="max-w-[561px] text-[16px] leading-[26px] tracking-[0.16px] text-[#0e0f11]">
              Credits are the fuel behind every action Zavi takes. Buy once and they apply across ads,
              content, SEO, experiments, and reports, so your growth work keeps moving without managing
              separate budgets.
            </p>
            <Link
              href="/start?plan=free"
              className="inline-flex min-h-[48px] items-center justify-center rounded-blockLg bg-[#0e0f11] px-4 text-[16px] font-semibold text-white transition hover:bg-[#26282b]"
            >
              Get Started for free
            </Link>
          </div>

          {}
          <div className="relative z-10 flex justify-center md:justify-end">
            <img
              src="/pricing/credits-cluster.png"
              alt="Zavi connected to Slack, Gmail, Jira, Excel, Microsoft Teams, Instagram, and Booking.com"
              className="w-full max-w-[470px] select-none"
            />
          </div>
        </div>

        {}
        <div className="px-8 md:px-16">
          <div className="mx-auto max-w-[1240px] divide-y divide-[#eeeeee]">
            {COST_ROWS.map((row) => (
              <div
                key={row.title}
                className="flex flex-col gap-8 py-11 lg:flex-row lg:items-center lg:justify-between lg:gap-12"
              >
                {}
                <div className="flex flex-1 flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <h3 className="text-[20px] font-semibold leading-7 tracking-[-0.2px] text-[#1a182b]">{row.title}</h3>
                    <p className="text-[16px] leading-5 text-[#9e9e9e]">Credits consumed per operation</p>
                  </div>
                  <p className="text-[44px] font-bold leading-none tracking-[-0.5px] text-[#1a182b]">
                    {row.range} <span className="text-[20px] font-medium text-[#595959]">Credits</span>
                  </p>
                </div>

                {}
                <div className="w-full lg:flex lg:w-[480px] lg:justify-end">
                  {row.variant === "stack" ? (
                    <div className="flex w-full flex-col lg:max-w-[440px]">
                      <div className="-rotate-2">
                        <div className="rounded-[12px] border border-[#e5e7eb] bg-white p-3">
                          <ChatBubble m={row.chat[0]} />
                        </div>
                      </div>
                      <div className="-mt-3 rotate-2">
                        <div className="rounded-[12px] border border-[#e5e7eb] bg-white p-3">
                          <ChatBubble m={row.chat[1]} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="w-full rounded-[16px] border border-[#e5e7eb] bg-white p-4 lg:max-w-[440px]">
                      <div className="flex flex-col gap-4">
                        {row.chat.map((m, i) => (
                          <ChatBubble key={i} m={m} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

type ChatMsg = { who: string; time: string; text: string; agent?: boolean; avatar?: string };
type CostRow = { title: string; range: string; chat: ChatMsg[]; variant: "card" | "stack" };

const COST_ROWS: CostRow[] = [
  {
    title: "Draft Texts",
    range: "100–300",
    variant: "card",
    chat: [
      { who: "Sarah", time: "9:14 AM", avatar: "/marketing/sarah-jenkins.png", text: "summarize yesterday's #zavi-updates thread and flag anything I need to follow up on" },
      { who: "Zavi", time: "9:15 AM", agent: true, text: "3 Zavi deals reviewed. Two on track: Enterprise closes Friday, Growth plan signed. One needs you: DataSync integration went silent." },
    ],
  },
  {
    title: "Generate Variations",
    range: "100–300",
    variant: "stack",
    chat: [
      { who: "Kavin", time: "11:32 AM", avatar: "/pricing/kavin.png", text: "Can you write three new headlines for our signup page?" },
      { who: "Zavi", time: "11:38 AM", agent: true, text: "Done ✅ Three headline variants are ready to test on the signup page." },
    ],
  },
  {
    title: "Prototypes",
    range: "2,000–5,000",
    variant: "card",
    chat: [
      { who: "Sarah", time: "2:05 PM", avatar: "/marketing/sarah-jenkins.png", text: "Build a landing page for our new pilates class pack with a signup form" },
      { who: "Zavi", time: "2:19 PM", agent: true, text: "Done ✅ The page is live with a signup form. Want me to write two headline variants to test?" },
    ],
  },
];

function ZaviChip({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex size-[26px] flex-none items-center justify-center overflow-hidden rounded-[8px] border border-[#f0f0f0] bg-white ${className}`}
      aria-hidden
    >
      <img src="/zavi-icon.svg" alt="" className="size-full object-contain" />
    </span>
  );
}

function ChatBubble({ m }: { m: ChatMsg }) {
  return (
    <div className="flex gap-2">
      {m.agent ? (
        <ZaviChip className="mt-0.5" />
      ) : (
        <img src={m.avatar} alt="" aria-hidden className="mt-0.5 size-8 flex-none rounded-[10px] object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-[#1a182b]">{m.who}</span>
          <span className="text-[11px] text-[#716f7e]">{m.time}</span>
        </div>
        <p className="mt-1 rounded-[12px] bg-[#f9f9f9] px-2.5 py-2 text-[13px] leading-[1.4] text-[#1a182b]">{m.text}</p>
      </div>
    </div>
  );
}

const HOW_CARDS = [
  { icon: "grid", title: "Pay for the work Zavi does", body: "Every credit reflects the model work done across Anthropic, OpenAI, and others. No per-seat licenses, no minimums, no surprise platform tiers as you scale." },
  { icon: "zap", title: "Smart caching cuts your bill", body: "Zavi caches context and reuses results across tasks. Repeated workflows cost fewer credits than calling the models fresh every time." },
  { icon: "settings", title: "Automations scale with frequency", body: "Scheduled automations run on credits too. Frequency matters." },
];

function HowIcon({ name }: { name: string }) {
  const common = { className: "size-5", viewBox: "0 0 20 20", fill: "none", stroke: "#141B34", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "zap")
    return (
      <svg {...common}>
        <path d="M2.88826 11.5392C3.02181 11.6231 3.1764 11.6673 3.33408 11.6668H9.16676C9.30154 11.6663 9.43442 11.6986 9.55399 11.7608C9.67356 11.823 9.77626 11.9133 9.85327 12.0239C9.93029 12.1346 9.97933 12.2622 9.99618 12.396C10.013 12.5297 9.99718 12.6656 9.95001 12.7918L8.35019 17.8088C8.32512 17.8999 8.33178 17.9969 8.36907 18.0837C8.40636 18.1706 8.47206 18.2422 8.55539 18.2867C8.63872 18.3313 8.73472 18.3462 8.82765 18.3291C8.92057 18.3119 9.00489 18.2636 9.06677 18.1922L17.3158 9.69165C17.4152 9.56918 17.4777 9.42102 17.4962 9.26441C17.5147 9.10779 17.4884 8.94914 17.4204 8.80688C17.3523 8.66462 17.2453 8.5446 17.1117 8.46076C16.9782 8.37692 16.8236 8.3327 16.6659 8.33323H10.8332C10.6985 8.33367 10.5656 8.3014 10.446 8.2392C10.3264 8.17699 10.2237 8.0867 10.1467 7.97607C10.0697 7.86544 10.0207 7.73778 10.0038 7.60403C9.98698 7.47028 10.0028 7.33444 10.05 7.20817L11.6498 2.1912C11.6749 2.10007 11.6682 2.00312 11.6309 1.91628C11.5936 1.82943 11.5279 1.75784 11.4446 1.71326C11.3613 1.66868 11.2653 1.65376 11.1724 1.67095C11.0794 1.68814 10.9951 1.73641 10.9332 1.80785L2.68415 10.3084C2.58482 10.4308 2.52226 10.579 2.50376 10.7356C2.48525 10.8922 2.51156 11.0509 2.57962 11.1931C2.64769 11.3354 2.75471 11.4554 2.88826 11.5392Z" />
      </svg>
    );
  if (name === "settings")
    return (
      <svg {...common}>
        <path d="M8.05796 3.44907C8.10387 2.96602 8.32823 2.51744 8.68721 2.19097C9.04618 1.8645 9.51398 1.68359 9.9992 1.68359C10.4844 1.68359 10.9522 1.8645 11.3112 2.19097C11.6702 2.51744 11.8945 2.96602 11.9405 3.44907C11.9681 3.76112 12.0704 4.06192 12.2389 4.32602C12.4074 4.59012 12.637 4.80975 12.9083 4.9663C13.1797 5.12286 13.4847 5.21174 13.7977 5.22542C14.1107 5.2391 14.4223 5.17718 14.7063 5.0449C15.1472 4.84472 15.6469 4.81575 16.108 4.96364C16.5691 5.11153 16.9586 5.4257 17.2009 5.84499C17.4431 6.26429 17.5207 6.75871 17.4185 7.23205C17.3163 7.70538 17.0416 8.12375 16.648 8.40574C16.3916 8.58561 16.1823 8.82458 16.0379 9.10243C15.8934 9.38027 15.818 9.68883 15.818 10.002C15.818 10.3151 15.8934 10.6237 16.0379 10.9016C16.1823 11.1794 16.3916 11.4184 16.648 11.5982C17.0416 11.8802 17.3163 12.2986 17.4185 12.7719C17.5207 13.2453 17.4431 13.7397 17.2009 14.159C16.9586 14.5783 16.5691 14.8924 16.108 15.0403C15.6469 15.1882 15.1472 15.1593 14.7063 14.9591C14.4223 14.8268 14.1107 14.7649 13.7977 14.7786C13.4847 14.7922 13.1797 14.8811 12.9083 15.0377C12.637 15.1942 12.4074 15.4139 12.2389 15.678C12.0704 15.9421 11.9681 16.2429 11.9405 16.5549C11.8945 17.038 11.6702 17.4865 11.3112 17.813C10.9522 18.1395 10.4844 18.3204 9.9992 18.3204C9.51398 18.3204 9.04618 18.1395 8.68721 17.813C8.32823 17.4865 8.10387 17.038 8.05796 16.5549C8.03041 16.2427 7.92804 15.9418 7.75951 15.6776C7.59098 15.4134 7.36127 15.1937 7.08982 15.0372C6.81837 14.8806 6.51318 14.7918 6.2001 14.7782C5.88703 14.7646 5.57529 14.8266 5.29129 14.9591C4.85036 15.1593 4.35073 15.1882 3.88962 15.0403C3.42852 14.8924 3.03893 14.5783 2.79669 14.159C2.55445 13.7397 2.47688 13.2453 2.57909 12.7719C2.68129 12.2986 2.95596 11.8802 3.34962 11.5982C3.60597 11.4184 3.81523 11.1794 3.9597 10.9016C4.10416 10.6237 4.17958 10.3151 4.17958 10.002C4.17958 9.68883 4.10416 9.38027 3.9597 9.10243C3.81523 8.82458 3.60597 8.58561 3.34962 8.40574C2.95651 8.12361 2.68233 7.7054 2.58037 7.23239C2.47842 6.75938 2.55596 6.26535 2.79794 5.84633C3.03992 5.42731 3.42905 5.11322 3.8897 4.96511C4.35035 4.81699 4.84961 4.84543 5.29046 5.0449C5.57442 5.17718 5.88607 5.2391 6.19904 5.22542C6.512 5.21174 6.81707 5.12286 7.0884 4.9663C7.35974 4.80975 7.58937 4.59012 7.75784 4.32602C7.92632 4.06192 8.02869 3.76112 8.05629 3.44907M12.4985 10.0023C12.4985 11.383 11.3792 12.5023 9.99853 12.5023C8.61782 12.5023 7.49854 11.383 7.49854 10.0023C7.49854 8.62157 8.61782 7.50228 9.99853 7.50228C11.3792 7.50228 12.4985 8.62157 12.4985 10.0023Z" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M2.5 7.5H17.5M2.5 12.5H17.5M7.5 2.5V17.5M12.5 2.5V17.5M4.16667 2.5H15.8333C16.7538 2.5 17.5 3.24619 17.5 4.16667V15.8333C17.5 16.7538 16.7538 17.5 15.8333 17.5H4.16667C3.24619 17.5 2.5 16.7538 2.5 15.8333V4.16667C2.5 3.24619 3.24619 2.5 4.16667 2.5Z" />
    </svg>
  );
}

function HowCreditsWork() {
  return (
    <section className="w-full px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto grid max-w-[1280px] gap-12 rounded-[33px] bg-[#f9f9f9] px-8 py-16 md:grid-cols-[480px_1fr] md:px-20 md:py-24">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-6">
            <h2 className="text-[34px] font-bold leading-[1.15] tracking-[-0.44px] text-[#0e0f11] md:text-[44px]">How credits work</h2>
            <p className="text-[16px] leading-6 tracking-[0.16px] text-[#94949e]">
              Credits map to real model usage.<br />Smart caching brings them down.
            </p>
          </div>
          {}
          <div
            className="relative overflow-hidden rounded-blockLg p-10"
            style={{
              background:
                "radial-gradient(72% 80% at 88% 52%, #a2d8ff 0%, #bce3fe 22%, #d8edfe 42%, #edf3f3 60%, #fbf3ea 86%, #fdf3ea 100%)",
            }}
          >
            <p className="max-w-[420px] text-[24px] font-bold leading-[34px] text-[#0e0f11]">
              Your whole team gets an analyst, an ops lead, and an engineer. For the price of lunch.
            </p>
            <Link
              href="/start?plan=free"
              className="mt-8 inline-flex min-h-[48px] items-center justify-center rounded-[12px] bg-[#0e0f11] px-4 text-[16px] font-semibold text-white transition hover:bg-[#26282b]"
            >
              Get Started for Free
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {HOW_CARDS.map((c) => (
            <div key={c.title} className="flex flex-col gap-6 rounded-[16px] border border-white bg-white p-8 shadow-[0px_1px_2px_0px_rgba(14,15,17,0.05)]">
              {}
              <span
                className="flex size-10 items-center justify-center overflow-hidden rounded-[8px]"
                style={{ background: "linear-gradient(135deg, #fcf5f1 0%, #f6f5f3 46%, #e6f1f9 100%)" }}
              >
                <HowIcon name={c.icon} />
              </span>
              <div className="flex flex-col gap-2">
                <p className="text-[16px] font-semibold leading-6 text-[#0e0f11]">{c.title}</p>
                <p className="text-[16px] leading-5 text-[#595959]">{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="w-full px-4 pb-20 md:px-6">
      <div className="relative mx-auto flex max-w-[1176px] flex-col items-center gap-6 overflow-hidden rounded-blockLg bg-[#cfe1e2] px-8 py-16 text-center md:py-[72px]">
        {}
        <img
          src="/marketing/cta-swoosh.svg"
          alt=""
          aria-hidden
          className="pointer-events-none absolute left-[8%] top-[-58%] h-[170%] w-[96%] select-none"
        />
        <h2 className="relative max-w-[760px] text-[32px] font-bold leading-[1.25] tracking-[-0.5px] text-[#0e0f11] md:text-[40px] md:leading-[58px]">
          Build it, or grow it.
          <br />
          Either way, Zavi does the work.
        </h2>
        <p className="relative max-w-[540px] text-[16px] leading-6 tracking-[0.01px] text-[#595959]">
          Pick your door. You stay in control the whole way. The data, the customers, and the brand
          are always yours.
        </p>
        <Link
          href="/start?plan=free"
          className="relative mt-2 inline-flex min-h-[48px] items-center justify-center rounded-blockLg bg-[#0e0f11] px-6 text-[16px] font-semibold text-white transition hover:bg-[#26282b]"
        >
          Get started for free
        </Link>
      </div>
    </section>
  );
}

export function PricingPlans({
  tiers = PRICING_FALLBACK.tiers,
  freeDailyCredits = DEFAULT_FREE_DAILY_CREDITS,
  signedIn = false,
  sixMonthAvailable = true,
  sixMonthMonths = PRICING_FALLBACK.sixMonthMonths,
  sixMonthDiscountPct = PRICING_FALLBACK.sixMonthDiscountPct,
}: {
  tiers?: PlanTier[];
  freeDailyCredits?: number;
  signedIn?: boolean;
  sixMonthAvailable?: boolean;
  sixMonthMonths?: number;
  sixMonthDiscountPct?: number;
} = {}) {
  return (
    <div className={`${jakarta.variable} overflow-x-clip font-[family-name:var(--font-jakarta)]`}>
      <Hero
        freeDailyCredits={freeDailyCredits}
        fromUsd={tiers.filter((t) => t.usd > 0).reduce<number | null>((m, t) => (m === null || t.usd < m ? t.usd : m), null)}
      />
      <PricingCards
        tiers={tiers}
        signedIn={signedIn}
        months={sixMonthMonths}
        discountPct={sixMonthDiscountPct}
        sixMonthAvailable={sixMonthAvailable}
      />
      <CreditsAndCosts />
      <HowCreditsWork />
      <CtaBand />
    </div>
  );
}
