import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import Link from "next/link";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";

export const metadata: Metadata = marketingPageMetadata(
  "/legal/data-deletion",
  "Data deletion | Zavi",
  "How to revoke Zavi's access to a connected account and request deletion of the data we hold, including data obtained from Meta (Facebook and Instagram) and Google.",
);

const LAST_UPDATED = "2026-10-17";

const linkCls = "text-violet underline underline-offset-2";

export default async function DataDeletionPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-cream text-ink selection:bg-violet selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <section className="border-b border-ink/10">
        <div className="mx-auto max-w-[860px] px-6 md:px-10 pt-10 md:pt-12 pb-5 md:pb-6">
          <div className="kicker text-violet">Legal · Data deletion</div>
          <h1 className="mt-2 font-display font-semibold tracking-tightest leading-[1.0] text-[30px] md:text-[40px] text-ink">
            Deleting your data.
          </h1>
          <p className="mt-3 text-[16px] text-inkMuted">
            Last updated <strong>{LAST_UPDATED}</strong>. How to revoke Zavi&apos;s access to a
            connected account and have the data we hold deleted. Questions:{" "}
            <a href="mailto:support@zaviagent.com" className={linkCls}>
              support@zaviagent.com
            </a>
            .
          </p>
        </div>
      </section>

      <article className="mx-auto max-w-[860px] px-6 md:px-10 py-10 md:py-14">
        <Section n="1" title="What data this covers">
          <p>
            Zavi is a B2B software platform that gives a company operator a team of AI agents that
            read that operator&apos;s own business data. The data we hold about you falls into two
            groups:
          </p>
          <ul>
            <li>
              <strong>Account data.</strong> Your email, name, optional company name, and the
              records of agent runs performed for your workspace.
            </li>
            <li>
              <strong>Connected-account data.</strong> Data we retrieved on your behalf from a
              third-party account you connected, for example Meta (Facebook and Instagram) ad
              performance, Google Ads campaign performance, Slack messages, or GitHub repository
              contents. This includes the OAuth access token for that connection, which is held encrypted
              in Supabase Vault and never exposed to your browser.
            </li>
          </ul>
        </Section>

        <Section n="2" title="Revoking access to a connected account">
          <p>
            Revoking access stops Zavi reading anything further from that account. It takes effect
            immediately and you can do it yourself, without contacting us.
          </p>
          <ul>
            <li>
              <strong>Meta (Facebook and Instagram), from inside Zavi.</strong> Go to{" "}
              <strong>Settings</strong> in your Zavi workspace, find the <strong>Meta Ads</strong>{" "}
              connector, open its <strong>⋯</strong> menu and choose <strong>Disconnect</strong>.
              The stored access token is deleted immediately and the{" "}
              <code>performance-marketer</code> agent stops reading your ad account at once. You can
              reconnect at any time.
            </li>
            <li>
              <strong>Meta, from Facebook instead.</strong> If you would rather revoke from
              Meta&apos;s side, open{" "}
              <a
                href="https://www.facebook.com/settings?tab=applications"
                target="_blank"
                rel="noreferrer"
                className={linkCls}
              >
                Facebook Settings → Apps and Websites
              </a>
              , find <strong>Zavi</strong>, and choose <strong>Remove</strong>. Facebook notifies us
              at that moment and our stored token for your ad account stops working. Your Zavi
              workspace will then show the Meta Ads connector as needing to be reconnected.
            </li>
            <li>
              <strong>Google Ads or Google Analytics.</strong> Open{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noreferrer"
                className={linkCls}
              >
                your Google account permissions
              </a>
              , find <strong>Zavi</strong>, and choose <strong>Remove access</strong>.
            </li>
            <li>
              <strong>Slack.</strong> A workspace admin can remove the Zavi app from the workspace
              in Slack&apos;s <em>Manage apps</em> settings.
            </li>
            <li>
              <strong>GitHub.</strong> Uninstall the Zavi GitHub App from your organisation or
              account in GitHub&apos;s <em>Applications</em> settings.
            </li>
          </ul>
          <p>
            Revoking access stops future reads. It does not, on its own, erase what we already
            stored. For that, make a deletion request below.
          </p>
        </Section>

        <Section n="3" title="Requesting deletion of stored data">
          <p>
            <strong>Delete your whole account yourself.</strong> Sign in, open your profile menu and
            choose <strong>Account</strong> (or go to{" "}
            <a href="https://www.zaviagent.com/account" className={linkCls}>
              www.zaviagent.com/account
            </a>
            ), then <strong>Delete account</strong>. Your sign-in stops working straight away. A
            workspace where you are the only member goes with your account, and its stored
            connected-account tokens are deleted at once; a workspace other members still use stays
            with them. The rest of your stored data follows on the same timeline as an emailed
            request below.
            If you are the only member of a workspace on a paid plan, cancel the plan in Billing
            first; deleting your account does not cancel it.
          </p>
          <p>
            Or email{" "}
            <a href="mailto:support@zaviagent.com" className={linkCls}>
              support@zaviagent.com
            </a>{" "}
            from the address on your Zavi account, with the subject{" "}
            <strong>Data deletion request</strong>. Tell us whether you want:
          </p>
          <ul>
            <li>
              <strong>One connection deleted</strong>: name it (for example &ldquo;Meta Ads&rdquo;)
              and we delete the stored token and the data we retrieved from it, leaving the rest of
              your workspace intact; or
            </li>
            <li>
              <strong>Your whole account deleted</strong>: we delete your account, your
              workspace&apos;s stored data, and every connected-account token we hold.
            </li>
          </ul>
          <p>
            We acknowledge the request within 10 business days and complete the deletion within 30
            days, except for records we are legally required to retain (for example, tax-related
            billing records for up to 7 years). We will email you to confirm when it is done. There
            is no charge, and you do not need an active subscription to make a request.
          </p>
          <p>
            <strong>If you can no longer sign in to Zavi</strong> (for example, you removed the app
            on Facebook and never had a separate Zavi login), email us from the address you signed
            up with and name the ad account or workspace, and we will locate and delete the records
            without requiring you to sign back in.
          </p>
        </Section>

        <Section n="4" title="What happens to your data in the meantime">
          <p>
            Data we hold is stored in AWS <code>us-west-1</code> (Northern California), encrypted at
            rest and in transit, and isolated per workspace by row-level security in Postgres. We do
            not sell it, we do not share it beyond the sub-processors listed in our{" "}
            <Link href="/privacy" className={linkCls}>
              Privacy Policy
            </Link>
            , and we do not use it to train any foundation model.
          </p>
        </Section>

        <Section n="5" title="Other privacy rights">
          <p>
            Depending on where you live you may also have the right to access, correct, or port your
            data, and to object to or restrict processing. Those rights, and how to exercise them,
            are described in our{" "}
            <Link href="/privacy" className={linkCls}>
              Privacy Policy
            </Link>
            . Use the same email address for any of them.
          </p>
        </Section>

        <Section n="6" title="Contact">
          <p>
            Zavi Labs, Inc. · 39763 Fog Shrew Rd, Newark, CA 94560 ·{" "}
            <a href="mailto:support@zaviagent.com" className={linkCls}>
              support@zaviagent.com
            </a>
            . See also our{" "}
            <Link href="/privacy" className={linkCls}>
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className={linkCls}>
              Terms of Service
            </Link>
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
