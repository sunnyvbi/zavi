"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Minus, Plus } from "lucide-react";
import { businessTotal, creatorGets, FEES, money } from "./fees";
import { CREATOR_JOIN_HREF } from "./shared";

const MIN = 50;
const MAX = 1000;

const FAQS = [
  {
    q: "Do I need a lot of followers?",
    a: "No. There is no follower minimum. If you add audience numbers to your profile, they are self-reported and labelled that way, so businesses know Zavi has not checked them.",
  },
  {
    q: "How much does Zavi take?",
    a: `${FEES.creatorPct}% of your price, taken from what you receive. The business pays ${FEES.businessPct}% on top. On a ${money(150)} package you receive ${money(creatorGets(150))} and the business pays ${money(businessTotal(150))}.`,
  },
  {
    q: "When do I get paid?",
    a: "Your payout is released when the business approves your work. If they do not answer within 72 hours, the work is approved for them and paid after a 10 day hold. Payouts go through Stripe to the account you set up at your first job.",
  },
  {
    q: "Who posts the video?",
    a: "The business. You sell UGC video: you send the files, and the business posts them and can run them as ads for the ad rights in your package.",
  },
  {
    q: "Which countries can I be paid in?",
    a: "The US, Canada, the UK, the EEA and Switzerland, through Stripe.",
  },
];

const STEP_BTN =
  "flex size-12 cursor-pointer items-center justify-center rounded-full border border-white/20 text-white transition-colors duration-200 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

function Calculator() {
  const [price, setPrice] = useState(150);
  const [count, setCount] = useState(4);
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n) || MIN));

  return (
    <div className="rounded-block border border-white/10 bg-white/[0.05] p-4 text-left sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="calc-price" className="text-[14px] font-semibold text-white">
          Your price per job
        </label>
        <div className="flex items-center rounded-xl border border-white/20 px-3">
          <span className="text-[16px] text-white/70">$</span>
          <input
            aria-label="Price per job in dollars"
            type="number"
            inputMode="numeric"
            min={MIN}
            max={MAX}
            value={draft ?? price}
            onChange={(e) => {
              setDraft(e.target.value);
              const n = Number(e.target.value);
              if (n >= MIN && n <= MAX) setPrice(Math.round(n));
            }}
            onBlur={() => {
              if (draft !== null) setPrice(clamp(Number(draft)));
              setDraft(null);
            }}
            className="h-11 w-20 bg-transparent pl-1 text-[16px] font-semibold text-white tabular-nums outline-none"
          />
        </div>
      </div>
      <input
        id="calc-price"
        type="range"
        min={MIN}
        max={MAX}
        step={10}
        value={price}
        onChange={(e) => {
          setDraft(null);
          setPrice(clamp(Number(e.target.value)));
        }}
        className="mt-4 h-2 w-full cursor-pointer accent-white"
      />
      <div className="mt-1.5 flex justify-between text-[14px] text-white/70 tabular-nums">
        <span>{money(MIN)}</span>
        <span>{money(MAX)}</span>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <span id="calc-count-label" className="text-[14px] font-semibold text-white">
          Jobs per month
        </span>
        <div role="group" aria-labelledby="calc-count-label" className="flex items-center gap-2">
          <button type="button" aria-label="One fewer job" onClick={() => setCount((c) => Math.max(1, c - 1))} className={STEP_BTN}>
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <span className="w-8 text-center text-[20px] font-bold text-white tabular-nums" aria-live="polite">
            {count}
          </span>
          <button type="button" aria-label="One more job" onClick={() => setCount((c) => Math.min(30, c + 1))} className={STEP_BTN}>
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-[18px] bg-white p-4 text-[#0e0f11]">
          <p className="text-[14px] font-medium text-[#595959]">You receive</p>
          <p className="mt-1 text-[34px] leading-tight font-extrabold tracking-[-0.02em] tabular-nums">{money(creatorGets(price * count))}</p>
          <p className="mt-1 text-[14px] text-[#595959]">
            {money(creatorGets(price))} a job, {count} {count === 1 ? "job" : "jobs"}
          </p>
        </div>
        <div className="rounded-[18px] bg-white/[0.08] p-4">
          <p className="text-[14px] font-medium text-white/75">The business pays</p>
          <p className="mt-1 text-[34px] leading-tight font-extrabold tracking-[-0.02em] text-white tabular-nums">{money(businessTotal(price))}</p>
          <p className="mt-1 text-[14px] text-white/75">a job, your price plus {FEES.businessPct}%</p>
        </div>
      </div>
      <p className="mt-4 text-[14px] leading-relaxed text-white/70">
        Fee rule: Zavi takes {FEES.creatorPct}% of your price from what you receive, and the business pays {FEES.businessPct}% on top. This is the math on
        your own numbers, not a promise of bookings.
      </p>
    </div>
  );
}

export function ClosingPanel({ creatorArea = null }: { creatorArea?: { href: string; label: string } | null }) {
  return (
    <section data-creator-close className="w-full bg-white pt-4 pb-12 lg:pb-16">
      <div className="mx-auto w-full max-w-[1180px] px-3 sm:px-6">
        <div className="relative isolate overflow-hidden rounded-blockLg bg-[#0e0f11] px-4 py-12 text-white sm:px-10 lg:px-14 lg:py-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[420px] w-[760px] max-w-[160%] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(2,123,255,0.38),transparent)] blur-2xl"
          />

          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
            <div className="text-center lg:text-left">
              <h2 className="text-[clamp(1.9rem,4vw,3rem)] leading-[1.08] font-extrabold tracking-[-0.03em]">Set your price. See what you keep.</h2>
              <p className="mx-auto mt-5 max-w-[44ch] text-[16px] leading-relaxed text-white/70 lg:mx-0">
                Try your own numbers, then set up your first package. It takes a few minutes.
              </p>
              <div className="mt-8 flex flex-col items-center gap-3 lg:items-start">
                <Link
                  href={creatorArea ? creatorArea.href : CREATOR_JOIN_HREF}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-white px-6 text-[16px] font-semibold text-[#0e0f11] transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:w-auto"
                >
                  {creatorArea ? creatorArea.label : "Join as a creator"} <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
                {creatorArea ? null : <p className="text-[14px] text-white/70">Free to join. No bank details until your first job.</p>}
              </div>
            </div>
            <Calculator />
          </div>

          <div id="faq" className="mt-12 grid scroll-mt-28 gap-6 border-t border-white/10 pt-10 lg:grid-cols-[280px_1fr] lg:gap-14">
            <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] leading-[1.15] font-bold tracking-[-0.02em]">Questions creators ask</h2>
            <div className="divide-y divide-white/10 border-y border-white/10">
              {FAQS.map((f) => (
                <details key={f.q} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-4 text-left text-[16px] font-semibold text-white marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:text-[20px] [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <Plus className="h-5 w-5 shrink-0 text-white/60 transition-transform duration-200 group-open:rotate-45" aria-hidden="true" />
                  </summary>
                  <p className="max-w-[70ch] pb-5 text-[14px] leading-relaxed text-white/70">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
