"use client";

/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

const POSTER = "/marketing/growth-home/founder-poster.webp";
const VIDEO_SRC = "https://media.zaviagent.com/marketing/growth-home/founder-launch.mp4";

export function GrowthFounderVideo({ startHref }: { startHref: string }) {
  const [playing, setPlaying] = useState(false);

  return (
    <section className="w-full py-14 text-[#0e0f11] lg:py-20">
      <div className="mx-auto w-full max-w-[1280px] px-6 lg:px-10">
        <div className="mx-auto max-w-[760px] text-center">
          <h2 className="text-[clamp(2rem,4.6vw,42px)] font-bold leading-[1.12] tracking-[-0.02em] text-[#0e0f11]">
            Watch Zavi grow a real business.
          </h2>
          <p className="mx-auto mt-5 max-w-[60ch] text-[16px] leading-relaxed text-[#595959]">
            See how Zavi finds what&apos;s holding you back, makes a plan, and
            puts that plan to work.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-[1040px] lg:mt-16">
          <div className="relative aspect-[1600/868] overflow-hidden rounded-block border border-black/[0.08] bg-white shadow-[0_32px_80px_-28px_rgba(16,18,20,0.35)]">
            {playing ? (
              <video
                src={VIDEO_SRC}
                poster={POSTER}
                autoPlay
                controls
                playsInline
                preload="auto"
                className="absolute inset-0 h-full w-full bg-black object-cover"
              />
            ) : (
              <>
                <img
                  src={POSTER}
                  alt="What keeps moving after you log off?"
                  width={1600}
                  height={868}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <button
                  type="button"
                  aria-label="Play: Why we built Zavi"
                  onClick={() => setPlaying(true)}
                  className="group absolute inset-0 transition-colors duration-200 hover:bg-[#0e0f11]/10"
                >
                  {}
                  <span className="absolute left-[64%] top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[#0e0f11] shadow-[0_12px_40px_rgba(16,18,20,0.35)] transition-transform duration-200 group-hover:scale-105">
                    {}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="ml-1 h-8 w-8"
                    >
                      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
                    </svg>
                  </span>
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={startHref}
            prefetch={false}
            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[16px] font-semibold text-white transition-opacity duration-200 hover:opacity-90"
          >
            Try it on your business
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
