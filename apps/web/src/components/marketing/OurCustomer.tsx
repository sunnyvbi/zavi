/* eslint-disable @next/next/no-img-element */

"use client";

import { useCallback, useEffect, useState } from "react";
import { jakarta } from "@/fonts";

type Testimonial = {
  name: string;
  title: string;
  quote: string;
  hours: string;
};

const TESTIMONIALS: Testimonial[] = [
  {
    name: "Sarah Chen",
    title: "Creative Director, Nova Studio",
    quote:
      "Zavi feels like having a creative strategist, project manager, and AI assistant working alongside our team. We spend less time organizing work and more time creating.",
    hours: "4-6 hrs/week",
  },
  {
    name: "Michael Ross",
    title: "Founder, Growth Labs",
    quote:
      "What impressed us most isn't the AI itself. It's how naturally Zavi fits into our workflow, turning scattered ideas into structured projects and clear next steps.",
    hours: "4-6 hours/week",
  },
  {
    name: "Emma Parker",
    title: "Head of Product, Lumina Labs",
    quote:
      "Zavi has become our creative operating system. Ideas, briefs, and execution all happen in one place, helping our team move faster without sacrificing quality.",
    hours: "4-6 hrs/week",
  },
];

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 21.5 21.5"
      fill="none"
      aria-hidden
    >
      <path
        d="M10.75 0C16.6871 0 21.5 4.81294 21.5 10.75C21.5 16.6871 16.6871 21.5 10.75 21.5C4.81294 21.5 0 16.6871 0 10.75C0 4.81294 4.81294 0 10.75 0ZM10.75 5.75C10.1977 5.75 9.75 6.19772 9.75 6.75V10.75C9.75 11.0152 9.85543 11.2695 10.043 11.457L12.043 13.457C12.4335 13.8476 13.0665 13.8476 13.457 13.457C13.8476 13.0665 13.8476 12.4335 13.457 12.043L11.75 10.3359V6.75C11.75 6.19772 11.3023 5.75 10.75 5.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 12 18"
      fill="none"
      aria-hidden
    >
      <path
        d="M6 0C5.55685 0 5.16195 0.194847 4.89061 0.358424C4.59179 0.538562 4.28923 0.776998 4.00078 1.03187C3.4216 1.54362 2.80434 2.20689 2.25084 2.84439C1.69303 3.48686 1.18002 4.1264 0.80767 4.60352C0.62291 4.84028 0.306928 5.25863 0.197877 5.40301L0.194868 5.40699C-0.13264 5.85169 -0.037638 6.47769 0.40706 6.8052C0.851734 7.13269 1.47768 7.03771 1.80521 6.59308C1.90576 6.45995 2.20515 6.06363 2.38438 5.83397C2.74365 5.3736 3.23357 4.76313 3.76105 4.1556C4.17654 3.67706 4.60337 3.21424 5 2.83165L5 17C5 17.5523 5.44771 18 6 18C6.55228 18 7 17.5523 7 17L7 2.83165C7.39663 3.21424 7.82346 3.67706 8.23895 4.1556C8.76643 4.76313 9.25635 5.3736 9.61563 5.83397C9.79485 6.06363 10.0942 6.45995 10.1948 6.59308C10.5223 7.03772 11.1483 7.13269 11.5929 6.8052C12.0376 6.47769 12.1326 5.85169 11.8051 5.40699L11.8023 5.40328C11.6933 5.2589 11.3771 4.84028 11.1923 4.60353C10.82 4.1264 10.307 3.48686 9.74916 2.84439C9.19566 2.20689 8.5784 1.54362 7.99922 1.03187C7.71077 0.776998 7.40821 0.538562 7.1094 0.358425C6.83805 0.194843 6.44317 0 6 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <rect width="24" height="24" rx="6" fill="#1F1F1F" />
      <path
        d="M8.34 9.6H6.2V17.4H8.34V9.6ZM7.27 6.6C6.57 6.6 6 7.17 6 7.87C6 8.57 6.57 9.15 7.27 9.15C7.97 9.15 8.54 8.57 8.54 7.87C8.54 7.17 7.97 6.6 7.27 6.6ZM18 13.06C18 11.02 17.56 9.45 15.18 9.45C14.03 9.45 13.26 10.08 12.95 10.68H12.92V9.6H10.87V17.4H13.01V13.54C13.01 12.52 13.2 11.54 14.46 11.54C15.7 11.54 15.72 12.7 15.72 13.6V17.4H18V13.06Z"
        fill="white"
      />
    </svg>
  );
}

function TestimonialCard({ t, active }: { t: Testimonial; active: boolean }) {
  const highlight = active;
  return (
    <div
      className={`flex w-full min-w-0 max-w-[372px] shrink-0 grow basis-0 flex-col justify-center gap-6 rounded-[20px] border border-[#f0f0f0] p-6 transition-colors ${
        highlight ? "bg-[#f9f9f9]" : "bg-white/10"
      }`}
    >
      {}
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center overflow-hidden rounded-blockLg p-1">
            <div className="size-10 overflow-hidden rounded-blockLg border border-[#f0f0f0]">
              <img
                src="/customers/avatar.png"
                alt=""
                aria-hidden
                className="size-full object-cover"
              />
            </div>
          </div>
          <div className="flex flex-col justify-center whitespace-nowrap">
            <p className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
              {t.name}
            </p>
            <p className="text-[16px] font-medium leading-5 tracking-[0.14px] text-[#595959]">
              {t.title}
            </p>
          </div>
        </div>
        <LinkedInIcon className="shrink-0" />
      </div>

      {}
      <p className="text-[16px] font-semibold leading-6 text-[#595959]">
        {`“${t.quote}”`}
      </p>

      {}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <ClockIcon
            className={highlight ? "text-[#027bff]" : "text-[#595959]"}
          />
          <p
            className={`text-[16px] font-semibold leading-6 ${
              highlight ? "text-[#027bff]" : "text-[#595959]"
            }`}
          >
            Saved
          </p>
        </div>
        <div
          className={`flex items-center rounded-blockLg px-3 py-1 ${
            highlight
              ? "bg-[#f0f7ff] text-[#0071f2]"
              : "border border-[#f0f0f0] text-[#595959]"
          }`}
        >
          <p className="text-center text-[16px] font-medium leading-6">
            {t.hours}
          </p>
        </div>
      </div>
    </div>
  );
}

function visibleForWidth(w: number) {
  if (w < 640) return 1;
  if (w < 1024) return 2;
  return 3;
}

export default function OurCustomer({
  heading = "What our customers say.",
  leadTestimonial,
}: {
  heading?: string;
  leadTestimonial?: { name: string; title: string; quote: string };
} = {}) {
  const cards: Testimonial[] = leadTestimonial
    ? [{ ...leadTestimonial, hours: "4-6 hrs/week" }, ...TESTIMONIALS]
    : TESTIMONIALS;

  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(3);

  useEffect(() => {
    const update = () =>
      setVisible(Math.min(visibleForWidth(window.innerWidth), cards.length));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [cards.length]);

  const go = useCallback(
    (dir: -1 | 1) => {
      setIndex((i) => (i + dir + cards.length) % cards.length);
    },
    [cards.length],
  );

  const half = Math.floor(visible / 2);
  const visibleCards = Array.from({ length: visible }, (_, slot) => {
    const offset = slot - half;
    const i = (index + offset + cards.length) % cards.length;
    return { card: cards[i], slot, isActive: offset === 0 };
  });

  return (
    <section className={`${jakarta.variable} bg-white px-3 py-6 md:px-4 md:py-10`}>
      <div className="relative mx-auto max-w-[1240px] overflow-hidden rounded-blockLg border border-[#f0f0f0] bg-[#cfe6ea] px-4 py-12 sm:px-6 md:px-10 md:py-20 font-[family-name:var(--font-jakarta)]">
        {}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-[280px] -top-[180px] h-[900px] w-[760px] rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.7)_0%,rgba(255,255,255,0)_60%)]"
        />

        <div className="relative flex flex-col items-center gap-10 md:gap-[60px]">
          <h2 className="text-center text-[28px] font-semibold leading-[1.1] tracking-tight text-[#0e0f11] md:text-[40px] md:leading-10">
            {heading}
          </h2>

          {}
          <div
            className="flex w-full items-stretch justify-center gap-6 overflow-hidden"
            style={{ maxWidth: visible * 372 + (visible - 1) * 24 }}
          >
            {visibleCards.map(({ card, slot, isActive }) => (
              <TestimonialCard key={slot} t={card} active={isActive} />
            ))}
          </div>

          {}
          <div className="flex items-start gap-5">
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="Previous testimonial"
              className="flex items-center justify-center rounded-block border border-[#f0f0f0] bg-white p-2 text-[#1f1f1f] transition-colors hover:bg-[#f5f5f5]"
            >
              <ArrowIcon className="-rotate-90" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="Next testimonial"
              className="flex items-center justify-center rounded-block border border-[#f0f0f0] bg-white p-2 text-[#1f1f1f] transition-colors hover:bg-[#f5f5f5]"
            >
              <ArrowIcon className="rotate-90" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
