import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { LegalHero } from "@/components/marketing/LegalHero";

export const metadata: Metadata = marketingPageMetadata(
  "/security",
  "Security | Zavi",
  "How Zavi protects your data: database-enforced tenant isolation, an encrypted credential vault, server-side authorization, and no customer content in telemetry.",
);

const POSTURE: Array<{ h: string; p: string }> = [
  {
    h: "Tenant isolation at the database layer",
    p: "Isolation between customers is enforced in the database itself, not just in application code, so an application-layer bug cannot surface one customer's data to another.",
  },
  {
    h: "No privileged credentials in the browser",
    p: "The browser never holds privileged database credentials. Privileged operations run server-side through narrowly-scoped, audited procedures, and our build pipeline blocks any change that would ship a privileged key to the client.",
  },
  {
    h: "Encrypted credential vault",
    p: "OAuth tokens and other connector credentials are held in an encrypted vault, reachable only through a single audited path. Application roles cannot read them directly.",
  },
  {
    h: "Server-side authorization",
    p: "Background jobs re-derive and re-verify which customer they are acting for from trusted server state, never from the incoming request or event payload.",
  },
  {
    h: "No customer content in telemetry",
    p: "Our metrics pipeline captures only operational signals such as timings and status codes. Model inputs, model outputs, prompts, and other customer content never enter it.",
  },
  {
    h: "Managed secrets + encryption everywhere",
    p: "Production secrets live in a managed secrets service with least-privilege access. Data is encrypted in transit (TLS 1.2+) and at rest.",
  },
];

const HONEST_GAPS: Array<{ h: string; p: string }> = [
  {
    h: "SOC 2",
    p: "In progress. Type I targeted H2 2026, Type II H1 2027. Running a security review now? Email us and we'll share our current controls documentation.",
  },
  {
    h: "Data residency",
    p: "Single-region today. EU-region storage is available on request for committed customers.",
  },
  {
    h: "Third-party penetration test",
    p: "Continuous dependency scanning and internal review today; a third-party penetration test is scheduled.",
  },
];

export default async function SecurityPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-ink selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <LegalHero
        kicker="Security"
        title="How we handle your data."
        subtitle={
          <span className="font-medium">
            Straight talk on how we protect your data: the controls we run today, and what&apos;s
            on the roadmap.
          </span>
        }
      />

      {}
      <div className="mx-auto w-[calc(100%-1.5rem)] max-w-[1460px] py-12 md:w-[calc(100%-2rem)] md:py-16">
        {}
        <div className="px-6 md:px-[45px]">
          <PostureBlock kicker="In place" heading="What we've built." items={POSTURE} />
        </div>

        {}
        <div className="my-12 border-t border-[#f0f0f0] md:my-16" />

        {}
        <div className="px-6 md:px-[45px]">
          <PostureBlock kicker="Not yet" heading="What isn't in place yet." items={HONEST_GAPS} />
        </div>

        {}
        <div className="mt-12 rounded-[21px] bg-[#f9f9f9] px-6 py-8 md:mt-16 md:px-[45px] md:py-[40px]">
          <div className="kicker text-[#0e0f11]">Responsible disclosure</div>
          <p className="mt-2 text-[16px] leading-[26px] tracking-[0.16px] text-[#0e0f11]">
            Found a vulnerability? Email{" "}
            <a
              href="mailto:developer@zaviagent.com"
              className="text-[#0e0f11] underline underline-offset-2 transition-opacity hover:opacity-70"
            >
              developer@zaviagent.com
            </a>
            . We acknowledge reports within two business days and aim to fix high-severity issues
            within fourteen days. We don&apos;t have a bug bounty program yet. We&apos;d rather pay you in founder time + a public credit.
          </p>
        </div>
      </div>

      <GrowthFooter startHref="/start" />
    </main>
  );
}

function PostureBlock({
  kicker,
  heading,
  items,
}: {
  kicker: string;
  heading: string;
  items: Array<{ h: string; p: string }>;
}) {
  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-[60px] xl:gap-[95px]">
      <div className="shrink-0 lg:w-[240px]">
        <div className="kicker text-[#191919]">{kicker}</div>
        <h2 className="mt-2 text-[24px] font-bold leading-[34px] text-[#191919]">{heading}</h2>
      </div>

      <div className="w-full max-w-[780px]">
        {items.map((it) => (
          <section
            key={it.h}
            className="border-b border-[#f0f0f0] pb-[21px] pt-5 first:pt-0 last:border-b-0"
          >
            <h3 className="text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]">
              {it.h}
            </h3>
            <p className="mt-3 text-[14px] leading-[24px] tracking-[0.15px] text-[#1f1f1f]">
              {it.p}
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}
