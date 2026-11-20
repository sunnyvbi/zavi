"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Check, MousePointer2, X } from "lucide-react";
import { StepGlyph } from "./stepIcons";
import { jakartaHeavy } from "./fonts";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

function Pointer({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute top-0 z-50 will-change-transform ${className}`}
      style={style}
    >
      <MousePointer2 strokeWidth={1.5} className="h-6 w-6 fill-black text-white drop-shadow-xl" />
    </span>
  );
}

const ADS = [
  { src: "/marketing/growth-home/ads/tiktok-texts.jpg", hook: "Farm-fresh, at your door in 24 hours", roas: 4.5, cpa: "$8" },
  { src: "/marketing/growth-home/ads/instagram-draft-3am.jpg", hook: "Summer by the canals from $199", roas: 1.8, cpa: "$45" },
  { src: "/marketing/growth-home/ads/instagram-ayear.jpg", hook: "The gift they will actually use", roas: 3.2, cpa: "$12" },
  { src: "/marketing/growth-home/ads/tiktok-stream.jpg", hook: "Your new favourite coffee spot", roas: 1.4, cpa: "$52" },
  { src: "/marketing/growth-home/ads/instagram-qanda.jpg", hook: "Launch your store this weekend", roas: 2.9, cpa: "$15" },
];
const SCALE_ROAS = 2.5;

function AdDemo({ reduced }: { reduced: boolean }) {
  const [index, setIndex] = useState(0);
  const [decision, setDecision] = useState<"scale" | "stop" | null>(null);
  const ad = ADS[index];
  const verdict = ad.roas >= SCALE_ROAS ? "scale" : "stop";

  useEffect(() => {
    if (reduced) return;
    const timer =
      decision === null
        ? window.setTimeout(() => setDecision(verdict), 1800)
        : window.setTimeout(() => {
            setIndex((i) => (i + 1) % ADS.length);
            setDecision(null);
          }, 500);
    return () => window.clearTimeout(timer);
  }, [decision, verdict, reduced]);

  return (
    <div className="relative flex h-[310px] w-full select-none flex-col">
      <div className="relative mx-4 mt-4 min-h-0 flex-1">
        {[2, 1, 0].map((depth) => {
          const i = (index + depth) % ADS.length;
          const leaving = depth === 0 && decision !== null;
          return (
            <div
              key={i}
              className={`absolute inset-0 overflow-hidden rounded-[16px] transition-all duration-500 ease-out ${
                depth === 0
                  ? "z-20 shadow-[0_8px_30px_rgb(0,0,0,0.12)]"
                  : depth === 1
                    ? "z-10 translate-y-1 scale-[0.96] opacity-60"
                    : "z-0 translate-y-2 scale-[0.92] opacity-40"
              }`}
              style={
                leaving
                  ? {
                      transform: `translateX(${decision === "scale" ? 110 : -110}%) rotate(${decision === "scale" ? 8 : -8}deg)`,
                      opacity: 0,
                    }
                  : undefined
              }
            >
              <img src={ADS[i].src} alt="" className="absolute inset-0 h-full w-full object-cover" />
              <span className="absolute inset-x-5 top-4 text-center text-[14px] font-bold leading-snug text-white">
                <span className="rounded-md bg-[#c8782f]/95 px-1.5 py-0.5 [box-decoration-break:clone]">
                  {ADS[i].hook}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="z-30 flex shrink-0 items-center gap-2 px-3 pb-[3px] pt-[13px]">
        <span
          className={`flex h-[31px] items-center gap-1 rounded-lg border border-[#e4e4e7] px-3 text-[11px] font-semibold tracking-[0.02em] text-[#52525c] transition-all duration-200 ${
            decision === "stop" ? "scale-95 bg-[#f4f4f5]" : "bg-white"
          }`}
        >
          Stop <X strokeWidth={2} className="h-3 w-3" />
        </span>
        {}
        <span className="flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap">
          <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-[#9f9fa9]">ROAS</span>
          <span
            className={`${jakartaHeavy.className} text-[14px] font-black [font-feature-settings:normal] leading-none tracking-tight ${
              ad.roas >= SCALE_ROAS ? "text-[#007956]" : "text-[#f05100]"
            }`}
          >
            {ad.roas}x
          </span>
          <span className="mx-1 text-[14px] text-[#d4d4d8]">|</span>
          <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-[#9f9fa9]">CPA</span>
          <span className={`${jakartaHeavy.className} text-[14px] font-black [font-feature-settings:normal] leading-none tracking-tight text-black`}>{ad.cpa}</span>
        </span>
        <span
          className={`flex h-[31px] items-center gap-1 rounded-lg bg-black px-3 text-[11px] font-semibold tracking-[0.02em] text-white transition-all duration-200 ${
            decision === "scale" ? "scale-95 opacity-80" : ""
          }`}
        >
          Scale <Check strokeWidth={2.5} className="h-3 w-3" />
        </span>
      </div>
    </div>
  );
}

const SEO_FIXES: [string, string][] = [
  ["Fix 12 broken internal links draining crawl budget", "+18% crawl"],
  ["Add schema markup to 34 product pages missing structured data", "+22% CTR"],
  ["Compress 89 images over 500KB slowing Core Web Vitals", "+15 LCP"],
  ["Redirect 41 404 pages with existing backlinks to relevant content", "+2.1K links"],
  ["Optimize 23 title tags exceeding 60 characters", "+12% CTR"],
  ["Create internal links from 8 high-authority pages to target keywords", "+31 positions"],
];
const SEO_ROW_H = 49;

function SeoDemo({ reduced }: { reduced: boolean }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const done = step >= SEO_FIXES.length;
    const timer = window.setTimeout(
      () => setStep((s) => (s >= SEO_FIXES.length ? 0 : s + 1)),
      done ? 2200 : step === 0 ? 1000 : 750,
    );
    return () => window.clearTimeout(timer);
  }, [step, reduced]);

  const applied = reduced ? SEO_FIXES.length : step;
  const pointerRow = Math.min(applied, SEO_FIXES.length - 1);

  return (
    <div className="relative w-full select-none overflow-hidden text-xs">
      <div className="p-2">
        {SEO_FIXES.map(([task, impact], i) => {
          const on = i < applied;
          return (
            <div
              key={task}
              className={`flex min-w-0 items-center justify-between rounded-lg px-4 py-3 transition-colors duration-300 ${
                on ? "bg-[#eff6ff]/40" : ""
              }`}
              style={{ height: SEO_ROW_H }}
            >
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-300 ${
                    on ? "border-black bg-black" : "border-[#d4d4d8]"
                  }`}
                >
                  {on && <Check strokeWidth={3} className="h-2.5 w-2.5 text-white" />}
                </span>
                <span
                  className={`w-full truncate text-left transition-colors ${on ? "text-[#99a1af]" : "text-[#364153]"}`}
                >
                  {task}
                </span>
              </div>
              <div className="flex items-center gap-6">
                <span
                  className={`min-w-[90px] text-right font-medium tabular-nums transition-colors ${
                    on ? "text-black" : "text-[#99a1af]"
                  }`}
                >
                  {impact}
                </span>
                <span
                  key={on ? "applied" : "apply"}
                  className={`hidden h-[31px] w-[74px] items-center justify-center rounded-lg text-[11px] font-semibold sm:flex ${
                    on
                      ? "zavi-pop-in bg-black text-white shadow-sm"
                      : "border border-[#e4e4e7] bg-white text-black"
                  }`}
                >
                  {on ? "Applied" : "Apply"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {!reduced && (
        <Pointer
          className="left-[30px] sm:left-[90%]"
          style={{
            transform: `translateY(${8 + SEO_ROW_H * pointerRow + 16}px)`,
            transition: "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        />
      )}
    </div>
  );
}

const SITE_PROMPT = "Build a clean, modern site for my wellness supplement brand.";
const TEMPLATES = [
  { hero: "#2f4a36", accent: "#8fb37a", card: "#e6efe3", x: -100, top: 0, rotate: -6 },
  { hero: "#e9dcc6", accent: "#b07a4a", card: "#f4ede2", x: 0, top: 15, rotate: 0 },
  { hero: "#f2c9bf", accent: "#d9644a", card: "#fbe9e4", x: 100, top: 30, rotate: 6 },
];

function TemplateCard({ hero, accent, card }: { hero: string; accent: string; card: string }) {
  return (
    <div className="h-[228px] w-[177px] overflow-hidden rounded-[12px] border border-[#f3f4f6] bg-white shadow-[0_4px_20px_rgba(0,0,0,0.08)]">
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="h-1.5 w-8 rounded-full" style={{ background: accent }} />
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1 w-4 rounded-full bg-[#e5e7eb]" />
          ))}
        </span>
      </div>
      <div className="mx-2 flex h-[88px] flex-col justify-end rounded-[8px] p-2.5" style={{ background: hero }}>
        <span className="block h-2 w-20 rounded-full bg-white/85" />
        <span className="mt-1 block h-2 w-12 rounded-full bg-white/60" />
        <span className="mt-2.5 block h-3 w-9 rounded-[5px]" style={{ background: accent }} />
      </div>
      <div className="mx-2 mt-2 grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-12 rounded-[6px]" style={{ background: card }} />
        ))}
      </div>
      <div className="mx-2 mt-2.5 space-y-1">
        <span className="block h-1.5 w-full rounded-full bg-[#f3f4f6]" />
        <span className="block h-1.5 w-3/4 rounded-full bg-[#f3f4f6]" />
      </div>
    </div>
  );
}

function SiteDemo({ reduced }: { reduced: boolean }) {
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<"typing" | "click" | "templates">("typing");

  useEffect(() => {
    if (reduced) return;
    let timer: number;
    if (phase === "typing") {
      timer =
        typed < SITE_PROMPT.length
          ? window.setTimeout(() => setTyped((n) => n + 1), 35)
          : window.setTimeout(() => setPhase("click"), 400);
    } else if (phase === "click") {
      timer = window.setTimeout(() => setPhase("templates"), 900);
    } else {
      timer = window.setTimeout(() => {
        setTyped(0);
        setPhase("typing");
      }, 3400);
    }
    return () => window.clearTimeout(timer);
  }, [typed, phase, reduced]);

  const showTemplates = reduced || phase === "templates";
  const fade = "transition-all duration-500 ease-in-out";

  return (
    <div className="relative h-[306px] w-full select-none overflow-hidden">
      <div
        className={`${fade} absolute inset-0 flex flex-col items-center justify-center px-4 ${
          showTemplates ? "pointer-events-none translate-y-5 opacity-0" : "opacity-100"
        }`}
      >
        <div className="w-full max-w-[300px] rounded-[16px] border border-white/80 bg-white p-4 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <p className="min-h-[52px] text-left text-[13px] font-medium leading-relaxed text-black">
            {SITE_PROMPT.slice(0, reduced ? SITE_PROMPT.length : typed)}
            <span className="zavi-type-caret ml-px inline-block h-[18px] w-[2px] bg-black align-text-bottom" />
          </p>
        </div>
        <div className="relative mt-3 flex w-full max-w-[300px] justify-end">
          <span
            className={`flex h-[31px] items-center rounded-lg bg-black px-4 text-[11px] font-semibold text-white transition-transform duration-200 ${
              phase === "click" ? "scale-95" : ""
            }`}
          >
            Create Site
          </span>
          {!reduced && (
            <Pointer
              className="left-0"
              style={{
                transform: phase === "typing" ? "translate(340px, 180px)" : "translate(262px, 16px)",
                transition: "transform 0.8s ease-in-out",
              }}
            />
          )}
        </div>
      </div>

      <div
        className={`${fade} absolute inset-0 bg-gradient-to-br from-[#ecfdf5]/50 via-[#f9fafb] to-[#ecfdf5]/30 px-4 py-6 ${
          showTemplates ? "opacity-100" : "pointer-events-none translate-y-5 opacity-0"
        }`}
      >
        <div className="relative h-[260px]">
          {TEMPLATES.map((t, i) => (
            <div
              key={i}
              className="absolute left-1/2"
              style={{
                top: t.top,
                zIndex: i + 1,
                opacity: showTemplates ? 1 : 0,
                transform: showTemplates
                  ? `translateX(calc(-50% + ${t.x}px)) rotate(${t.rotate}deg)`
                  : `translateX(calc(-50% + ${t.x}px)) translateY(40px) rotate(${t.rotate}deg) scale(0.9)`,
                transition: `all 0.7s cubic-bezier(0.25, 1, 0.5, 1) ${showTemplates ? 0.08 * i : 0}s`,
              }}
            >
              <TemplateCard {...t} />
            </div>
          ))}
          <div
            className="absolute left-1/2 top-1/2 z-20"
            style={{
              opacity: showTemplates ? 1 : 0,
              transform: showTemplates
                ? "translate(-50%, -50%) scale(1) rotate(-3deg)"
                : "translate(-50%, 0%) scale(0.6) rotate(-3deg)",
              filter: showTemplates ? "blur(0)" : "blur(8px)",
              transition: `all 0.7s cubic-bezier(0.16, 1, 0.3, 1) ${showTemplates ? 0.35 : 0}s`,
            }}
          >
            <span className="block whitespace-nowrap rounded-full bg-black px-8 py-3.5 text-[16px] font-medium tracking-wide text-white shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
              Choose from 3 templates
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Column({
  title,
  points,
  demo,
  logos,
  logoLabel,
  last = false,
}: {
  title: string;
  points: string[];
  demo: ReactNode;
  logos: string[];
  logoLabel: string;
  last?: boolean;
}) {
  return (
    <div
      className={`relative flex flex-col items-center gap-8 px-4 py-6 text-center transition-colors duration-500 hover:bg-white/50 md:px-8 md:py-10 lg:items-start lg:text-left ${
        last ? "" : "border-[#e4e4e7]/60 lg:border-r"
      }`}
    >
      <div className="space-y-8">
        <h3 className="text-[22px] font-bold leading-tight tracking-[-0.02em] text-black md:text-[32px] lg:text-[36px]">
          Autonomous
          <span className="lg:hidden"> </span>
          <br className="hidden lg:block" />
          {title}
        </h3>
        <ul className="mt-4 space-y-4 text-left">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-3 text-[14px] text-[#3f3f46]">
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-black" />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div
        aria-hidden="true"
        className="relative w-full overflow-hidden rounded-[20px] border border-[#e4e4e7]/60 bg-[#eff6ff]/50 shadow-[0_1px_2px_0_rgba(0,0,0,0.025)]"
      >
        {demo}
      </div>
      <div className="-mt-4 flex flex-wrap items-center gap-4">
        <span className="sr-only">{logoLabel}</span>
        {logos.map((name) => (
          <StepGlyph key={name} name={name} className="h-6 w-6" />
        ))}
      </div>
    </div>
  );
}

export function GrowthRunsForYou() {
  const reduced = usePrefersReducedMotion();
  return (
    <section id="use-cases" className="w-full scroll-mt-28 px-3 py-4 text-[#0e0f11] sm:px-6">
      <h2 className="sr-only">What Zavi runs for you</h2>
      <div className="mx-auto max-w-[1600px] overflow-hidden rounded-blockLg border border-[#e6eaef] bg-[#f8fafc] px-3 md:px-8 lg:px-12">
        <div className="grid grid-cols-1 lg:grid-cols-3">
          <Column
            title="ad optimization"
            points={["Performance audits on demand", "AI creative generation"]}
            demo={<AdDemo reduced={reduced} />}
            logoLabel="Works with Google Ads, Meta, TikTok, LinkedIn and Reddit."
            logos={["Google Ads", "Meta Ads", "TikTok", "LinkedIn", "Reddit"]}
          />
          <Column
            title="SEO and GEO agent"
            points={["Technical SEO audits on autopilot", "AI-powered content optimization"]}
            demo={<SeoDemo reduced={reduced} />}
            logoLabel="Works with Google Analytics, Search Console, Perplexity and Shopify."
            logos={["Google Analytics", "Google Search Console", "Perplexity", "Shopify"]}
          />
          <Column
            last
            title="website builder"
            points={["AI generates pages from your brand", "Change any section by asking in chat"]}
            demo={<SiteDemo reduced={reduced} />}
            logoLabel="Works with Shopify, Google Analytics and Meta."
            logos={["Shopify", "Google Analytics", "Meta Ads"]}
          />
        </div>
      </div>
    </section>
  );
}
