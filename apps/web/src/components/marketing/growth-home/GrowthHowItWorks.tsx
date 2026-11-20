"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { ArrowDown, CalendarDays, FileText } from "lucide-react";
import { StepGlyph } from "./stepIcons";

type DocSection = { heading: string; style: "bullets" | "lines" };
type StrategyDoc = { tab: string; title: string; meta: string; sections: DocSection[] };

const DOCS: StrategyDoc[] = [
  {
    tab: "Business Profile",
    title: "Product Information",
    meta: "Generated today · Sources: 24 pages",
    sections: [
      { heading: "Overview", style: "bullets" },
      { heading: "What It Does", style: "lines" },
      { heading: "Product Category", style: "bullets" },
      { heading: "Target Customers", style: "lines" },
      { heading: "Business Model", style: "bullets" },
    ],
  },
  {
    tab: "Marketing Strategy",
    title: "Marketing Strategy",
    meta: "Generated today · Sources: your site, 3 channels",
    sections: [
      { heading: "Goals", style: "bullets" },
      { heading: "Positioning", style: "lines" },
      { heading: "Messaging", style: "bullets" },
      { heading: "Funnel", style: "lines" },
      { heading: "Measurement", style: "bullets" },
    ],
  },
  {
    tab: "Marketing Channels",
    title: "Marketing Channels",
    meta: "Generated today · Sources: 3 connected channels",
    sections: [
      { heading: "Paid", style: "bullets" },
      { heading: "Organic", style: "bullets" },
      { heading: "Owned", style: "lines" },
      { heading: "Emerging", style: "bullets" },
      { heading: "Priorities", style: "lines" },
    ],
  },
  {
    tab: "Growth Plan",
    title: "Growth Plan",
    meta: "Generated today · Horizon: 12 months",
    sections: [
      { heading: "Objectives", style: "bullets" },
      { heading: "Levers", style: "lines" },
      { heading: "Budget Split", style: "bullets" },
      { heading: "First 90 Days", style: "lines" },
      { heading: "Milestones", style: "bullets" },
    ],
  },
  {
    tab: "Content Strategy",
    title: "Content Strategy",
    meta: "Generated today · Sources: 24 pages, 2 competitors",
    sections: [
      { heading: "Pillars", style: "bullets" },
      { heading: "Formats", style: "bullets" },
      { heading: "SEO", style: "lines" },
      { heading: "Cadence", style: "bullets" },
      { heading: "Distribution", style: "lines" },
    ],
  },
  {
    tab: "Brand Voice",
    title: "Brand Voice",
    meta: "Generated today · Sources: your site, social posts",
    sections: [
      { heading: "Tone", style: "lines" },
      { heading: "Do", style: "bullets" },
      { heading: "Don't", style: "bullets" },
      { heading: "Vocabulary", style: "lines" },
      { heading: "Examples", style: "bullets" },
    ],
  },
  {
    tab: "Competitor Analysis",
    title: "Competitor Analysis",
    meta: "Generated today · Sources: 6 competitors",
    sections: [
      { heading: "Landscape", style: "lines" },
      { heading: "Where They Win", style: "bullets" },
      { heading: "Gaps To Exploit", style: "bullets" },
      { heading: "Pricing", style: "lines" },
      { heading: "Positioning Map", style: "bullets" },
    ],
  },
];

const TAB_ROTATE = [-3, 2.5, -1.5, 3, -2.5, 1.5, -2];
const TAB_SHIFT_Y = [2, -8, 6, -4, 8, -6, 3];

const BULLET_WIDTHS = [
  [46, 58, 34],
  [42, 60, 38, 52],
  [30, 66, 58],
];
const LINE_WIDTHS = [
  [100, 96, 100, 92, 62],
  [100, 100, 74],
  [98, 100, 88, 54],
];
const SKELETON_COUNT = [1, 2, 1, 3, 2];

function SkeletonBody({ section, index }: { section: DocSection; index: number }) {
  const count = SKELETON_COUNT[index] ?? 2;
  if (section.style === "bullets") {
    return (
      <ul className="mt-3 flex flex-col gap-2.5">
        {BULLET_WIDTHS[index % BULLET_WIDTHS.length].slice(0, count).map((w, i) => (
          <li key={i} className="flex items-center gap-3">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-black/[0.18]" />
            <span className="h-2.5 rounded-full bg-black/[0.08]" style={{ width: `${w}%` }} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2">
      {LINE_WIDTHS[index % LINE_WIDTHS.length].slice(0, count).map((w, i) => (
        <span key={i} className="block h-2.5 rounded-full bg-black/[0.08]" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function ResearchStep() {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const doc = DOCS[active];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next =
      e.key === "ArrowRight" ? (active + 1) % DOCS.length : (active - 1 + DOCS.length) % DOCS.length;
    setActive(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Strategy documents"
        onKeyDown={onKeyDown}
        className="mx-auto mt-8 flex max-w-[900px] flex-wrap justify-center gap-x-3 gap-y-5 px-2 py-3"
      >
        {DOCS.map((d, i) => {
          const selected = i === active;
          return (
            <span
              key={d.tab}
              className="inline-block"
              style={{ transform: `rotate(${TAB_ROTATE[i]}deg) translateY(${TAB_SHIFT_Y[i]}px)` }}
            >
              <button
                id={`${baseId}-tab-${i}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(i)}
                className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl border px-4 text-[16px] font-semibold transition-[transform,background-color,color,box-shadow] duration-200 hover:-translate-y-0.5 hover:scale-[1.03] ${
                  selected
                    ? "scale-[1.04] border-[#0e0f11] bg-[#0e0f11] text-white shadow-[0_10px_24px_-10px_rgba(16,18,20,0.5)]"
                    : "border-black/[0.10] bg-white text-[#1f1f1f] shadow-[0_2px_6px_rgba(16,18,20,0.06)] hover:bg-black/[0.02]"
                }`}
              >
                <FileText
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 ${selected ? "text-white/80" : "text-[#595959]"}`}
                />
                {d.tab}
              </button>
            </span>
          );
        })}
      </div>

      <div className="mt-8">
        <div
          key={active}
          id={`${baseId}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${active}`}
          className="zavi-doc-fade mx-auto w-full max-w-[720px] rounded-[20px] border border-black/[0.08] bg-white p-6 shadow-[0_24px_60px_-28px_rgba(16,18,20,0.25)] sm:p-8"
        >
          <p className="text-[24px] font-bold leading-tight tracking-[-0.01em] text-[#0e0f11]">
            {doc.title}
          </p>
          <p className="mt-2 flex items-center gap-2 text-[16px] text-[#595959]">
            <CalendarDays aria-hidden="true" className="h-4 w-4" />
            {doc.meta}
          </p>
          <div className="mt-7 flex flex-col gap-7">
            {doc.sections.map((s, i) => (
              <div key={s.heading}>
                <p className="text-[16px] font-bold text-[#0e0f11]">{s.heading}</p>
                <SkeletonBody section={s} index={i} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const EXECUTION_CHANNELS = [
  "Meta Ads",
  "Google Ads",
  "SEO",
  "GEO",
  "Reddit",
  "TikTok",
  "UGC Videos",
  "X",
  "LinkedIn",
];
const PUBLISH_TOOLS = [
  "Google Analytics",
  "Google Search Console",
  "Meta Ads",
  "Google Ads",
  "LinkedIn",
  "TikTok",
  "Reddit",
  "X",
  "YouTube",
  "Instagram",
];

function StepConnector({ tall = false }: { tall?: boolean }) {
  return (
    <div aria-hidden="true" className="flex flex-col items-center py-1">
      <span className={`w-0.5 rounded-full bg-black/[0.16] ${tall ? "h-16" : "h-12"}`} />
      <ArrowDown strokeWidth={2.2} className="-mt-2 h-5 w-5 text-black/40" />
    </div>
  );
}

function StepHeading({ step, title, body }: { step: string; title: string; body?: string }) {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col items-center text-center">
      <span className="inline-flex min-h-8 items-center rounded-full border border-black/[0.08] bg-white px-3 text-[16px] font-medium text-[#595959] shadow-[0_1px_2px_rgba(16,18,20,0.04)]">
        {step}
      </span>
      <h3 className="mt-5 text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-[#0e0f11] sm:text-[36px]">
        {title}
      </h3>
      {body && (
        <p className="mx-auto mt-4 max-w-[62ch] text-[16px] leading-relaxed text-[#595959]">{body}</p>
      )}
    </div>
  );
}

function ExecutionStep() {
  return (
    <>
      <StepHeading
        step="Step 2: Execution"
        title="All agents execute the strategy, channel by channel."
        body="Everything a growth team does, drafted from the same documents so nothing drifts off-message. You stay in control: nothing goes live without your approval."
      />
      <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {EXECUTION_CHANNELS.map((name) => (
          <li
            key={name}
            className="flex items-center gap-3 rounded-block border border-black/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(16,18,20,0.04)]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#f9f9f9] text-[#0e0f11]">
              <StepGlyph name={name} className={name === "X" ? "h-4 w-4" : "h-5 w-5"} />
            </span>
            <h4 className="flex min-w-0 items-center gap-2 text-[16px] font-semibold text-[#0e0f11]">
              <span className="truncate">{name}</span>
            </h4>
          </li>
        ))}
      </ul>
    </>
  );
}

function PublishStep() {
  return (
    <>
      <StepHeading step="Step 3: Publish" title="Connect your stack. Publish without leaving it." />
      <ul className="mx-auto mt-10 flex max-w-[980px] flex-wrap justify-center gap-x-3 gap-y-8 sm:gap-x-4">
        {PUBLISH_TOOLS.map((name) => (
          <li key={name} className="flex w-[88px] flex-col items-center text-center sm:w-[112px]">
            <span className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.05)]">
              <StepGlyph name={name} className={name === "X" ? "h-5 w-5" : "h-6 w-6"} />
            </span>
            <span className="mt-3 text-[16px] font-medium leading-snug text-[#595959]">{name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function GrowthHowItWorks() {
  return (
    <div className="px-3 py-4 sm:px-6">
      <div className="mx-auto overflow-hidden rounded-blockLg border border-[#e6eaef] bg-[#f8fafc]">
        <section className="w-full py-6 text-[#0e0f11]">
          <div className="w-full bg-[#f6f6f7] px-6 py-14 sm:px-10 lg:px-14 lg:py-20">
            <div className="mx-auto max-w-[760px] text-center">
              <p className="text-[16px] font-semibold uppercase tracking-[0.12em] text-[#595959]">
                Step 1: Research
              </p>
              <h2 className="mt-4 text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.12] tracking-[-0.02em] text-[#0e0f11]">
                Zavi researches and prepares all strategy documents first
              </h2>
            </div>
            <div className="mx-auto mt-2 max-w-[1100px]">
              <ResearchStep />
              <StepConnector />
              <ExecutionStep />
              <StepConnector tall />
              <PublishStep />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
