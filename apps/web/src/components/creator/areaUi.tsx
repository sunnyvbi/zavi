"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { RING } from "./ui";

export * from "./ui";

export const PULSE = "animate-pulse bg-[#e7e9ee] motion-reduce:animate-none";
export function Bone({ className }: { className: string }) {
  return <span aria-hidden="true" className={`${PULSE} block ${className}`} />;
}

export function CardSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="rounded-block border border-black/[0.06] bg-white p-6">
        <Bone className="h-6 w-32 rounded-full" />
        <Bone className="mt-4 h-5 w-2/3 rounded-full" />
        <Bone className="mt-3 h-4 w-full rounded-full" />
        <Bone className="mt-2 h-4 w-1/2 rounded-full" />
      </div>
    </div>
  );
}

export function RowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <ul aria-hidden="true" className="divide-y divide-black/[0.06] rounded-block border border-black/[0.06] bg-white p-2">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-3.5">
            <Bone className="size-5 shrink-0 rounded-md" />
            <span className="min-w-0 flex-1">
              <Bone className="h-4 w-1/3 rounded-full" />
              <Bone className="mt-2 h-3 w-2/3 rounded-full" />
            </span>
            <Bone className="h-8 w-16 shrink-0 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export const BTN_PRIMARY = `${RING} inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[14px] font-semibold text-white transition-[opacity,transform] duration-200 hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`;

export const BTN_SECONDARY = `${RING} inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-full border border-black/[0.08] bg-white px-6 text-[14px] font-semibold text-[#0e0f11] shadow-[0_1px_2px_rgba(16,18,20,0.04)] transition-all hover:bg-[#0e0f11]/[0.04] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40`;

export const BTN_SMALL = `${RING} inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-full border border-black/[0.08] bg-white px-3.5 text-[13px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#0e0f11]/[0.04] disabled:cursor-not-allowed disabled:opacity-40`;

export function CreatorFrame({
  right,
  nav,
  avatar,
  full = false,
  children,
  wide,
}: {
  right?: ReactNode;
  nav?: ReactNode;
  avatar?: ReactNode;
  full?: boolean;
  children: ReactNode;
  wide?: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const EASE = "transition-all duration-300 ease-out";
  const barHeight = scrolled ? "h-[52px]" : "h-14 sm:h-[60px]";

  if (nav) {
    return (
      <div className="relative isolate min-h-screen overflow-x-clip bg-white font-sans text-foreground antialiased lg:bg-[#f2f2f5]">
        {}
        <aside aria-label="Creator area menu" className="fixed inset-y-0 left-0 z-40 hidden w-[96px] flex-col items-center overflow-y-auto pt-5 pb-6 lg:flex">
          <Link href={CREATOR_MARKETPLACE_ENABLED ? "/creators" : "/creator"} aria-label={CREATOR_MARKETPLACE_ENABLED ? "Zavi for creators" : "Creator home"} className={`${RING} flex size-12 items-center justify-center rounded-2xl bg-[#0e0f11]`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/zavi-white.svg" alt="" className="w-[62%]" />
          </Link>
          {avatar ? <div className="mt-7">{avatar}</div> : null}
          <div className="mt-8 w-full">{nav}</div>
        </aside>
        {}
        <div className="lg:hidden">
          <header className="fixed inset-x-0 top-0 z-50 px-3 sm:px-4">
            <div className="mx-auto mt-3 max-w-[1180px]">
              <div className="liquid-glass flex h-14 items-center justify-between gap-4 rounded-full border px-3 sm:px-4">
                <Link href={CREATOR_MARKETPLACE_ENABLED ? "/creators" : "/creator"} className={`${RING} flex shrink-0 items-center rounded-full p-1`}>
                  <Image src="/zavi-wordmark.png" alt="Zavi" width={126} height={52} priority className="h-5 w-auto" />
                  <span className="ml-2 rounded-full border border-black/[0.08] bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-[#595959]">
                    for creators
                  </span>
                </Link>
                <div className="flex shrink-0 items-center">{right}</div>
              </div>
            </div>
          </header>
        </div>
        <div className="lg:pt-3 lg:pl-[96px]">
          <div className="min-h-screen bg-white lg:min-h-[calc(100vh-12px)] lg:rounded-tl-[28px] lg:shadow-[-1px_-1px_0_rgba(16,18,20,0.04)]">
            <div className="hidden justify-end px-8 pt-5 lg:flex">{right}</div>
            <main className={`mx-auto w-full px-4 pt-[96px] sm:px-8 lg:pt-4 ${full ? "max-w-[1600px] pb-6" : "max-w-5xl pb-16"}`}>
              <div className="-mx-1 mb-6 overflow-x-auto px-1 lg:hidden">{nav}</div>
              {children}
            </main>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative isolate min-h-screen overflow-x-clip bg-white font-sans text-foreground antialiased">
      <header className="fixed inset-x-0 top-0 z-50 px-3 sm:px-4">
        <div className={`relative mx-auto ${EASE} ${scrolled ? "mt-2 max-w-[980px]" : "mt-3 max-w-[1180px]"}`}>
          <div className={`liquid-glass relative flex items-center justify-between gap-4 rounded-full border px-3 sm:px-4 ${EASE} ${barHeight}`}>
            <Link href={CREATOR_MARKETPLACE_ENABLED ? "/creators" : "/creator"} className={`${RING} flex shrink-0 items-center rounded-full p-1`}>
              <Image
                src="/zavi-wordmark.png"
                alt="Zavi"
                width={126}
                height={52}
                priority
                className={`w-auto ${EASE} ${scrolled ? "h-[18px]" : "h-5"}`}
              />
              <span className="ml-2 rounded-full border border-black/[0.08] bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-[#595959]">
                for creators
              </span>
            </Link>
            <div className="flex shrink-0 items-center">{right}</div>
          </div>
        </div>
      </header>
      <main
        className={`mx-auto w-full px-4 pb-16 sm:px-8 ${
          wide ? "max-w-5xl pt-[96px] sm:pt-[104px]" : "flex min-h-screen max-w-[600px] items-center pb-10 pt-[96px]"
        }`}
      >
        <div className="w-full">{children}</div>
      </main>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-block border border-black/[0.06] bg-white/85 p-6 shadow-[0_1px_2px_rgba(16,18,20,0.04),0_18px_44px_-24px_rgba(16,18,20,0.22)] backdrop-blur-xl ${className}`}>
      {children}
    </div>
  );
}

export function H1({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <>
      <h1 className="text-[clamp(2rem,4.2vw,2.75rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-[#0e0f11]">{title}</h1>
      {blurb && <p className="mt-3 max-w-[620px] text-[16px] leading-relaxed text-[#595959]">{blurb}</p>}
    </>
  );
}
