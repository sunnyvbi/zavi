"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppWindow, ArrowRight, ChevronRight } from "lucide-react";
import { jakartaHeavy } from "./fonts";
import { SiteIcon, toHost } from "./SiteIcon";
import { ZaviMascot } from "@/components/ZaviMascot";
import { useHomeBuildCta } from "@/lib/workspace/buildFraming";
import { FOCUS } from "./growthUi";
import { attributionLink } from "@/lib/marketing/attributionLinks";

const HERO = {
  livePill: { label: "Live", text: "See Zavi run a real company's growth, in real time" },
  line1: "AI Growth Agent",
  line2: "For Your Business",
  keep: 3,
  placeholder: "Enter your website",
  cta: "Grow my business",
  note: "Free to start. No card, no sales call.",
  noSite: "Don't have a website yet?",
  noSiteCta: "Create your website",
  proof: "Built by operators from",
};

const LOGOS = [
  { src: "/marketing/growth-home/logos/airbnb.svg", label: "Airbnb", h: 28 },
  { src: "/marketing/growth-home/logos/meta.svg", label: "Meta", h: 22 },
  { src: "/marketing/growth-home/logos/upwork.svg", label: "Upwork", h: 24 },
  { src: "/marketing/growth-home/logos/amazon.svg", label: "Amazon", h: 26 },
];

export function buildHrefFor(startHref: string): string {
  const u = new URL(startHref, "http://fallback.invalid");
  u.searchParams.set("step", "idea");
  return `${u.pathname}${u.search}`;
}

const CARET_BOX =
  "ml-[0.04em] inline-block h-[0.82em] w-[0.05em] translate-y-[0.1em] rounded-[1px]";

function TypewriterHeadline({ className }: { className: string }) {
  const { line1, line2, keep } = HERO;
  const total = line1.length + line2.length;
  const [count, setCount] = useState(total);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let n = total;
    let dir = -1;
    let timer = 0;
    const tick = () => {
      n += dir;
      setCount(n);
      let delay = dir < 0 ? 34 : 62;
      if (n <= keep) {
        dir = 1;
        delay = 500;
      } else if (n >= total) {
        dir = -1;
        delay = 3000;
      }
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, 3000);
    return () => window.clearTimeout(timer);
  }, [total, keep]);

  const shown1 = line1.slice(0, Math.min(count, line1.length));
  const shown2 = count > line1.length ? line2.slice(0, count - line1.length) : "";
  const caret = (
    <span aria-hidden="true" className={`zavi-type-caret bg-current ${CARET_BOX}`} />
  );

  return (
    <h1 aria-label={`${line1} ${line2}`} className={className}>
      <span className="relative inline-block whitespace-nowrap">
        {}
        <span aria-hidden="true" className="invisible">
          {line1}
          <br />
          <span className="inline-block">{line2}</span>
          <span className={CARET_BOX} />
        </span>
        <span aria-hidden="true" className="absolute inset-0">
          {shown1}
          {shown2.length === 0 && caret}
          <br />
          <span className="relative inline-block">
            <span className="relative z-[1]">{shown2}</span>
          </span>
          {shown2.length > 0 && caret}
        </span>
      </span>
    </h1>
  );
}

export function WebsiteForm({
  startHref,
  id = "hero-site",
  tone = "light",
  className = "mt-9 w-full max-w-[640px]",
  cta = HERO.cta,
  note,
  variant = "glass",
}: {
  startHref: string;
  id?: string;
  tone?: "light" | "dark";
  className?: string;
  cta?: string;
  variant?: "glass" | "solid";
  note?: ReactNode;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const site = value.trim();
    if (!site) {
      router.push(attributionLink(startHref, window.location.href));
      return;
    }
    const url = new URL(startHref, window.location.origin);
    url.searchParams.set("step", "website");
    url.searchParams.set("website", toHost(site));
    const sameOrigin = url.origin === window.location.origin;
    router.push(attributionLink(sameOrigin ? `${url.pathname}${url.search}` : url.toString(), window.location.href));
  }

  const fallback = new URL(startHref, "http://fallback.invalid");
  const fallbackAction =
    fallback.origin === "http://fallback.invalid" ? fallback.pathname : `${fallback.origin}${fallback.pathname}`;
  const fallbackParams = [...fallback.searchParams.entries()].filter(([k]) => k !== "step" && k !== "website");

  return (
    <form onSubmit={onSubmit} action={fallbackAction} method="get" className={className}>
      {fallbackParams.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="step" value="website" />
      <div
        className={
          variant === "solid"
            ? `flex flex-col gap-2 sm:flex-row sm:items-center sm:rounded-full sm:bg-white sm:p-1.5 sm:ring-0 ${
                tone === "dark"
                  ? "rounded-[26px] bg-[#1b1c1f] p-2 ring-1 ring-inset ring-white/10"
                  : "gap-3"
              }`
            : "flex flex-col gap-2 rounded-block border border-black/[0.08] bg-white/85 p-2 shadow-[0_24px_70px_-26px_rgba(16,18,20,0.40)] backdrop-blur-xl sm:flex-row sm:items-center sm:rounded-full sm:pl-5"
        }
      >
        <label
          htmlFor={id}
          className={
            variant === "solid"
              ? `flex flex-1 items-center gap-3 rounded-full px-4 py-3.5 sm:bg-transparent sm:py-0 sm:pl-4 ${
                  tone === "dark" ? "bg-transparent" : "bg-white"
                }`
              : "sr-only"
          }
        >
          {variant === "solid" ? (
            <SiteIcon
              value={value}
              className={tone === "dark" ? "text-white/45 sm:text-[#9a9a9a]" : "text-[#9a9a9a]"}
            />
          ) : (
            "Enter your website"
          )}
          {variant === "solid" && (
            <input
              id={id}
              name="website"
              type="text"
              inputMode="url"
              autoComplete="url"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={HERO.placeholder}
              className={`w-full min-w-0 bg-transparent text-[16px] outline-none focus:outline-none sm:text-[#0e0f11] sm:placeholder:text-[#595959] ${
                tone === "dark" ? "text-white placeholder:text-white/45" : "text-[#0e0f11] placeholder:text-[#595959]"
              }`}
            />
          )}
        </label>
        {variant === "glass" && (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-2 px-4 text-[#9a9a9a] sm:gap-0 sm:px-0">
              <SiteIcon value={value} className="" />
              <input
                id={id}
                name="website"
                type="text"
                inputMode="url"
                autoComplete="url"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={HERO.placeholder}
                className="min-h-12 w-full min-w-0 bg-transparent text-[16px] text-[#0e0f11] outline-none placeholder:text-[#9a9a9a] focus:outline-none focus-visible:shadow-none sm:px-3"
              />
            </span>
          </>
        )}
        <button
          type="submit"
          className={`inline-flex min-h-12 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full px-6 text-[16px] font-semibold transition-opacity duration-200 hover:opacity-90 sm:bg-[#0e0f11] sm:text-white ${
            variant === "solid" && tone === "dark" ? "bg-white text-[#0e0f11]" : "bg-[#0e0f11] text-white"
          }`}
        >
          {cta}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <p className={`mt-5 text-[16px] ${tone === "dark" ? "text-white/70" : "text-[#8a8a8a]"}`}>{HERO.note}</p>
      {note}
    </form>
  );
}

export function NoWebsiteNote({
  tone = "light",
  small = false,
  startHref = "/start",
}: {
  tone?: "light" | "dark";
  small?: boolean;
  startHref?: string;
}) {
  const asButton = useHomeBuildCta();
  const buildHref = buildHrefFor(startHref);
  if (asButton && tone === "light" && !small) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[17px]">
        <span className="text-[#595959]">{HERO.noSite}</span>
        <Link
          href={buildHref}
          prefetch={false}
          data-testid="home-build-website-cta"
          className={`group inline-flex min-h-11 items-center gap-2 font-medium text-[#1a1f36] transition-colors duration-200 hover:text-[#595959] ${FOCUS}`}
        >
          <AppWindow aria-hidden="true" className="h-[18px] w-[18px] text-[#595959]" />
          <span className="underline decoration-1 underline-offset-4">{HERO.noSiteCta}</span>
          <ChevronRight aria-hidden="true" className="ml-4 h-4 w-4 text-[#595959] transition group-hover:translate-x-0.5" />
        </Link>
      </div>
    );
  }
  if (asButton) {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
        <span className={`${small ? "text-[16px]" : "text-[14px]"} ${tone === "dark" ? "text-white/70" : "text-[#595959]"}`}>
          {HERO.noSite}
        </span>
        <Link
          href={buildHref}
          prefetch={false}
          data-testid="home-build-website-cta"
          className={`inline-flex min-h-12 items-center gap-2 rounded-full border px-6 text-[16px] font-semibold transition-colors duration-200 ${FOCUS} ${
            tone === "dark"
              ? "border-white/20 text-white hover:bg-white/10"
              : "border-black/[0.1] bg-white text-[#0e0f11] hover:bg-[#f6f6f7]"
          }`}
        >
          {HERO.noSiteCta}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
    );
  }
  return (
    <p className={`mt-4 ${small ? "text-[16px]" : "text-[14px]"} ${tone === "dark" ? "text-white/70" : "text-[#595959]"}`}>
      {HERO.noSite}{" "}
      <Link
        href={buildHref}
        prefetch={false}
        className={`inline-flex items-center gap-1 font-semibold underline underline-offset-4 transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 ${
          small ? "" : "min-h-11"
        } ${
          tone === "dark"
            ? "text-white hover:text-white/75 focus-visible:outline-white"
            : "text-[#0e0f11] hover:text-[#595959] focus-visible:outline-[#0e0f11]"
        }`}
      >
        {HERO.noSiteCta}
      </Link>
    </p>
  );
}

function StaticHeadline({ className }: { className: string }) {
  return (
    <h1 className={className}>
      {HERO.line1}
      {}
      <span className="relative inline-block h-[0.82em] w-[1.15em] align-baseline">
        <span className="absolute left-[calc(50%-32px)] top-[calc(46%-32px)] leading-none">
          <ZaviMascot size={64} />
        </span>
      </span>
      <br />
      <span className="relative inline-block">
        <span className="relative z-[1]">{HERO.line2}</span>
      </span>
    </h1>
  );
}

function LogoRow() {
  return (
    <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-14 gap-y-4">
      {LOGOS.map((logo) => (
        <li key={logo.label} className="shrink-0">
          <img
            src={logo.src}
            alt={logo.label}
            width={logo.h}
            height={logo.h}
            style={{ height: logo.h }}
            className="w-auto opacity-85"
          />
        </li>
      ))}
    </ul>
  );
}

function LivePill({ slug }: { slug: string }) {
  return (
    <Link
      href={`/live/${slug}`}
      data-testid="hero-live-pill"
      className="group mb-7 inline-flex min-h-10 max-w-full items-center gap-3 rounded-full border border-black/[0.08] bg-white/85 py-1.5 pl-1.5 pr-4 text-left text-[14px] font-medium text-[#0e0f11] backdrop-blur transition hover:border-black/20 sm:text-[15px]"
    >
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#e9f7ee] px-2 py-0.5 text-[13px] font-medium text-[#1f8a4c]">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#22c55e] opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
        </span>
        {HERO.livePill.label}
      </span>
      <span className="min-w-0">{HERO.livePill.text}</span>
      <ArrowRight aria-hidden className="h-5 w-5 shrink-0 transition group-hover:translate-x-0.5" />
    </Link>
  );
}

export function GrowthHero({
  startHref,
  typewriter = false,
  livePillSlug = null,
}: {
  startHref: string;
  livePillSlug?: string | null;
  typewriter?: boolean;
}) {
  const headlineClass = `${jakartaHeavy.className} text-[clamp(2.4rem,4.4vw,3.5rem)] font-bold leading-[1.36] tracking-[-0.025em] text-[#0e0f11]`;
  return (
    <div className="w-full sm:min-h-[100svh]">
    <section className="relative isolate w-full overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 bg-center bg-no-repeat"
        style={{
          backgroundImage: "url('/marketing/growth-home/hero-bg.webp')",
          backgroundSize: "calc(100% + 120px) calc(100% + 120px)",
        }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 bg-white/25" />

      <div className="relative z-10 mx-auto flex max-w-[820px] flex-col items-center px-6 pb-[88px] pt-32 text-center sm:pb-28 sm:pt-[136px]">
        {livePillSlug ? <LivePill slug={livePillSlug} /> : null}
        {typewriter ? (
          <TypewriterHeadline className={headlineClass} />
        ) : (
          <StaticHeadline className={headlineClass} />
        )}
        <WebsiteForm
          startHref={startHref}
          className="mt-14 w-full max-w-[672px]"
          note={<NoWebsiteNote startHref={startHref} />}
        />

        <div className="mt-[72px] w-full min-w-0">
          <p className="text-[15px] font-medium text-[#3a3a3a]">{HERO.proof}</p>
          <LogoRow />
        </div>
      </div>
    </section>
    </div>
  );
}
