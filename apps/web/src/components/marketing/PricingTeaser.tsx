
import Link from "next/link";

type Tier = {
  name: string;
  price: string;
  pitch: string;
  bullets: string[];
  cta: { label: string; href: string };
  tone: "default" | "featured" | "ink";
};

const TIERS: Tier[] = [
  {
    name: "Starter",
    price: "$50/mo",
    pitch: "The whole team, 20,000 credits a month.",
    bullets: [
      "All agents included",
      "20,000 credits / mo",
      "Whole team shares them",
    ],
    cta: { label: "Get Starter", href: "/pricing" },
    tone: "default",
  },
  {
    name: "Growth",
    price: "$200/mo",
    pitch: "More room to run: 80,000 credits a month.",
    bullets: [
      "All agents included",
      "80,000 credits / mo",
      "No per-seat fees",
    ],
    cta: { label: "Get Growth", href: "/pricing" },
    tone: "featured",
  },
  {
    name: "Scale",
    price: "$750/mo",
    pitch: "Heavy, always-on usage: 300,000 credits a month.",
    bullets: [
      "All agents included",
      "300,000 credits / mo",
      "Top-ups never expire",
    ],
    cta: { label: "Get Scale", href: "/pricing" },
    tone: "ink",
  },
];

export function PricingTeaser() {
  return (
    <section aria-label="Pricing" className="bg-cream">
      <div className="mx-auto max-w-[1240px] px-6 md:px-10 py-14 md:py-20">
        <div className="max-w-[760px] mb-8 md:mb-10">
          <div className="kicker text-violet">Pricing</div>
          <h2 className="mt-2 font-display font-semibold text-[28px] md:text-[36px] leading-[1.1] tracking-tighter text-ink">
            Hire an AI growth agent that{" "}
            <span className="italic text-violet">does the work.</span>
          </h2>
          <p className="mt-3 text-[16px] leading-[1.55] text-inkMuted">
            Every plan includes Zavi and its full crew. A human cofounder costs $8,000/mo;
            yours starts at $50, and you only scale up the engineer&apos;s builds. Free to try.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
          {TIERS.map((t) => (
            <TierCard key={t.name} tier={t} />
          ))}
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/pricing"
            className="inline-flex items-center gap-2 text-[16px] font-medium text-inkMuted hover:text-violet transition-colors focus-visible:outline-none focus-visible:underline"
          >
            Full pricing details →
          </Link>
        </div>
      </div>
    </section>
  );
}

function TierCard({ tier }: { tier: Tier }) {
  const isFeatured = tier.tone === "featured";
  const isInk = tier.tone === "ink";
  const card =
    isFeatured
      ? "bg-marigold text-ink border-marigoldDeep"
      : isInk
        ? "bg-ink text-cream border-ink"
        : "bg-cream text-ink border-ink/15";
  const muted = isInk
    ? "text-cream/75"
    : isFeatured
      ? "text-ink/75"
      : "text-inkMuted";
  const strong = isInk ? "text-cream" : "text-ink";
  const ctaCls = isFeatured
    ? "bg-ink text-cream hover:bg-inkSoft"
    : isInk
      ? "bg-cream text-ink hover:bg-bone"
      : "bg-ink text-cream hover:bg-inkSoft";
  const ringOffset = "focus-visible:ring-offset-cream";

  return (
    <article
      className={`flex flex-col rounded-2xl border-[1.5px] p-7 md:p-8 shadow-sm transition-shadow duration-200 hover:shadow-md ${card}`}
    >
      <header className="mb-4">
        <div
          className={`kicker ${
            isInk ? "text-cream/60" : isFeatured ? "text-ink/70" : "text-ink"
          }`}
        >
          {tier.name}
        </div>
        <div className={`mt-3 font-display text-[26px] md:text-[28px] font-semibold tracking-tight ${strong}`}>
          {tier.price}
        </div>
        <p className={`mt-2 text-[16px] leading-[1.5] ${muted}`}>
          {tier.pitch}
        </p>
      </header>

      <ul className={`mb-7 space-y-2 text-[16px] ${muted}`}>
        {tier.bullets.map((b) => (
          <li key={b} className="flex items-baseline gap-2">
            <span aria-hidden className={isInk ? "text-cream" : "text-ink"}>→</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <Link
        href={tier.cta.href}
        target={tier.cta.href.startsWith("http") ? "_blank" : undefined}
        rel={tier.cta.href.startsWith("http") ? "noreferrer" : undefined}
        className={`mt-auto inline-flex items-center justify-between gap-2 rounded-full px-4 py-3 text-[16px] font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 ${ringOffset} ${ctaCls}`}
      >
        <span>{tier.cta.label}</span>
        <span aria-hidden>→</span>
      </Link>
    </article>
  );
}
