"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BarChart3, Check, FileText, Globe, Megaphone, ShoppingBag, Store, Target } from "lucide-react";

const HEADING = "Grow your business in three steps.";
const SUBHEAD =
  "Connect your business. Zavi, your AI growth agent, gets to work. It finds what's slowing you down and helps fix it.";

const STEP_MS = 5000;
export function railTarget(
  tabLeft: number,
  tabWidth: number,
  railWidth: number,
  scrollWidth: number,
): number {
  const want = tabLeft - (railWidth - tabWidth) / 2;
  return Math.min(Math.max(0, want), Math.max(0, scrollWidth - railWidth));
}

export const SETTLE_MS = 120;

export function nearestTab(centres: number[], mid: number): number | null {
  let landed: number | null = null;
  let best = Infinity;
  centres.forEach((centre, i) => {
    const gap = Math.abs(centre - mid);
    if (gap < best) {
      best = gap;
      landed = i;
    }
  });
  return landed;
}

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

function CardShell({
  icon,
  title,
  meta,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-block border border-black/[0.08] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.04)]">
      <div className="flex items-center gap-2.5 border-b border-black/[0.06] px-4 py-3.5 sm:px-4">
        <span className="text-[#0e0f11]">{icon}</span>
        <span className="text-[14px] font-semibold text-[#0e0f11]">{title}</span>
        <span className="ml-auto inline-flex items-center text-[16px] text-[#595959]">{meta}</span>
      </div>
      <div className="p-4 sm:p-4">{children}</div>
    </div>
  );
}

function GreenDot() {
  return <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#167f50]" />;
}

function IconRow({
  icon,
  label,
  trailing,
  delay,
}: {
  icon: ReactNode;
  label: string;
  trailing: ReactNode;
  delay: string;
}) {
  return (
    <li
      className="zavi-step-reveal flex items-center gap-3 border-b border-black/[0.06] py-3 last:border-b-0"
      style={{ animationDelay: delay }}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#f9f9f9] text-[#0e0f11]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-[14px] font-medium text-[#0e0f11]">{label}</span>
      {trailing}
    </li>
  );
}

const GLYPH = "h-[18px] w-[18px]";
const TICK = <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-[#167f50]" strokeWidth={2} />;

function WebsiteCard() {
  return (
    <CardShell
      icon={<Globe aria-hidden="true" className="h-5 w-5" />}
      title="Your website"
      meta={
        <>
          <GreenDot />
          Scanning…
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-full border border-black/[0.08] bg-[#f9f9f9] py-2 pl-3.5 pr-2">
        <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-[#595959]" />
        <span className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[14px] font-medium text-[#0e0f11]">
          <span className="zavi-wp-type inline-block overflow-hidden align-bottom">yourwebsite.com</span>
        </span>
        <span className="inline-flex shrink-0 items-center rounded-full bg-[#0e0f11] px-3.5 py-1.5 text-[16px] font-semibold text-white">
          Scan
        </span>
      </div>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[#f9f9f9]">
        <span className="zavi-wp-bar block h-full rounded-full bg-[#167f50]" />
      </div>
      <ul className="-mb-1 mt-3 flex flex-col">
        <IconRow
          icon={<ShoppingBag aria-hidden="true" className={GLYPH} strokeWidth={1.9} />}
          label="24 products indexed"
          trailing={TICK}
          delay="2.6s"
        />
        <IconRow
          icon={<BarChart3 aria-hidden="true" className={GLYPH} strokeWidth={1.9} />}
          label="Analytics connected"
          trailing={TICK}
          delay="3.1s"
        />
        <IconRow
          icon={<Store aria-hidden="true" className={GLYPH} strokeWidth={1.9} />}
          label="Shopify checkout"
          trailing={TICK}
          delay="3.6s"
        />
      </ul>
    </CardShell>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-[#f9f9f9] px-2 py-1 text-[13px] font-semibold text-[#595959]">
      {children}
    </span>
  );
}

function PlanCard() {
  return (
    <CardShell
      icon={<FileText aria-hidden="true" className="h-5 w-5" />}
      title="Growth plan"
      meta={
        <>
          <span className="hidden sm:inline">Drafted&nbsp;</span>just now
        </>
      }
    >
      <ul className="-mb-1 flex flex-col">
        <IconRow
          icon={<Target aria-hidden="true" className={GLYPH} strokeWidth={1.9} />}
          label="Fix mobile checkout first"
          trailing={<Tag>Priority</Tag>}
          delay="0.2s"
        />
        <IconRow
          icon={<Megaphone aria-hidden="true" className={GLYPH} strokeWidth={1.9} />}
          label="Shift $2K/mo to Google Ads"
          trailing={<Tag>Budget</Tag>}
          delay="0.7s"
        />
        <IconRow
          icon={<FileText aria-hidden="true" className={GLYPH} strokeWidth={1.9} />}
          label="Publish 3 posts a week"
          trailing={<Tag>Content</Tag>}
          delay="1.2s"
        />
      </ul>
    </CardShell>
  );
}

const RECOMMENDATIONS: [string, string, string][] = [
  ["Fix mobile checkout", "Conversion", "0s"],
  ["Add schema to 34 products", "SEO", "0.5s"],
  ["Shift $2K to Google Ads", "Ads", "1s"],
  ["Publish 3 posts this week", "Content", "1.5s"],
];

function RecommendationsCard() {
  return (
    <CardShell
      icon={<FileText aria-hidden="true" className="h-5 w-5" />}
      title="Recommendations"
      meta={
        <>
          <GreenDot />4 ready
        </>
      }
    >
      <ul className="-my-1 flex flex-col">
        {RECOMMENDATIONS.map(([label, metric, delay]) => (
          <li key={label} className="flex items-center gap-3 border-b border-black/[0.06] py-2.5 last:border-b-0">
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#0e0f11]">{label}</span>
            <span className="hidden shrink-0 items-center rounded-full bg-[#f5faf8] px-2 py-1 text-[13px] font-semibold tabular-nums text-[#167f50] sm:inline-flex">
              {metric}
            </span>
            <span className="relative flex h-8 w-[92px] shrink-0 items-center justify-end">
              <span
                className="zavi-ap-hide absolute right-0 inline-flex min-h-8 items-center rounded-full bg-[#0e0f11] px-3.5 text-[13px] font-semibold text-white"
                style={{ animationDelay: delay }}
              >
                Apply
              </span>
              <span
                className="zavi-ap-show absolute right-0 inline-flex items-center gap-1 rounded-full px-2 text-[13px] font-semibold text-[#167f50]"
                style={{ animationDelay: delay }}
              >
                <Check aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
                Applied
              </span>
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

type Step = { tab: string; title: string; body: string; card: ReactNode };

const STEPS: Step[] = [
  {
    tab: "Enter your website",
    title: "Enter your website",
    body: "Zavi starts understanding your business.",
    card: <WebsiteCard />,
  },
  {
    tab: "Zavi makes your growth plan",
    title: "Zavi makes your growth plan",
    body: "Zavi finds what is slowing your business down and makes a plan.",
    card: <PlanCard />,
  },
  {
    tab: "Zavi does the work",
    title: "Zavi puts your plan into action",
    body: "Zavi finds the work and gets it done.",
    card: <RecommendationsCard />,
  },
];

export function GrowthThreeSteps() {
  const [active, setActive] = useState(0);
  const reduced = usePrefersReducedMotion();
  const rail = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (reduced) return;
    const t = window.setTimeout(() => setActive((a) => (a + 1) % STEPS.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [active, reduced]);

  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  const programmatic = useRef(false);
  const settling = useRef<number | null>(null);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const place = () => {
      const tab = el.querySelector<HTMLElement>(`#how-tab-${active}`);
      if (!tab) return;
      setThumb({ x: tab.offsetLeft, w: tab.offsetWidth });
      if (el.scrollWidth > el.clientWidth) {
        const left = railTarget(tab.offsetLeft, tab.clientWidth, el.clientWidth, el.scrollWidth);
        if (Math.abs(left - el.scrollLeft) > 1) {
          programmatic.current = true;
          el.scrollTo({ left, behavior: reduced ? "auto" : "smooth" });
        }
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, reduced]);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const onScroll = () => {
      if (settling.current !== null) window.clearTimeout(settling.current);
      settling.current = window.setTimeout(() => {
        settling.current = null;
        if (programmatic.current) {
          programmatic.current = false;
          return;
        }
        const tabs = [...el.querySelectorAll<HTMLElement>("[id^='how-tab-']")];
        const centres = tabs.map((t) => t.offsetLeft + t.offsetWidth / 2);
        const landed = nearestTab(centres, el.scrollLeft + el.clientWidth / 2);
        if (landed !== null) setActive(landed);
      }, SETTLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (settling.current !== null) window.clearTimeout(settling.current);
    };
  }, []);

  const step = STEPS[active];

  return (
    <div className="px-3 sm:px-6">
      {}
      <section className="w-full pb-0 pt-6 text-[#0e0f11]">
        <div className="w-full bg-[#f6f6f7] px-6 py-14 sm:px-10 lg:px-14 lg:py-20">
          <div className="mx-auto max-w-[760px] text-center">
            {}
            <h2 className="text-[clamp(1.6rem,3.4vw,2.5rem)] font-bold leading-[1.1] tracking-[-0.02em] text-[#0e0f11] sm:whitespace-nowrap">
              {HEADING}
            </h2>
            <p className="mx-auto mt-5 max-w-[60ch] text-[16px] leading-relaxed text-[#595959]">{SUBHEAD}</p>
          </div>

          <div className="mx-auto mt-12 max-w-[1120px] lg:mt-16">
            <div
              ref={rail}
              role="tablist"
              aria-label="How it works"
              className="hide-scrollbar relative mx-auto flex w-full max-w-[860px] snap-x snap-mandatory overflow-x-auto rounded-full bg-black/[0.04] p-1.5 lg:gap-2 lg:overflow-x-visible"
            >
              {thumb && (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-1.5 left-0 top-1.5 rounded-full bg-white shadow-[0_1px_2px_rgba(16,18,20,0.08)] ${
                    reduced ? "" : "transition-[transform,width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  }`}
                  style={{ width: thumb.w, transform: `translate3d(${thumb.x}px,0,0)` }}
                />
              )}
              {STEPS.map((s, i) => {
                const isActive = i === active;
                return (
                  <button
                    key={s.tab}
                    id={`how-tab-${i}`}
                    role="tab"
                    type="button"
                    aria-selected={isActive}
                    aria-controls="how-panel"
                    onClick={() => setActive(i)}
                    className={`relative z-10 flex w-full shrink-0 snap-center items-center justify-center gap-2.5 overflow-hidden rounded-full px-4 py-2.5 text-[14px] font-semibold transition-colors duration-300 lg:w-auto lg:flex-1 lg:shrink ${
                      isActive ? "text-[#0e0f11]" : "text-[#595959] hover:text-[#0e0f11]"
                    } ${thumb ? "" : isActive ? "bg-white shadow-[0_1px_2px_rgba(16,18,20,0.08)]" : ""}`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors duration-300 ${
                        isActive ? "bg-[#0e0f11] text-white" : "bg-black/[0.08] text-[#595959]"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="whitespace-nowrap">{s.tab}</span>
                    {isActive && !reduced && (
                      <span
                        key={active}
                        aria-hidden="true"
                        className="zavi-how-progress absolute inset-x-4 bottom-0 h-0.5 origin-left rounded-full bg-[#027bff] lg:inset-x-0 lg:rounded-none"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-14 grid items-start gap-10 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-14">
              <div>
                <h3 className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-[#0e0f11] sm:text-[28px]">
                  {step.title}
                </h3>
                <p className="mt-4 max-w-[42ch] text-[16px] leading-relaxed text-[#595959]">{step.body}</p>
              </div>
              <div id="how-panel" role="tabpanel" aria-labelledby={`how-tab-${active}`} className="relative min-h-[360px] min-w-0">
                {}
                <div key={active} className="zavi-how-fade w-full">
                  {step.card}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
