
type Testimonial = { quote: string; name: string; role: string };

const ROW_ONE: Testimonial[] = [
  {
    quote:
      "The GEO report alone was worth paying attention to. We started showing up in ChatGPT answers within three weeks.",
    name: "Priya",
    role: "Founder, home-services business",
  },
  {
    quote:
      "It's genuinely impressive. Reddit threads, SEO gaps, site performance, all in one place, with the fix already drafted.",
    name: "Marcus",
    role: "Head of Growth, B2B SaaS",
  },
  {
    quote:
      "It replaced the fractional CMO we were paying $6k a month. Every Monday I get what changed and what needs a yes.",
    name: "Elena",
    role: "CEO, car rental company",
  },
  {
    quote:
      "We killed our external agency and use Zavi to run marketing, SEO and AEO. Nothing ships without our approval, which is the point.",
    name: "Tom",
    role: "Co-founder, DTC skincare",
  },
  {
    quote: "It saves me about 100 minutes a day. The daily digest is the first thing I read.",
    name: "Sol",
    role: "Solo founder, dev tools",
  },
];

const ROW_TWO: Testimonial[] = [
  {
    quote:
      "Still getting up to speed, but the specificity of the recommendations has been stellar. It reads our numbers, not a template.",
    name: "Shizan",
    role: "Marketing lead, HR software",
  },
  {
    quote:
      "For anyone trying to get early traction on a side project, this is the leverage I was waiting for.",
    name: "Krishna",
    role: "Indie hacker",
  },
  {
    quote: "Connected Meta and Google in two clicks. First budget move paid for the year.",
    name: "Amara",
    role: "Owner, boutique travel agency",
  },
  {
    quote:
      "The research docs it writes before touching anything are better than the ones our last agency delivered after a month.",
    name: "Daniel",
    role: "Founder, rental business",
  },
  {
    quote:
      "Plain-English proposals with the money either way. My co-founder actually reads them now.",
    name: "Yuki",
    role: "COO, tutoring company",
  },
];

const TESTIMONIALS: Testimonial[] = [...ROW_ONE, ...ROW_TWO];

function QuoteCard({ t }: { t: Testimonial }) {
  return (
    <figure className="flex h-full w-[320px] shrink-0 flex-col justify-between rounded-[20px] border border-black/[0.08] bg-white p-6 shadow-[0_1px_2px_rgba(16,18,20,0.04)] sm:w-[380px]">
      <blockquote className="text-[16px] leading-relaxed text-[#1f1f1f]">
        &ldquo;{t.quote}&rdquo;
      </blockquote>
      <figcaption className="mt-8 flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e6f2ff] text-[16px] font-bold text-[#027bff]"
        >
          {t.name.charAt(0)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-[#0e0f11]">{t.name}</span>
          <span className="block truncate text-[16px] text-[#595959]">{t.role}</span>
        </span>
      </figcaption>
    </figure>
  );
}

function DriftRow({ items, direction }: { items: Testimonial[]; direction: "left" | "right" }) {
  const loop = [...items, ...items];
  return (
    <div className="zavi-drift-row zavi-logo-marquee-mask w-full overflow-hidden">
      <ul
        className={`flex w-max items-stretch gap-4 pr-4 ${
          direction === "left" ? "zavi-drift-left" : "zavi-drift-right"
        }`}
      >
        {loop.map((t, i) => (
          <li key={`${t.name}-${i}`} aria-hidden={i >= items.length} className="flex">
            <QuoteCard t={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GrowthWallOfLove({ large = false }: { large?: boolean }) {
  const section = (
    <section className="w-full overflow-hidden py-16 text-[#0e0f11] lg:py-20">
      <div className="mx-auto max-w-[760px] px-6 text-center">
        <h2
          className={`flex items-center justify-center gap-[0.35em] font-bold text-black ${
            large
              ? "text-[clamp(2.5rem,6vw,4.5rem)] leading-none tracking-[-0.03em]"
              : "text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.12] tracking-[-0.02em]"
          }`}
        >
          Wall of Love
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="#ff2d3d"
            stroke="#ff2d3d"
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[0.62em] w-[0.62em]"
          >
            <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
          </svg>
        </h2>
      </div>
      {large ? (
        <div className="mt-12 flex flex-col gap-4 lg:mt-14">
          <DriftRow items={ROW_ONE} direction="left" />
          <DriftRow items={ROW_TWO} direction="right" />
        </div>
      ) : (
        <div className="mt-12 lg:mt-14">
          <DriftRow items={TESTIMONIALS} direction="left" />
        </div>
      )}
    </section>
  );

  return large ? section : <div className="px-3 sm:px-6">{section}</div>;
}
