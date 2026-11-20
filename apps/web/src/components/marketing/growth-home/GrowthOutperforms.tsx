
import { StepGlyph } from "./stepIcons";

type Reason = {
  n: string;
  title: string;
  points: [string, string][];
  logos?: string[];
  logoCols?: 1 | 2;
};

const ROW_ONE: Reason[] = [
  {
    n: "01",
    title: "Built on insider platform knowledge",
    points: [
      ["We work with ex-Google and Meta Ads engineers", "#00d294"],
      ["Our AI knows exactly how the algorithms work", "#a685ff"],
    ],
    logos: ["Google Ads", "Meta Ads"],
    logoCols: 1,
  },
  {
    n: "02",
    title: "Recipes from a real business",
    points: [
      ["Each channel's playbook was tuned running Upcar", "#fcbb00"],
      ["Purpose-built for marketing tasks", "#fb64b6"],
    ],
  },
];

const ROW_TWO: Reason[] = [
  {
    n: "03",
    title: "You approve every change",
    points: [
      ["Drafts the change and waits for your yes", "#00bcfe"],
      ["Nothing goes live without you", "#ec6cff"],
    ],
  },
  {
    n: "04",
    title: "Works across every platform",
    points: [
      ["Google, Meta, TikTok, LinkedIn, Microsoft Ads, one place", "#ff8b1a"],
      ["One AI that speaks every ad platform's language", "#00d2ef"],
    ],
    logos: ["Google Ads", "Meta Ads", "TikTok", "LinkedIn", "Reddit", "YouTube"],
    logoCols: 2,
  },
];

function ReasonCard({ r }: { r: Reason }) {
  return (
    <li className="flex items-center gap-5 rounded-[20px] border border-[#e4e4e7]/80 bg-white p-6 sm:gap-6">
      <span
        aria-hidden="true"
        className="w-14 shrink-0 text-[44px] font-medium leading-none tabular-nums text-[#e4e4e7] sm:w-20 sm:text-[52px]"
      >
        {r.n}
      </span>
      <span aria-hidden="true" className="w-px self-stretch bg-[#e4e4e7]" />
      <div className="min-w-0 flex-1">
        <h3 className="text-[20px] font-semibold leading-snug tracking-[-0.01em] text-black sm:text-[22px]">
          {r.title}
        </h3>
        <ul className="mt-2 space-y-1.5">
          {r.points.map(([text, color]) => (
            <li key={text} className="flex items-start gap-2 text-[14px] text-[#71717b]">
              <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0" style={{ background: color }} />
              {text}
            </li>
          ))}
        </ul>
      </div>
      {r.logos && (
        <div
          aria-hidden="true"
          className={`hidden shrink-0 gap-3 sm:grid ${r.logoCols === 2 ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {r.logos.map((name) => (
            <StepGlyph key={name} name={name} className="h-7 w-7" />
          ))}
        </div>
      )}
    </li>
  );
}

export function GrowthOutperforms() {
  return (
    <section className="w-full bg-white py-20 text-[#0e0f11] lg:py-28">
      <div className="mx-auto max-w-[1400px] px-6 lg:px-10">
        <h2 className="text-center text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.12] tracking-[-0.02em] text-black">
          Why Zavi outperforms
        </h2>
        <ol className="mt-12 grid gap-2 md:grid-cols-2 lg:mt-16">
          {ROW_ONE.map((r) => (
            <ReasonCard key={r.n} r={r} />
          ))}
        </ol>
        <ol start={3} className="mt-2 grid gap-2 md:grid-cols-[2fr_3fr]">
          {ROW_TWO.map((r) => (
            <ReasonCard key={r.n} r={r} />
          ))}
        </ol>
      </div>
    </section>
  );
}
