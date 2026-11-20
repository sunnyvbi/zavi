import type { Metadata } from "next";
import Link from "next/link";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { FaqStructuredData } from "@/components/marketing/StructuredData";
import { ABOUT_FAQ } from "@/components/marketing/aboutFaq";
import { COMPARISONS, pathForComparison } from "@/lib/marketing/comparisons";

export const metadata: Metadata = marketingPageMetadata(
  "/about",
  "About Zavi: AI Growth Agent For Your Business | Zavi",
  "Zavi is an AI growth agent for your business, built by Zavi Labs. It reads your business, writes the growth plan, runs the channels with your approval, and tells you what changed.",
);

const SECTIONS: Array<{ h: string; body: string[] }> = [
  {
    h: "What Zavi is",
    body: [
      "Zavi is an AI growth agent for your business. It reads your business first (your site, and your data when you connect it), then drafts a growth plan: the goal that matters, what is most likely holding growth back, and the channels to bet on. You correct the plan. Zavi runs the channels with your approval, keeps adjusting as results come in, and leaves you a note on what it saw, what it changed and what it needs from you. When the evidence is thin, it labels its read a best guess.",
      "The work is the everyday growth work a team or an agency would do: experiments, paid ads, content, SEO and AI-search visibility, email, and drafted fixes to your website.",
    ],
  },
  {
    h: "What an AI growth agent is, and is not",
    body: [
      "An AI growth agent takes a growth goal and does the work to move it: it works out what is most likely holding the number back, proposes the work, does it with your approval, and reports what moved.",
      "It is not a content generator that publishes on a schedule, an ad-buying bot that spends with no limit you set, or a chat assistant that only writes drafts. And it reports what moved without claiming credit for every change.",
    ],
  },
  {
    h: "How you stay in control",
    body: [
      "By default Zavi asks before it publishes or spends, in plain English with the numbers behind it. You can let it act on its own inside limits you set, such as an ad budget or an ads spend cap; anything outside them still waits for you.",
    ],
  },
  {
    h: "Built on a real company",
    body: [
      "Zavi was battle-tested on Upcar, a live peer-to-peer car rental marketplace, so its growth playbooks come from real operating data rather than a synthetic demo. You can watch Zavi run Upcar's growth in public.",
    ],
  },
  {
    h: "Who builds Zavi",
    body: [
      "Zavi is built by Zavi Labs. Zavi at zaviagent.com is not the Zavi AI voice-typing keyboard, the ZAVI (Zen AI Visibility) SEO tool, the Zavvi entertainment retailer, or the musician Zavi.",
    ],
  },
  {
    h: "Pricing",
    body: [
      "Zavi is free to start: you get free credits every day, with no credit card and no sales call. Paid plans add a monthly credit pool for bigger work.",
    ],
  },
];

const FIVE_QUESTIONS = [
  "Does it read your business and bring you a plan, or wait for you to tell it what to do?",
  "What does it do without asking, and can you set the limits?",
  "Does it read your real data, and does it tell you when its read is a guess?",
  "Does it show you what moved, and is honest about how sure it is of why?",
  "Will it tell you plainly what it cannot do yet?",
];

export default async function AboutPage() {
  const { cta, email } = await resolveMarketingSession();

  return (
    <main
      className={`${jakarta.variable} min-h-screen bg-white font-[family-name:var(--font-jakarta)] text-ink selection:bg-ink selection:text-white`}
    >
      <FaqStructuredData path="/about" items={ABOUT_FAQ} />
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <article className="mx-auto w-full max-w-[760px] px-4 pb-16 pt-6 md:pb-24 md:pt-10">
        <p className="text-[13px] uppercase tracking-[2px] text-[#191919]">About</p>
        <h1 className="pt-2 text-[32px] font-semibold leading-[1.1] tracking-[-0.83px] text-[#191919] md:text-[44px]">
          Zavi: AI Growth Agent For Your Business
        </h1>
        <p className="pt-4 text-[18px] leading-[28px] text-[#595959]">
          Zavi reads your business, writes the growth plan and runs the channels with your
          approval.
        </p>

        {SECTIONS.map((s) => (
          <section key={s.h} className="pt-10">
            <h2 className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
              {s.h}
            </h2>
            {s.body.map((p) => (
              <p key={p.slice(0, 32)} className="pt-3 text-[16px] leading-[26px] text-[#0e0f11] md:text-[18px] md:leading-[28px]">
                {p}
              </p>
            ))}
          </section>
        ))}

        <section aria-labelledby="five-questions" className="pt-10">
          <h2 id="five-questions" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
            Five questions to ask any AI growth agent
          </h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-[16px] leading-[26px] text-[#0e0f11] md:text-[18px] md:leading-[28px]">
            {FIVE_QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="about-faq" className="pt-10">
          <h2 id="about-faq" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
            Questions
          </h2>
          <dl className="mt-3 space-y-5">
            {ABOUT_FAQ.map((f) => (
              <div key={f.q}>
                <dt className="text-[16px] font-semibold text-[#0e0f11] md:text-[18px]">{f.q}</dt>
                <dd className="pt-1 text-[16px] leading-[26px] text-[#0e0f11] md:text-[18px] md:leading-[28px]">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="compare" className="pt-10">
          <h2 id="compare" className="text-[22px] font-semibold tracking-[-0.3px] text-[#0e0f11] md:text-[26px]">
            How Zavi compares
          </h2>
          <ul className="mt-3 space-y-2 text-[16px] md:text-[18px]">
            {COMPARISONS.map((c) => (
              <li key={c.slug}>
                <Link href={pathForComparison(c.slug)} className="underline underline-offset-4 hover:opacity-70">
                  {c.h1}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <nav aria-label="More about Zavi" className="flex flex-wrap gap-x-6 gap-y-3 pt-10 text-[16px] font-semibold">
          <Link href="/live/upcar" className="underline underline-offset-4 hover:opacity-70">
            Watch Zavi run Upcar live
          </Link>
          <Link href="/pricing" className="underline underline-offset-4 hover:opacity-70">
            See pricing
          </Link>
          <Link href="/support" className="underline underline-offset-4 hover:opacity-70">
            Get support
          </Link>
        </nav>
      </article>

      <GrowthFooter startHref="/start" />
    </main>
  );
}
