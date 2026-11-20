"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const BLUE = "#027BFF";
const GOLD = "#B8860B";
const GREEN = "#167F50";
const CORAL = "#FF6B6B";

type AgentStep = { name: string; color: string; line: string };
type Scenario = {
  id: string;
  chip: string;
  blurb: string;
  primary: string;
  keywords: string[];
  operatorQ: string;
  url: string;
  agents: AgentStep[];
  outcome: string;
  outcomeLabel: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "signups",
    chip: "Get me more signups",
    blurb: "Grow the top of your funnel.",
    primary: GOLD,
    keywords: ["signup", "sign up", "users", "leads", "acquisition", "referral", "more customers", "top of funnel"],
    operatorQ: "I want more signups this month.",
    url: "acme.zavi.app",
    agents: [
      { name: "Growth-lead", color: GOLD, line: "Found the constraint: most visitors leave before the signup form." },
      { name: "Content", color: CORAL, line: "Wrote three new headlines and a shorter signup form to test." },
      { name: "Performance-marketer", color: GOLD, line: "Drafted a referral offer and an ad test for your approval." },
    ],
    outcome: "Two experiments ready · waiting on your approval.",
    outcomeLabel: "Plan ready",
  },
  {
    id: "conversion",
    chip: "Turn traffic into customers",
    blurb: "Lift conversion on the traffic you already have.",
    primary: GOLD,
    keywords: ["conversion", "convert", "traffic", "revenue", "sales", "checkout", "ads", "cac", "funnel", "customers", "pricing"],
    operatorQ: "I get traffic but not enough customers. Fix my funnel.",
    url: "acme.zavi.app",
    agents: [
      { name: "Performance-marketer", color: GOLD, line: "Found the losing ad set and proposed moving its spend to retargeting." },
      { name: "Engineer", color: BLUE, line: "Drafted a checkout-friction fix for your review." },
    ],
    outcome: "Funnel fix and spend change proposed · you approve.",
    outcomeLabel: "Fix proposed",
  },
  {
    id: "organic",
    chip: "Grow my organic reach",
    blurb: "SEO, social, and content that compounds.",
    primary: GREEN,
    keywords: ["seo", "organic", "content", "blog", "social", "linkedin", "instagram", "tiktok", "reddit", "search", "posts"],
    operatorQ: "Grow my organic reach without paid ads.",
    url: "acme.zavi.app",
    agents: [
      { name: "SEO", color: GREEN, line: "Found five pages that rank on page two and can move up." },
      { name: "Content", color: CORAL, line: "Drafted a week of posts from your best-performing topics." },
    ],
    outcome: "SEO fixes and a content week drafted · ready to review.",
    outcomeLabel: "Drafts ready",
  },
  {
    id: "build",
    chip: "Build a landing page",
    blurb: "Need a page for a launch or a test? Zavi builds it.",
    primary: BLUE,
    keywords: ["build", "new", "scratch", "start", "create", "launch", "idea", "page", "site", "landing"],
    operatorQ: "Build me a landing page for our new plan.",
    url: "acme.zavi.app",
    agents: [
      { name: "Engineer", color: BLUE, line: "Built the page with a signup form and analytics wired in." },
      { name: "Content", color: CORAL, line: "Wrote the headline, the offer, and two variants to test." },
    ],
    outcome: "Page built, variants ready to test.",
    outcomeLabel: "Live",
  },
];

function routeToScenario(text: string): Scenario {
  const t = text.trim().toLowerCase();
  if (!t) return SCENARIOS[0];
  for (const s of SCENARIOS) {
    if (s.keywords.some((k) => t.includes(k))) return s;
  }
  return SCENARIOS[0];
}

function Dot({ color, live }: { color: string; live: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      {live && <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ backgroundColor: color }} />}
      <span className="relative size-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

function WorkingDots({ color }: { color: string }) {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="size-1 rounded-full" style={{ backgroundColor: color }} animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }} />
      ))}
    </span>
  );
}

function ZaviFaviconMark({ className = "size-8", live = false }: { className?: string; live?: boolean }) {
  return (
    <span className={`relative flex ${className} shrink-0 items-center justify-center`} aria-hidden>
      <img
        src="/icon.svg"
        alt=""
        draggable={false}
        className="size-full rounded-[8px] bg-white object-contain shadow-[0_1px_2px_rgba(25,25,25,0.16)]"
      />
      {live && (
        <span className="absolute -right-0.5 -top-0.5 flex size-2.5" aria-hidden>
          <span className="absolute inset-0 rounded-full opacity-70 motion-safe:animate-ping" style={{ backgroundColor: GREEN }} />
          <span className="relative size-2.5 rounded-full border-2 border-ink" style={{ backgroundColor: GREEN }} />
        </span>
      )}
    </span>
  );
}

function RunView({
  scenario,
  onReset,
  freeDailyCredits,
  startHref,
}: {
  scenario: Scenario;
  onReset: () => void;
  freeDailyCredits: number;
  startHref: string;
}) {
  const reduceMotion = useReducedMotion();
  const N = scenario.agents.length;
  const lastStep = N + 1;
  const [step, setStep] = useState(reduceMotion ? lastStep : 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduceMotion) {
      setStep(lastStep);
      return;
    }
    if (step >= lastStep) return;
    timer.current = setTimeout(() => setStep((s) => Math.min(s + 1, lastStep)), step === 0 ? 1800 : 2300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [step, reduceMotion, lastStep]);

  const done = step >= lastStep;
  const deploying = step < 1;
  const phase = deploying ? "Deploying the team" : done ? scenario.outcomeLabel : scenario.agents[step - 1].name;

  return (
    <div className="flex flex-col gap-3.5">
      {}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[2px] text-inkMuted">Sample preview</span>
        <span className="flex items-center gap-2 font-body text-[12px] text-ink">
          <Dot color={scenario.primary} live={!reduceMotion && !done} />
          <span aria-live="polite">{phase}</span>
        </span>
      </div>

      {}
      <div className="flex gap-2" aria-hidden>
        {Array.from({ length: lastStep + 1 }).map((_, i) => (
          <span key={i} className="h-1 flex-1 rounded-full transition-colors duration-300" style={{ backgroundColor: i <= step ? scenario.primary : "#E4E1D8" }} />
        ))}
      </div>

      {}
      <div className="flex flex-col gap-2.5">
        <div className="flex justify-end">
          <div className="max-w-[86%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 font-body text-[13px] leading-[19px] text-cream">{scenario.operatorQ}</div>
        </div>
        <div className="flex items-start gap-2.5">
          <ZaviFaviconMark className="mt-0.5 size-7" />
          <div className="min-w-0 flex-1 rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 shadow-[0_1px_0_rgba(25,25,25,0.04),0_6px_16px_-10px_rgba(25,25,25,0.18)]">
            <p className="font-display text-[13px] font-semibold text-ink">Zavi</p>
            <p className="mt-0.5 inline-flex items-center gap-2 font-body text-[13px] leading-[18px] text-inkMuted">
              {done ? "Done. Here's what the team landed." : deploying ? "On it, spinning up the team" : "The team's on it"}
              {!done && <WorkingDots color={scenario.primary} />}
            </p>
          </div>
        </div>
      </div>

      {}
      {step >= 1 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="overflow-hidden rounded-2xl border border-ink/10 bg-white shadow-[0_10px_28px_-14px_rgba(25,25,25,0.22)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-ink/8 px-3.5 py-2.5">
            <span className="inline-flex items-center gap-2 font-mono text-[11px] text-ink">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: scenario.primary }} aria-hidden />
              {scenario.url}
            </span>
            <span className="font-mono text-[9.5px] uppercase tracking-[1.4px]" style={{ color: done ? scenario.primary : "#787268" }}>
              {done ? "Preview" : "Working"}
            </span>
          </div>

          <div className="flex flex-col">
            {scenario.agents.map((a, i) => {
              const shown = step >= i + 1;
              const working = step === i + 1;
              if (!shown) return null;
              return (
                <motion.div
                  key={a.name}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-start gap-2.5 border-b border-ink/6 px-3.5 py-2.5 last:border-b-0"
                >
                  <span className="mt-[3px] shrink-0"><Dot color={a.color} live={working} /></span>
                  <span className="min-w-0 flex-1 font-body text-[12px] leading-[17px] text-ink">
                    <span className="font-display font-semibold" style={{ color: a.color }}>{a.name}</span>{" "}
                    {a.line}
                    {working && <span className="ml-1.5 inline-flex translate-y-[1px]"><WorkingDots color={a.color} /></span>}
                  </span>
                </motion.div>
              );
            })}
          </div>

          {done && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.35 }}
              className="flex items-center justify-between gap-2 border-t border-ink/8 px-3.5 py-3"
            >
              <span className="min-w-0 flex-1 font-body text-[12px] leading-[16px] text-inkMuted">{scenario.outcome}</span>
              <span className="inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 font-body text-[12px] font-semibold text-white" style={{ backgroundColor: scenario.primary }}>
                <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {scenario.outcomeLabel}
              </span>
            </motion.div>
          )}
        </motion.div>
      )}

      {}
      {done && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="rounded-2xl border p-3.5"
          style={{ backgroundColor: "#FFF7DE", borderColor: "#F1E3AE" }}
        >
          <p className="font-body text-[13px] leading-[18px] text-ink">
            One growth agent with a whole team behind it. This was a scripted sample; Zavi does it for real on your own business.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <a href={startHref} className="inline-flex h-10 flex-1 items-center justify-center rounded-full bg-ink px-4 font-display text-[13px] font-semibold text-cream transition-transform hover:-translate-y-px">
              Start free · {freeDailyCredits.toLocaleString()} credits/day →
            </a>
            <button type="button" onClick={onReset} className="inline-flex h-10 items-center justify-center rounded-full border border-ink/20 bg-white px-4 font-body text-[13px] font-medium text-ink transition-colors hover:bg-cream">
              Try another
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

function PickerView({ onPick }: { onPick: (s: Scenario) => void }) {
  const [text, setText] = useState("");
  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onPick(routeToScenario(text));
    },
    [text, onPick],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[2px] text-inkMuted">Sample preview</span>
        <p className="font-display text-[16px] font-semibold leading-[22px] text-ink">
          I&apos;m Zavi, your AI growth agent. Pick a goal and I&apos;ll plan the work:
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s)}
            className="group flex items-center gap-3 rounded-2xl border border-ink/10 bg-white px-3.5 py-3 text-left shadow-[0_4px_14px_-10px_rgba(25,25,25,0.25)] transition-all hover:-translate-y-px hover:border-ink/25 hover:shadow-[0_10px_24px_-12px_rgba(25,25,25,0.3)]"
          >
            <span className="mt-0.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.primary }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-[16px] font-semibold leading-[18px] text-ink">{s.chip}</span>
              <span className="mt-0.5 block font-body text-[12px] leading-[15px] text-inkMuted">{s.blurb}</span>
            </span>
            <span className="font-mono text-[14px] text-ink/25 transition-colors group-hover:text-ink" aria-hidden>→</span>
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="or type your own growth goal…"
          aria-label="Type a growth goal"
          className="h-10 min-w-0 flex-1 rounded-full border border-ink/15 bg-white px-4 font-body text-[13px] text-ink outline-none placeholder:text-inkMuted/70 focus:border-ink"
        />
        <button type="submit" className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-ink px-4 font-display text-[13px] font-semibold text-cream transition-transform hover:-translate-y-px">
          Go
        </button>
      </form>
    </div>
  );
}

export function ZaviTestBubble({ freeDailyCredits, startHref = "/start" }: { freeDailyCredits: number; startHref?: string }) {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const enabled = process.env.NEXT_PUBLIC_DEMO_BUBBLE !== "0";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => closeRef.current?.focus(), 60);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open]);

  const [nearEnd, setNearEnd] = useState(false);
  useEffect(() => {
    const phone = window.matchMedia("(max-width: 639px)");
    const check = () => {
      if (!phone.matches) {
        setNearEnd(true);
        return;
      }
      const doc = document.documentElement;
      setNearEnd(window.scrollY + window.innerHeight >= doc.scrollHeight - doc.clientHeight * 0.75);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    phone.addEventListener("change", check);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      phone.removeEventListener("change", check);
    };
  }, []);

  if (!enabled) return null;

  return (
    <>
      {}
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="See Zavi build"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
            className="fixed bottom-5 right-4 z-[60] flex max-h-[min(82vh,660px)] w-[min(93vw,384px)] flex-col overflow-hidden rounded-[26px] border border-ink/10 bg-[#f9f9f9] shadow-[0_28px_70px_-24px_rgba(25,25,25,0.4)] sm:right-6"
          >
            <div className="relative flex items-center justify-between px-4 py-3.5">
              <div
                className="pointer-events-none absolute inset-0"
                aria-hidden
                style={{ background: "radial-gradient(120% 140% at 0% 0%, #FBE3D3 0%, transparent 55%), radial-gradient(120% 140% at 100% 0%, #D9E6FB 0%, transparent 55%)" }}
              />
              <div className="relative flex items-center gap-2.5">
                <ZaviFaviconMark />
                <div className="leading-tight">
                  <p className="font-display text-[16px] font-semibold text-ink">Zavi</p>
                  <p className="font-body text-[11px] text-inkMuted">Your growth agent</p>
                </div>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="relative flex size-8 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="h-px bg-ink/8" />

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {scenario ? (
                <RunView
                  key={scenario.id}
                  scenario={scenario}
                  onReset={() => setScenario(null)}
                  freeDailyCredits={freeDailyCredits}
                  startHref={startHref}
                />
              ) : (
                <PickerView onPick={setScenario} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {}
      <AnimatePresence>
        {!open && nearEnd && (
          <motion.button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="See Zavi build"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-5 right-4 z-[60] inline-flex items-center gap-2.5 rounded-full bg-ink py-3 pl-3 pr-4 shadow-[0_16px_34px_-12px_rgba(25,25,25,0.5)] transition-transform hover:-translate-y-0.5 active:scale-95 sm:right-6"
          >
            <ZaviFaviconMark className="size-6" live />
            <span className="font-display text-[16px] font-semibold tracking-[-0.1px] text-cream">See Zavi build</span>
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

export default ZaviTestBubble;
