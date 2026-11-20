"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Check, Clock, Megaphone, PenLine, Search, Share2 } from "lucide-react";
import { StepGlyph } from "./stepIcons";

const HEADING = "Why teams pick Zavi";
const SUBHEAD = "Zavi analyzes your business, plans what to do next, and puts that plan into action.";

const CHANNEL_MS = 3600;

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

const CHANNEL_MARKS: { name: string; color?: string }[] = [
  { name: "Meta Ads" },
  { name: "Google Ads" },
  { name: "Instagram" },
  { name: "X" },
  { name: "LinkedIn" },
  { name: "Reddit" },
  { name: "TikTok" },
  { name: "YouTube" },
  { name: "UGC Videos", color: "#e11d48" },
  { name: "SEO", color: "#027bff" },
  { name: "GEO", color: "#7c3aed" },
];

function ChannelTiles() {
  return (
    <div aria-hidden="true" className="flex max-w-[200px] flex-wrap items-center justify-center gap-2">
      {CHANNEL_MARKS.map((m, i) => (
        <span
          key={m.name}
          className="zavi-wt-glow flex h-9 w-9 items-center justify-center rounded-xl border border-black/[0.07] bg-white shadow-[0_6px_16px_-10px_rgba(16,18,20,0.35)]"
          style={{ animationDelay: `${(i * 0.12).toFixed(2)}s` }}
        >
          <StepGlyph name={m.name} color={m.color} className="h-[17px] w-[17px]" />
        </span>
      ))}
    </div>
  );
}

const ACCENT_02 = "#9b5de5";

type Channel = {
  label: string;
  icon: ReactNode;
  task: string;
  metric: string;
  note: string;
};

const CHANNELS: Channel[] = [
  {
    label: "Content channel",
    icon: <PenLine aria-hidden="true" className="h-3.5 w-3.5" />,
    task: "Drafting: “Linen shirts”",
    metric: "Draft ready",
    note: "3 headlines to pick from",
  },
  {
    label: "Ads channel",
    icon: <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />,
    task: "Testing 4 new creatives",
    metric: "Awaiting approval",
    note: "Budget change proposed",
  },
  {
    label: "Social channel",
    icon: <Share2 aria-hidden="true" className="h-3.5 w-3.5" />,
    task: "Scheduling 12 posts",
    metric: "Queued",
    note: "Posts after you approve",
  },
  {
    label: "SEO channel",
    icon: <Search aria-hidden="true" className="h-3.5 w-3.5" />,
    task: "Fixing 9 meta titles",
    metric: "Fix ready",
    note: "Titles rewritten for search",
  },
];

function ChannelCard({ reduced }: { reduced: boolean }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const t = window.setTimeout(() => setI((n) => (n + 1) % CHANNELS.length), CHANNEL_MS);
    return () => window.clearTimeout(t);
  }, [i, reduced]);

  const c = CHANNELS[i];
  const accent: CSSProperties = { background: ACCENT_02 };

  return (
    <div
      aria-hidden="true"
      className="w-[224px] rounded-2xl border border-black/[0.07] bg-white p-3.5 shadow-[0_12px_30px_-18px_rgba(16,18,20,0.35)]"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-[8px] text-white" style={accent}>
          {c.icon}
        </span>
        {}
        <span key={`l${i}`} className="zavi-wt-fade text-[12px] font-semibold text-[#0e0f11]">
          {c.label}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {[0, 0.18, 0.36].map((d) => (
            <span
              key={d}
              className="zavi-wt-bounce h-1.5 w-1.5 rounded-full"
              style={{ ...accent, animationDelay: `${d}s` }}
            />
          ))}
        </span>
      </div>
      <p key={`t${i}`} className="zavi-wt-fade mt-3 truncate text-[13px] font-medium text-[#0e0f11]">
        {c.task}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08]">
        <span key={`p${i}`} className="zavi-wt-progress block h-full rounded-full" style={accent} />
      </div>
      <div key={`m${i}`} className="zavi-wt-reveal mt-3 flex items-center gap-2">
        <span className="flex items-center gap-1 rounded-full bg-[#f5faf8] px-2 py-1 text-[11px] font-semibold text-[#167f50]">
          <Check aria-hidden="true" className="h-3 w-3" />
          {c.metric}
        </span>
        <span className="text-[11px] font-medium text-[#595959]">{c.note}</span>
      </div>
    </div>
  );
}

const ACCENT_03 = "#d99a00";
const HOURS = ["12a", "6a", "12p", "6p", "12a"];

function AlwaysOnCard() {
  return (
    <div
      aria-hidden="true"
      className="w-[224px] rounded-2xl border border-black/[0.07] bg-white p-3.5 shadow-[0_12px_30px_-18px_rgba(16,18,20,0.35)]"
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-[8px] text-white"
          style={{ background: ACCENT_03 }}
        >
          <Clock aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <span className="text-[12px] font-semibold text-[#0e0f11]">Goal check</span>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-[#f5faf8] px-2 py-0.5 text-[11px] font-semibold text-[#167f50]">
          <span className="zavi-wt-pulse h-1.5 w-1.5 rounded-full bg-[#167f50]" /> Scheduled
        </span>
      </div>
      <p className="mt-3 text-[13px] font-medium text-[#0e0f11]">Reviewing your numbers</p>
      <div
        className="relative mt-2 h-7 overflow-hidden rounded-[8px] bg-[#f9f9f9]"
        style={{
          backgroundImage: "repeating-linear-gradient(90deg, rgba(16,18,20,0.06) 0 1px, transparent 1px 25%)",
        }}
      >
        <span
          className="zavi-wt-sweep absolute bottom-0 top-0 w-[3px] rounded-full"
          style={{ background: ACCENT_03 }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] font-medium tabular-nums text-[#595959]">
        {HOURS.map((h, i) => (
          <span key={`${h}-${i}`}>{h}</span>
        ))}
      </div>
    </div>
  );
}

const CARDS = [
  { n: "01", title: "Works on all growth channels", number: "text-[#f06a35]/80", hover: "hover:border-[#f06a35]/35" },
  { n: "02", title: "Each channel has its own playbook", number: "text-[#9b5de5]/80", hover: "hover:border-[#9b5de5]/35" },
  { n: "03", title: "It checks in on your goal", number: "text-[#d99a00]/80", hover: "hover:border-[#d99a00]/35" },
];

export function GrowthWhyTeams() {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "-10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const media = [<ChannelTiles key="tiles" />, <ChannelCard key="channel" reduced={reduced} />, <AlwaysOnCard key="always" />];

  return (
    <div className="px-3 sm:px-6">
      {}
      <section id="use-cases" className="w-full scroll-mt-28 bg-white py-20 lg:py-28">
        <div className="mx-auto max-w-[1400px] px-6 lg:px-10">
          <div className="mx-auto max-w-[760px] text-center">
            <h2 className="text-[clamp(2rem,4.6vw,42px)] font-bold leading-[1.12] tracking-[-0.02em] text-black">
              {HEADING}
            </h2>
            <p className="mx-auto mt-5 max-w-[52ch] text-[16px] leading-relaxed text-zinc-600">{SUBHEAD}</p>
          </div>

          <ol ref={ref} className="mx-auto mt-14 grid max-w-[1000px] gap-4 sm:grid-cols-2 lg:mt-20 lg:grid-cols-3">
            {CARDS.map((card, i) => (
              <li
                key={card.n}
                style={{ transitionDelay: shown ? `${(i + 1) * 90}ms` : "0ms" }}
                className={`group flex flex-col rounded-block border border-zinc-200/80 bg-white p-6 transition-[transform,box-shadow,border-color,opacity] duration-500 ease-out hover:-translate-y-1 hover:shadow-[0_12px_36px_rgba(16,18,20,0.09)] ${card.hover} ${
                  shown ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    aria-hidden="true"
                    className={`text-[20px] font-bold tabular-nums tracking-[0.14em] ${card.number}`}
                  >
                    {card.n}
                  </span>
                </div>
                <h3 className="mt-5 text-[20px] font-semibold leading-snug tracking-[-0.01em] text-black">
                  {card.title}
                </h3>
                <div className="relative mt-6 flex min-h-[160px] flex-1 items-center justify-center overflow-hidden rounded-[16px] bg-[#f2f2f4]">
                  <div className="relative z-10 transition-transform duration-300 group-hover:scale-105">
                    {media[i]}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
