import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { LegalHero } from "@/components/marketing/LegalHero";
import { CookiePrefsButton } from "@/components/marketing/CookiePrefsButton";
import { ANALYTICS, EMBEDDED, NECESSARY, type CookieRow } from "@/lib/cookie-inventory";

export const metadata: Metadata = marketingPageMetadata(
  "/cookie-policy",
  "Cookie Policy | Zavi",
  "Every cookie and browser-storage key Zavi uses, what each one is for, and how to change your choice.",
);

const LAST_UPDATED = "2026-10-19";

const link =
  "font-medium text-[#0e0f11] underline underline-offset-2 transition-opacity hover:opacity-70";
const h2 = "text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]";

function Table({ rows }: { rows: CookieRow[] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-[#f0f0f0]">
      <table className="w-full min-w-[640px] text-left text-[14px]">
        <thead>
          <tr className="border-b border-[#f0f0f0] bg-[#f9f9f9]">
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Name</th>
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Provider</th>
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Type</th>
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Expiry</th>
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.name}-${r.type}`} className="border-b border-[#f0f0f0] last:border-b-0">
              <td className="px-4 py-2.5 align-top font-mono text-[13px] text-[#0e0f11]">{r.name}</td>
              <td className="px-4 py-2.5 align-top text-[#1f1f1f]">{r.provider}</td>
              <td className="px-4 py-2.5 align-top text-[#1f1f1f]">{r.type}</td>
              <td className="px-4 py-2.5 align-top text-[#1f1f1f]">{r.expiry}</td>
              <td className="px-4 py-2.5 align-top leading-[1.5] text-[#1f1f1f]">{r.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CookiePolicyPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-ink selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <LegalHero
        kicker="Cookie policy"
        title="Cookies."
        subtitle={
          <>
            Last updated <strong className="font-bold text-[#191919]">{LAST_UPDATED}</strong>. Part
            of our{" "}
            <a href="/privacy" className="text-[#191919] underline underline-offset-2 hover:opacity-70">
              Privacy Policy
            </a>
            . Questions:{" "}
            <a
              href="mailto:support@zaviagent.com"
              className="text-[#191919] underline underline-offset-2 hover:opacity-70"
            >
              support@zaviagent.com
            </a>
            .
          </>
        }
      />

      <div className="mx-auto max-w-[900px] px-6 py-12 md:px-10 md:py-16">
        <article className="space-y-10 text-[14px] leading-[24px] tracking-[0.15px] text-[#1f1f1f]">
          <section>
            <p>
              This page lists every cookie and browser-storage key that Zavi Labs, Inc. sets on
              zaviagent.com, what each one is for, and how to change your choice. It is short
              because we use very little: what keeps you signed in, what remembers your settings,
              and two analytics tools you can switch off. We do not use advertising cookies, and
              we do not record your screen.
            </p>
          </section>

          <section id="what" className="scroll-mt-[100px]">
            <h2 className={h2}>1. What we mean by &ldquo;cookies&rdquo;</h2>
            <p className="mt-3">
              A cookie is a small text file a website stores in your browser. Browsers also offer
              two other stores, local storage and session storage, which some of the tools below
              use instead of, or as well as, cookies. The law treats them the same way, and so does
              this page: &ldquo;cookies&rdquo; here means all three. Session storage is cleared when
              you close the tab; local storage and cookies persist until they expire or you clear
              them.
            </p>
          </section>

          <section id="necessary" className="scroll-mt-[100px]">
            <h2 className={h2}>2. Necessary</h2>
            <p className="mt-3">
              Set without asking, because the site does not work without them. Each one stores
              something you did (a sign-in, a setting, a build you started), and none of them is
              used to recognise you across sessions for our own purposes. The one read by a third
              party is Cloudflare&apos;s bot check on public forms.
            </p>
            <Table rows={NECESSARY} />
          </section>

          <section id="analytics" className="scroll-mt-[100px]">
            <h2 className={h2}>3. Analytics</h2>
            <p className="mt-3">
              <strong>Analytics are on unless you turn them off.</strong> Choose
              &ldquo;Reject&rdquo; in the banner or switch analytics off in preferences, and the
              analytics tools stop straight away in that tab, the keys below are deleted from this
              browser, and no analytics request leaves your browser after that. Other Zavi tabs you
              already have open stop when you reload them.
            </p>
            <Table rows={ANALYTICS} />
          </section>

          <section id="manage" className="scroll-mt-[100px]">
            <h2 className={h2}>4. Managing your preferences</h2>
            <p className="mt-3">
              Open the preferences panel here, from the &ldquo;Cookie preferences&rdquo; link in the
              footer of every marketing page, or from your account page once you are signed in.
            </p>
            <div className="mt-4">
              <CookiePrefsButton className="inline-flex h-11 items-center justify-center rounded-block bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#26282b]">
                Manage cookie preferences
              </CookiePrefsButton>
            </div>
            <ul className="mt-4 flex flex-col gap-2 pl-6">
              <li>
                Your choice is stored in the <code className="rounded-[4px] bg-[#f0f0f0] px-1.5 py-0.5 text-[13px]">zavi_consent_v1</code> cookie
                on this device and browser. It is not tied to your account, so a different browser
                or device will ask again.
              </li>
              <li>
                We keep a choice (yes or no) for 180 days, then ask again. We also ask again if
                we add a category of cookie or change what a tool does.
              </li>
              <li>
                Closing the banner without choosing leaves analytics on. Choose &ldquo;Reject&rdquo;
                to turn them off.
              </li>
              <li>
                If your browser sends a Global Privacy Control signal, we treat it as
                &ldquo;no&rdquo; and do not show the banner. You can still turn analytics on in the
                preferences panel; a choice you make there is respected over the signal.
              </li>
              <li>
                You can also block or delete cookies in your browser&apos;s settings. Blocking the
                Necessary ones will sign you out.
              </li>
            </ul>
          </section>

          <section id="third-parties" className="scroll-mt-[100px]">
            <h2 className={h2}>5. The analytics tools, plainly</h2>
            <p className="mt-3">
              We use{" "}
              <a href="https://posthog.com/privacy" target="_blank" rel="noreferrer" className={link}>PostHog</a>{" "}
              and{" "}
              <a href="https://mixpanel.com/legal/privacy-policy" target="_blank" rel="noreferrer" className={link}>Mixpanel</a>{" "}
              and{" "}
              <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer" className={link}>Google Analytics</a>,
              all listed on our{" "}
              <a href="/legal/subprocessors" className={link}>sub-processors</a> page. Two things
              worth saying out loud:
            </p>
            <ul className="mt-3 flex flex-col gap-2 pl-6">
              <li>
                PostHog requests are sent to a path on our own domain and forwarded to PostHog
                from there. This is a common setup; it does not change what is collected, and we
                mention it so that a request to zaviagent.com in your browser&apos;s network tab
                is not a surprise.
              </li>
              <li>
                All three receive page views on our public pages and on the sign-up steps. On
                public pages we also record which link or button was clicked: its label and where
                it goes, never what you type. Everywhere else we send a fixed list of named
                events. Once you are signed in, PostHog and Mixpanel link events to your account
                ID and email address, so we can see that a sign-up or a login happened.
              </li>
              <li>
                PostHog also records sessions so we can see where the product is confusing or
                broken: the page as you see it, its text, mouse movement, clicks and scrolling.
                Before anything leaves your browser, passwords, login codes, API keys and every
                email address are replaced with placeholder blocks, and images and video are
                blocked. Recording stops the moment you turn analytics off in the cookie banner.
              </li>
              <li>
                We do not ask Mixpanel to derive a location from your IP address.
              </li>
              <li>
                Google Analytics runs with advertising features, Google signals and ad
                personalisation turned off. It never receives your email or account ID, and the
                page addresses it receives keep only campaign tags (like utm_source), nothing
                else from the address bar. In the EU, EEA and UK (or when we cannot tell
                where you are) it only starts after you choose Accept.
              </li>
            </ul>
          </section>

          <section id="embedded" className="scroll-mt-[100px]">
            <h2 className={h2}>6. Embedded services</h2>
            <p className="mt-3">
              A few pages embed another company&apos;s service in a frame. Anything set inside that
              frame is set by them, under their policy, and we cannot control it, so we name
              them and link their policy rather than guess at their cookies.
            </p>
            <ul className="mt-3 flex flex-col gap-2 pl-6">
              {EMBEDDED.map((e) => (
                <li key={e.name}>
                  <a href={e.url} target="_blank" rel="noreferrer" className={link}>{e.name}</a>
                  {": "}
                  {e.where}
                </li>
              ))}
              <li>
                <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noreferrer" className={link}>Cloudflare Turnstile</a>
                {": "}
                bot protection on the launch-video form, loaded only on that page. Listed under
                Necessary above because it is a security measure on a form you are submitting.
              </li>
            </ul>
          </section>

          <section id="contact" className="scroll-mt-[100px]">
            <h2 className={h2}>7. Contact</h2>
            <p className="mt-3">
              Questions about this page, or a request to delete analytics data associated with you:{" "}
              <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a>.
              We update this page when the list changes and move the date at the top when we do.
            </p>
          </section>
        </article>
      </div>

      <GrowthFooter startHref="/start" />
    </main>
  );
}
