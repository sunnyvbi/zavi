import type { Metadata } from "next";
import { jakarta } from "@/fonts";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { BreadcrumbStructuredData } from "@/components/marketing/StructuredData";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { ArrowRight, CreditCard, Link2, Plus, Share2, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { EarningsCalculator } from "./EarningsCalculator";
import { AFFILIATE_PLANS, LATER_RATE, TERMS, firstTwo, laterTen, usd, yearOne } from "./terms";

export const metadata: Metadata = marketingPageMetadata(
  "/affiliates",
  "Affiliate program · Zavi",
  "Earn 100% of a referred customer's first 2 monthly payments, then 30% through month 12. Paid to your bank through Stripe.",
);

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11]";
const BTN_DARK = `inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#0e0f11] px-6 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 ${FOCUS}`;
const BTN_LIGHT = `inline-flex min-h-12 items-center justify-center rounded-full border border-[#0e0f11]/15 bg-white px-6 text-[16px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#0e0f11]/[0.03] ${FOCUS}`;
const H2 = "text-[clamp(1.75rem,4.4vw,2.75rem)] leading-[1.12] font-bold tracking-[-0.02em] text-balance text-[#0e0f11]";
const EYEBROW = "text-[13px] font-semibold tracking-[0.12em] text-[#595959] uppercase";

const APPLY_HREF = "/creators/apply";
const LOGIN_HREF = "/creators/login";

const FACTS = [
  { icon: Wallet, label: "$20 minimum payout" },
  { icon: CreditCard, label: "Paid via Stripe" },
  { icon: Link2, label: "60-day link" },
];

const STEPS = [
  { n: "01", icon: Link2, title: "Get your link", body: "Apply as a Zavi creator. Once approved, your link is in your creator dashboard." },
  { n: "02", icon: Share2, title: "Share it anywhere", body: "Your link works on any page of zaviagent.com. A signup counts for 60 days after the click." },
  { n: "03", icon: Wallet, title: "Earn", body: "100% of their first 2 monthly payments, then 30% through month 12. Paid to your bank through Stripe." },
];

function Section({ id, className = "", children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={`w-full scroll-mt-28 py-14 lg:py-20 ${className}`}>
      <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6 lg:px-10">{children}</div>
    </section>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mx-auto max-w-[680px] text-center">
      <p className={EYEBROW}>{eyebrow}</p>
      <h2 className={`mt-3 ${H2}`}>{title}</h2>
      {sub && <p className="mt-4 text-[17px] leading-relaxed text-[#595959]">{sub}</p>}
    </div>
  );
}

export default async function AffiliatesPage() {
  const { cta, email } = await resolveMarketingSession();
  const startHref = email !== null ? "/workspace" : "/start";
  return (
    <main className={`${jakarta.variable} min-h-screen overflow-x-clip bg-white font-[family-name:var(--font-jakarta)] text-ink`}>
      <BreadcrumbStructuredData trail={[{ name: "Affiliate program", path: "/affiliates" }]} />
      <GrowthHeader cta={cta} email={email} />
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      {}
      <section className="w-full">
        <div className="mx-auto flex max-w-[1120px] flex-col items-center px-4 pt-10 pb-8 text-center sm:px-6 sm:pt-16 lg:px-10">
          <p className="rounded-full bg-[#e6f2ff] px-3.5 py-1.5 text-[13px] font-semibold text-[#0e0f11]">Zavi affiliate program</p>
          <h1 className="mt-6 max-w-[18ch] text-[clamp(2.1rem,6vw,4.25rem)] leading-[1.04] font-bold tracking-[-0.035em] text-balance text-[#0e0f11]">
            Earn 100% of their first two months.
          </h1>
          <p className="mt-5 max-w-[52ch] text-[17px] leading-relaxed text-[#595959] sm:text-[18px]">
            Send people to Zavi. When they subscribe, you keep their first 2 monthly payments, then 30% of every payment through month 12.
          </p>
          <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <a href={APPLY_HREF} className={BTN_DARK}>
              Get your link <ArrowRight className="size-4" aria-hidden="true" />
            </a>
            <a href="#how" className={BTN_LIGHT}>
              See how it works
            </a>
          </div>
          <p className="mt-5 text-[14px] text-[#595959]">
            Already a creator?{" "}
            <a href={LOGIN_HREF} className={`font-semibold text-[#0e0f11] underline underline-offset-4 ${FOCUS}`}>
              Sign in
            </a>
          </p>
        </div>
      </section>

      {}
      <ul className="mx-auto flex max-w-[1120px] flex-col items-center justify-center gap-3 px-4 py-8 sm:flex-row sm:gap-10 sm:px-6">
        {FACTS.map((f) => (
          <li key={f.label} className="flex items-center gap-3 text-[16px] font-medium text-[#0e0f11]">
            <span className="flex size-8 items-center justify-center rounded-[10px] bg-[#f9f9f9] ring-1 ring-[#0e0f11]/[0.05]">
              <f.icon className="size-4 text-[#595959]" aria-hidden="true" />
            </span>
            {f.label}
          </li>
        ))}
      </ul>

      {}
      <Section id="how">
        <SectionHead eyebrow="How it works" title="Three steps, then it pays you" />
        <ol className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-[20px] border border-[#0e0f11]/[0.08] bg-white p-6">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-bold text-[#027bff]">{s.n}</span>
                <span className="flex size-10 items-center justify-center rounded-xl bg-[#f9f9f9]">
                  <s.icon className="size-5 text-[#0e0f11]" aria-hidden="true" />
                </span>
              </div>
              <h3 className="mt-5 text-[19px] font-semibold text-[#0e0f11]">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-[#595959]">{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {}
      <Section className="bg-[#f9f9f9]">
        <SectionHead
          eyebrow="Per customer"
          title="What one customer earns you"
          sub="Year one is 5 months of their plan: two full payments, then 30% for ten more."
        />
        <div className="mx-auto mt-10 max-w-[860px] overflow-hidden rounded-[20px] border border-[#0e0f11]/[0.08] bg-white">
          <table className="w-full table-fixed text-left">
            <caption className="sr-only">Commission per referred customer in their first year</caption>
            <thead>
              <tr className="border-b border-[#0e0f11]/[0.08] text-[11px] font-semibold tracking-[0.04em] text-[#595959] uppercase sm:text-[13px] sm:tracking-[0.06em]">
                <th scope="col" className="w-[26%] px-3 py-4 sm:px-6">Plan</th>
                <th scope="col" className="px-1.5 py-4 sm:px-6">Months 1-2</th>
                <th scope="col" className="px-1.5 py-4 sm:px-6">Months 3-12</th>
                <th scope="col" className="px-3 py-4 text-right sm:px-6">Year one</th>
              </tr>
            </thead>
            <tbody>
              {AFFILIATE_PLANS.map((p) => (
                <tr key={p.id} className="border-b border-[#0e0f11]/[0.06] last:border-b-0">
                  <th scope="row" className="px-3 py-5 align-top sm:px-6">
                    <span className="block text-[15px] font-semibold text-[#0e0f11] sm:text-[16px]">{p.name}</span>
                    <span className="block text-[12.5px] font-normal text-[#595959]">{usd(p.price)}/mo</span>
                  </th>
                  <td className="px-1.5 py-5 align-top sm:px-6">
                    <span className="block text-[15px] font-semibold text-[#0e0f11] sm:text-[16px]">{usd(firstTwo(p.price))}</span>
                    <span className="block text-[12px] text-[#595959]">{usd(p.price)} × 2</span>
                  </td>
                  <td className="px-1.5 py-5 align-top sm:px-6">
                    <span className="block text-[15px] font-semibold text-[#0e0f11] sm:text-[16px]">{usd(laterTen(p.price))}</span>
                    <span className="block text-[12px] text-[#595959]">{usd(p.price * LATER_RATE)} × 10</span>
                  </td>
                  <td className="px-3 py-5 text-right align-top sm:px-6">
                    <span className="text-[17px] font-bold text-[#167f50] sm:text-[22px]">{usd(yearOne(p.price))}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mx-auto mt-4 max-w-[860px] text-center text-[13px] text-[#595959]">Subscriptions only. Credit top-ups are not included.</p>
      </Section>

      {}
      <Section>
        <SectionHead eyebrow="Calculator" title="What could you earn?" sub="Pick a plan and how many customers you refer." />
        <EarningsCalculator />
      </Section>

      {}
      <Section id="terms">
        <div className="grid gap-8 lg:grid-cols-[280px_1fr] lg:gap-16">
          <div className="lg:sticky lg:top-32 lg:self-start">
            <p className={EYEBROW}>The terms</p>
            <h2 className={`mt-3 ${H2}`}>The fine print, in plain words</h2>
          </div>
          <div className="divide-y divide-[#0e0f11]/[0.08] border-y border-[#0e0f11]/[0.08]">
            {TERMS.map(([q, a], i) => (
              <details key={q} open={i === 0} className="group">
                <summary
                  className={`${FOCUS} flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-[17px] font-semibold text-[#0e0f11] marker:hidden [&::-webkit-details-marker]:hidden`}
                >
                  {q}
                  <Plus className="size-5 shrink-0 text-[#595959] transition-transform duration-200 group-open:rotate-45" aria-hidden="true" />
                </summary>
                <p className="max-w-[70ch] pb-6 text-[16px] leading-relaxed text-[#595959]">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </Section>

      {}
      <section className="w-full bg-white pb-14 lg:pb-20">
        <div className="mx-auto w-full max-w-[1120px] px-3 sm:px-6">
          <div className="rounded-[28px] bg-[#0e0f11] px-6 py-14 text-center text-white sm:px-10 lg:py-16">
            <h2 className="mx-auto max-w-[20ch] text-[clamp(1.7rem,4.4vw,3rem)] leading-[1.08] font-extrabold tracking-[-0.03em] text-balance">
              Get your link and start earning
            </h2>
            <p className="mx-auto mt-4 max-w-[46ch] text-[17px] leading-relaxed text-white/70">
              100% of their first 2 monthly payments, then 30% through month 12.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <a
                href={APPLY_HREF}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[16px] font-semibold text-[#0e0f11] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Get your link <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <a
                href={LOGIN_HREF}
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/25 px-6 text-[16px] font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                I&apos;m already a creator
              </a>
            </div>
          </div>
        </div>
      </section>

      <GrowthFooter startHref={startHref} />
    </main>
  );
}
