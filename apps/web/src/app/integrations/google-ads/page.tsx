import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import Link from "next/link";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";

export const metadata: Metadata = marketingPageMetadata(
  "/integrations/google-ads",
  "Google Ads API | Zavi",
  "How Zavi uses the Google Ads API: the Ads Manager agent reads campaign performance and proposes budget and creative changes for your approval.",
);

const LAST_UPDATED = "2026-05-19";

export default async function GoogleAdsIntegrationPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-cream text-ink selection:bg-violet selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <section className="border-b border-ink/10">
        <div className="mx-auto max-w-[860px] px-6 md:px-10 pt-10 md:pt-12 pb-5 md:pb-6">
          <div className="kicker text-violet">Integrations · Google Ads</div>
          <h1 className="mt-2 font-display font-semibold tracking-tightest leading-[1.0] text-[30px] md:text-[40px] text-ink">
            Zavi &amp; the Google Ads API.
          </h1>
          <p className="mt-3 text-[16px] text-inkMuted">
            Last updated <strong>{LAST_UPDATED}</strong>. This page describes how the
            Zavi <strong>Ads Manager</strong> agent uses the Google Ads API to manage
            your advertising. Questions:{" "}
            <a href="mailto:support@zaviagent.com" className="text-violet underline underline-offset-2">
              support@zaviagent.com
            </a>
            .
          </p>
        </div>
      </section>

      <article className="mx-auto max-w-[860px] px-6 md:px-10 py-10 md:py-14">
        <Section n="1" title="What Zavi is">
          <p>
            Zavi is a B2B software platform that gives a company operator a team
            of AI agents that read the operator's own business data and produce drafts,
            recommendations, and reports. One of those agents is the{" "}
            <strong>Ads Manager</strong>: a paid-acquisition tool that helps an
            advertiser plan and manage their own Google Ads campaigns. Zavi is the
            software tool being built; it is not an agency or a managed-services
            offering.
          </p>
        </Section>

        <Section n="2" title="What the Ads Manager does with the Google Ads API">
          <p>
            When an operator connects their Google Ads account, the Ads Manager agent
            uses the Google Ads API on that operator's behalf to:
          </p>
          <ul>
            <li>
              <strong>Read campaign structure and performance.</strong> Campaigns, ad
              groups, ads, keywords, budgets, bidding strategies, and performance
              metrics (impressions, clicks, conversions, cost, CPA, ROAS) over the
              account's reporting windows.
            </li>
            <li>
              <strong>Generate management recommendations.</strong> The agent analyzes
              what is working and produces a weekly plan: concrete budget shifts,
              bid-strategy changes, campaign pause/enable suggestions, and creative
              briefs.
            </li>
            <li>
              <strong>Apply changes you approve.</strong> Budget changes, campaign
              status changes, and ad/asset updates are written back to the Google Ads
              API <strong>only after the operator explicitly approves the specific
              change</strong> in the Zavi approvals queue. No spend or campaign
              mutation ever happens automatically.
            </li>
          </ul>
        </Section>

        <Section n="3" title="Human approval is mandatory">
          <p>
            Every write to the Google Ads API is gated behind an explicit human
            approval step. The agent proposes; the operator decides. Zavi surfaces
            each proposed change with the data behind it, and the change is only sent
            to Google after the operator approves it. The operator can revoke the
            connection at any time, which immediately stops all API access.
          </p>
        </Section>

        <Section n="4" title="How advertiser data is handled">
          <ul>
            <li>
              <strong>Storage &amp; location.</strong> Google Ads data we retrieve is
              processed and stored in AWS <code>us-west-1</code> (Northern California),
              encrypted at rest and in transit (TLS 1.2+).
            </li>
            <li>
              <strong>OAuth tokens.</strong> Google OAuth credentials are stored in
              Supabase Vault and are never exposed to the browser client.
            </li>
            <li>
              <strong>Use limitation.</strong> Google Ads data is used solely to
              operate the Ads Manager for the operator who connected the account. We do
              not sell it, we do not share it with third parties beyond the
              sub-processors listed in our{" "}
              <a href="/privacy" className="text-violet underline underline-offset-2">Privacy Policy</a>
              , and we do not use it to train any foundation model.
            </li>
            <li>
              <strong>Per-tenant isolation.</strong> Every operator's data is isolated
              by row-level security in Postgres. One operator can never read another
              operator's Google Ads data.
            </li>
            <li>
              <strong>Deletion.</strong> Disconnecting the integration revokes API
              access. Account deletion removes stored Google Ads data within 30 days,
              except records we are legally required to retain.
            </li>
          </ul>
        </Section>

        <Section n="5" title="Compliance">
          <p>
            Zavi's use of the Google Ads API is subject to, and complies with, the{" "}
            <a
              href="https://developers.google.com/google-ads/api/terms"
              target="_blank"
              rel="noreferrer"
              className="text-violet underline underline-offset-2"
            >
              Google Ads API Terms and Conditions
            </a>{" "}
            and the{" "}
            <a
              href="https://developers.google.com/google-ads/api/docs/policy"
              target="_blank"
              rel="noreferrer"
              className="text-violet underline underline-offset-2"
            >
              Google Ads API Policy
            </a>
            . Our handling of Google user data also follows the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
              className="text-violet underline underline-offset-2"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </Section>

        <Section n="6" title="Contact">
          <p>
            Zavi Labs, Inc. · 39763 Fog Shrew Rd, Newark, CA 94560 · General contact{" "}
            <a href="mailto:support@zaviagent.com" className="text-violet underline underline-offset-2">
              support@zaviagent.com
            </a>{" "}
            · Privacy{" "}
            <a href="mailto:support@zaviagent.com" className="text-violet underline underline-offset-2">
              support@zaviagent.com
            </a>
            . See also our{" "}
            <Link href="/privacy" className="text-violet underline underline-offset-2">Privacy Policy</Link>{" "}
            and{" "}
            <Link href="/terms" className="text-violet underline underline-offset-2">Terms of Service</Link>
            .
          </p>
        </Section>
      </article>

      <GrowthFooter startHref="/start" />
    </main>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="py-4 first:pt-0 last:pb-0 border-b border-ink/10 last:border-b-0">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-mono text-[11px] text-violet tracking-[0.16em] uppercase">{n}</span>
        <h2 className="font-display font-semibold text-[20px] md:text-[22px] tracking-tighter text-ink">
          {title}
        </h2>
      </div>
      <div className="text-[16px] leading-[1.7] text-ink/85 space-y-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1 [&_code]:bg-ink/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded">
        {children}
      </div>
    </section>
  );
}
