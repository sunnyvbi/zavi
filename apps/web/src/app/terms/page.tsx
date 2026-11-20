import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { LegalHero } from "@/components/marketing/LegalHero";
import { TermsToc, type TocItem } from "@/components/marketing/TermsToc";

export const metadata: Metadata = marketingPageMetadata(
  "/terms",
  "Terms of Service | Zavi",
  "Zavi terms of service: what you agree to when you use Zavi.",
);

const LAST_UPDATED = "2026-09-22";

type Section = { id: string; title: string; body: React.ReactNode };

const link =
  "font-medium text-[#0e0f11] underline underline-offset-2 transition-opacity hover:opacity-70";
const code =
  "rounded-[4px] bg-[#f0f0f0] px-1.5 py-0.5 text-[16px] font-medium text-[#1f1f1f]";

const SECTIONS: Section[] = [
  {
    id: "acceptance",
    title: "Acceptance",
    body: (
      <p>
        These Terms are an agreement between you and <strong>Zavi Labs, Inc.</strong>
        (&quot;Zavi&quot;, &quot;we&quot;, or &quot;us&quot;). They govern your access to and use
        of the Zavi service (the &quot;Service&quot;), operated at{" "}
        <code className={code}>zaviagent.com</code>. By creating an account or otherwise using the
        Service, you agree to these Terms. If you are using the Service on behalf of a company or
        other entity, you represent that you have authority to bind that entity, and
        &quot;you&quot; refers to that entity.
      </p>
    ),
  },
  {
    id: "account",
    title: "Account & eligibility",
    body: (
      <p>
        You must be at least 18 years old and capable of forming a binding contract. You are
        responsible for keeping your login credentials secure and for all activity that occurs
        under your account. Notify us at{" "}
        <a href="mailto:support@zaviagent.com" className={link}>
          support@zaviagent.com
        </a>{" "}
        if you suspect unauthorized access.
      </p>
    ),
  },
  {
    id: "service",
    title: "The Service",
    body: (
      <>
        <p>
          Zavi provides AI agents that read data you connect (via OAuth or direct integration)
          and produce drafts, recommendations, and other outputs. Zavi is an actively developed
          product; features and availability may change over time, and we will give notice of
          material changes as described under{" "}
          <a href="#changes" className={link}>Changes to these Terms</a>.
        </p>
        <p>
          Agent outputs are drafts unless explicitly approved by you. You remain responsible for
          every action taken in your name based on agent output. We do not warrant that agent
          outputs will be accurate, complete, or fit for a particular purpose. See{" "}
          <a href="#disclaimers" className={link}>Disclaimers</a>.
        </p>
      </>
    ),
  },
  {
    id: "fees",
    title: "Fees",
    body: (
      <p>
        Fees are set out on our pricing page or in an order form or other written agreement
        between you and Zavi (each, an &quot;Order&quot;). By starting a paid plan you authorize us
        to charge the fees for that plan on a recurring basis until you cancel. If you are on a
        free or trial plan, you owe no fees for that use. We will not increase the fees for your
        existing plan without your prior acceptance and at least 30 days&apos; notice. Fees are
        exclusive of taxes; you are responsible for any sales, use, VAT, or similar taxes (other
        than taxes on our income).
      </p>
    ),
  },
  {
    id: "data",
    title: "Your data, your content",
    body: (
      <p>
        You own the data you connect to the Service and the outputs the agents generate from it
        (&quot;Your Content&quot;). You grant Zavi a non-exclusive, worldwide, royalty-free
        license to host, process, and display Your Content solely to operate the Service for you.
        We do not use Your Content to train any foundation model, and we do not sell or share it
        with third parties except the sub-processors listed in our{" "}
        <a href="/privacy" className={link}>
          Privacy Policy
        </a>
        , who only process Your Content on our behalf.
      </p>
    ),
  },
  {
    id: "third-party-data",
    title: "Data about other people",
    body: (
      <>
        <p>
          Much of what you route into Zavi is about people who are not Zavi users: colleagues in a
          Slack workspace, attendees on a call, people visible in a screenshot, contacts in a
          connected account. As between you and Zavi, you are the controller of that data and we
          process it on your behalf. You represent that you have the right to share it with us and
          have given whatever notice or obtained whatever consent the law where those people are
          requires.
        </p>
        <p>
          Two cases deserve to be called out, because the obligation is yours and the penalty for
          getting them wrong falls on you:
        </p>
        <ul className="flex flex-col gap-1 pl-6">
          <li>
            <strong>Recording meetings.</strong> If you use the Zavi Notetaker, you are responsible
            for obtaining every participant&apos;s consent before the call is recorded. California,
            Florida, Illinois, Pennsylvania, Washington and other states require consent from all
            parties, not just you. The Notetaker joins under a visible name and announces that it
            is recording; that announcement is a tool to help you, not a substitute for consent.
            You may not disable the announcement.
          </li>
          <li>
            <strong>Indexing a workspace.</strong> If you connect Slack with message scopes, Zavi
            indexes messages written by other members of that workspace. You are responsible for
            telling your team that Zavi is connected and what it can see.
          </li>
        </ul>
        <p>
          If someone whose data you routed into Zavi asks us to delete it, we will tell you and
          work with you to honour the request.
        </p>
      </>
    ),
  },
  {
    id: "agent-actions",
    title: "Actions agents take on your behalf",
    body: (
      <>
        <p>
          Some agents can do more than draft. With your approval they can write changes back to
          connected accounts: shifting an advertising budget, pausing or resuming a campaign,
          publishing a post, sending an email, executing code in a sandbox, or provisioning
          infrastructure. Those actions have real-world effect and can cost money.
        </p>
        <p>
          You authorise Zavi to take an action when you approve that specific action, or when you
          configure an agent to act within limits you set. You are responsible for the outcome of
          actions taken under your account, including advertising spend, and for keeping your
          approval settings and spend limits appropriate to what you are willing to risk. We are
          not liable for the performance of a campaign, the results of a change, or the cost of
          spend incurred through the Service. Review what an agent proposes before approving it.
        </p>
        <p>
          Your use of a connected account through Zavi also remains subject to that provider&apos;s
          own terms. Nothing here overrides them.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul className="flex flex-col gap-1 pl-6">
          <li>use the Service to violate any law or third-party right;</li>
          <li>upload content that is infringing, defamatory, or violates another person&apos;s privacy;</li>
          <li>attempt to reverse-engineer, scrape, or circumvent rate limits on the Service;</li>
          <li>use the Service to send spam, conduct phishing, or otherwise impersonate any party;</li>
          <li>use the Service to make consequential decisions about other people (employment, credit, housing, etc.) without keeping a human in the loop;</li>
          <li>resell or sublicense the Service to third parties without our written consent.</li>
        </ul>
      </>
    ),
  },
  {
    id: "termination",
    title: "Termination",
    body: (
      <p>
        You may stop using the Service and delete your account at any time. We may suspend or
        terminate your access if you breach these Terms, if we are required to by law, or if
        continuing to provide the Service to you creates an unreasonable risk to other users or
        the operation of the Service. We will give you reasonable notice and an opportunity to
        export Your Content unless doing so would itself violate law or another user&apos;s rights.
      </p>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <p>
        THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE,&quot; WITHOUT WARRANTIES
        OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
        PARTICULAR PURPOSE, NON-INFRINGEMENT, OR THAT THE SERVICE WILL BE UNINTERRUPTED OR
        ERROR-FREE. AGENT OUTPUTS ARE PROBABILISTIC. YOU ARE RESPONSIBLE FOR REVIEWING THEM
        BEFORE RELYING ON THEM FOR ANY DECISION.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL ZAVI BE LIABLE FOR ANY INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, REVENUE,
        DATA, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH THESE TERMS OR THE SERVICE. OUR
        AGGREGATE LIABILITY UNDER THESE TERMS WILL NOT EXCEED THE GREATER OF (A) ONE HUNDRED U.S.
        DOLLARS ($100) OR (B) THE FEES YOU PAID US IN THE TWELVE MONTHS PRECEDING THE CLAIM.
      </p>
    ),
  },
  {
    id: "indemnification",
    title: "Indemnification",
    body: (
      <p>
        You agree to indemnify and hold Zavi harmless from third-party claims arising from Your
        Content or your breach of these Terms. We will give you prompt written notice of any
        covered claim and reasonable cooperation in defending it.
      </p>
    ),
  },
  {
    id: "governing-law",
    title: "Governing law",
    body: (
      <p>
        These Terms are governed by the laws of the State of California, without regard to
        conflict-of-laws principles. Exclusive venue for any dispute is the state and federal
        courts located in San Francisco County, California.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <p>
        We may update these Terms from time to time. Material changes will be communicated by
        email or in-product notice at least 14 days before they take effect. Continued use of the
        Service after the effective date constitutes acceptance.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Zavi Labs, Inc. Questions, notices, or process service to{" "}
        <a href="mailto:support@zaviagent.com" className={link}>
          support@zaviagent.com
        </a>
        .
      </p>
    ),
  },
];

const TOC: TocItem[] = SECTIONS.map((s) => ({ id: s.id, label: s.title }));

export default async function TermsPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-ink selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      {}
      <LegalHero
        kicker="Terms of Service"
        title="Terms of Service."
        subtitle={
          <>
            Last updated <strong className="font-bold text-[#191919]">{LAST_UPDATED}</strong>. If
            anything here is unclear, email{" "}
            <a href="mailto:support@zaviagent.com" className="text-[#191919] underline underline-offset-2 hover:opacity-70">
              support@zaviagent.com
            </a>
            .
          </>
        }
      />

      {}
      <div className="mx-auto max-w-[1240px] px-6 py-12 md:px-10 md:py-16">
        <div className="flex justify-center gap-[60px] xl:gap-[95px]">
          <aside className="hidden shrink-0 lg:block">
            <div className="sticky top-[100px]">
              <TermsToc items={TOC} />
            </div>
          </aside>

          <article className="w-full max-w-[780px]">
            {SECTIONS.map((s, i) => (
              <section
                key={s.id}
                id={s.id}
                className="scroll-mt-[100px] border-b border-[#f0f0f0] pb-[21px] pt-5 first:pt-0 last:border-b-0"
              >
                <h2 className="flex gap-2 text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]">
                  <span>{i + 1}.</span>
                  <span>{s.title}</span>
                </h2>
                <div className="mt-3 space-y-3 text-[14px] leading-[24px] tracking-[0.15px] text-[#1f1f1f]">
                  {s.body}
                </div>
              </section>
            ))}
          </article>
        </div>
      </div>

      <GrowthFooter startHref="/start" />
    </main>
  );
}
