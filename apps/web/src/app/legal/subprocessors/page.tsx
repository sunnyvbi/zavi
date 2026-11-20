import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { LegalHero } from "@/components/marketing/LegalHero";

export const metadata: Metadata = marketingPageMetadata(
  "/legal/subprocessors",
  "Sub-processors | Zavi",
  "The third parties that process data on Zavi's behalf, what each one is for, and how we announce changes.",
);

const LAST_UPDATED = "2026-10-19";

const link =
  "font-medium text-[#0e0f11] underline underline-offset-2 transition-opacity hover:opacity-70";

type Row = { name: string; role: string; url: string };

const CORE: Row[] = [
  { name: "Anthropic", role: "Foundation model provider: Claude API for agent inference", url: "https://anthropic.com" },
  { name: "OpenAI", role: "Foundation model provider, used for some agent engines and evaluation passes", url: "https://openai.com" },
  { name: "Google", role: "Foundation model provider: Gemini, for some media and content generation", url: "https://ai.google.dev" },
  { name: "Fireworks AI", role: "Foundation model provider, used for some agent engines and evaluation passes", url: "https://fireworks.ai" },
  { name: "Helicone", role: "Model-gateway and observability proxy. When enabled, model requests route through Helicone, so it processes prompts and completions in transit on our behalf", url: "https://helicone.ai" },
  { name: "Voyage AI", role: "Embedding and reranking of stored memory notes so agents can retrieve them", url: "https://voyageai.com" },
  { name: "Supabase", role: "Postgres database, authentication, and Vault storage for OAuth tokens", url: "https://supabase.com" },
  { name: "AWS", role: "Hosting (Amplify for web, EC2 for backend, Secrets Manager for production secrets) and Bedrock for some model inference (us-west-1)", url: "https://aws.amazon.com" },
  { name: "Inngest", role: "Background job orchestration for agent runs", url: "https://inngest.com" },
  { name: "Recall.ai", role: "Meeting bot that joins and transcribes meetings you schedule it for. See the meeting recording section of our Privacy Policy", url: "https://recall.ai" },
  { name: "E2B", role: "Isolated sandboxes in which agents execute code on your behalf", url: "https://e2b.dev" },
  { name: "Anchor", role: "Hosted browser sessions agents use to browse on your behalf", url: "https://anchorbrowser.io" },
  { name: "Composio", role: "Connector and tool broker for some third-party integrations", url: "https://composio.dev" },
  { name: "Pipedream", role: "Connector and tool broker for third-party integrations you connect", url: "https://pipedream.com" },
  { name: "LiveKit", role: "Real-time audio transport for voice sessions", url: "https://livekit.io" },
  { name: "DataForSEO", role: "Search and AI-answer data for search-visibility checks you run", url: "https://dataforseo.com" },
  { name: "Cloudflare", role: "Bot protection (Turnstile) on public forms", url: "https://cloudflare.com" },
  { name: "Stripe", role: "Payment processing and subscription billing", url: "https://stripe.com" },
  { name: "Sendblue", role: "iMessage delivery: carries the texts between Zavi and the phones you connect to iMessage", url: "https://sendblue.com" },
  { name: "SendGrid (Twilio)", role: "Transactional email: sign-in emails, agent results, and agent email replies", url: "https://sendgrid.com" },
  { name: "PostHog", role: "Product analytics and session recordings (passwords, login codes, API keys and email addresses hidden in the browser)", url: "https://posthog.com" },
  { name: "Mixpanel", role: "Product analytics for page views and whitelisted product events", url: "https://mixpanel.com" },
  { name: "Google Analytics", role: "Web analytics for page views and clicks on public pages and sign-up steps; advertising features off", url: "https://marketingplatform.google.com/about/analytics/" },
  { name: "Apify", role: "Public-web data collection that agents run on your behalf, such as competitor and social research", url: "https://apify.com" },
  { name: "Tavily", role: "Web search that agents run on your behalf", url: "https://tavily.com" },
  { name: "Fal", role: "Image and video generation", url: "https://fal.ai" },
  { name: "Higgsfield", role: "Video and speech generation", url: "https://higgsfield.ai" },
];

const PROVISIONING: Row[] = [
  { name: "Neon", role: "Postgres databases provisioned for projects you ask Zavi to build", url: "https://neon.tech" },
  { name: "Render", role: "Hosting for sites and services provisioned on your behalf", url: "https://render.com" },
  { name: "GitHub", role: "Code repositories created for projects you ask Zavi to build", url: "https://github.com" },
  { name: "Cloudflare", role: "DNS for domains provisioned on your behalf", url: "https://cloudflare.com" },
  { name: "Domain registrar", role: "Domain registration. Registrant contact details are shared with the registrar, the registry, and ICANN where required by domain policy", url: "https://www.icann.org/resources/pages/registrars-0d-2012-02-25-en" },
];

const DIRECTED: string[] = [
  "Slack", "GitHub", "Google Ads", "Google Analytics", "Google Calendar",
  "Google Search Console", "Google Sheets", "YouTube", "Meta (Facebook and Instagram)",
  "LinkedIn", "LinkedIn Ads", "TikTok", "TikTok Ads", "Reddit", "Reddit Ads",
  "X", "X Ads", "Pinterest Ads", "Snapchat Ads", "Spotify Ads", "Microsoft Ads",
  "Apple Ads", "Figma", "Sentry", "Microsoft Teams",
  "Discord", "Telegram", "WhatsApp", "Intercom", "Jira", "Linear", "Stripe",
];

function Table({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-[#f0f0f0]">
      <table className="w-full text-left text-[14px]">
        <thead>
          <tr className="border-b border-[#f0f0f0] bg-[#f9f9f9]">
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Sub-processor</th>
            <th className="px-4 py-2.5 font-semibold text-[#0e0f11]">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-[#f0f0f0] last:border-b-0">
              <td className="px-4 py-2.5 align-top">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-[#0e0f11] underline underline-offset-2 hover:opacity-70"
                >
                  {r.name}
                </a>
              </td>
              <td className="px-4 py-2.5 leading-[1.5] text-[#1f1f1f]">{r.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function SubprocessorsPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-ink selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <LegalHero
        kicker="Sub-processors"
        title="Sub-processors."
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
              A sub-processor is a company Zavi Labs, Inc. engages that may process your data in
              order for Zavi to work. Each one is contractually limited to processing your data on
              our behalf, for the stated purpose only. We do not sell your data, and none of the
              vendors below may use it to train their own foundation models on our account.
            </p>
          </section>

          <section id="core" className="scroll-mt-[100px]">
            <h2 className="text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]">
              1. Core sub-processors
            </h2>
            <p className="mt-3">
              Engaged for every account. These can process customer content or personal data in the
              course of running the Service.
            </p>
            <Table rows={CORE} />
          </section>

          <section id="provisioning" className="scroll-mt-[100px]">
            <h2 className="text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]">
              2. Provisioning sub-processors
            </h2>
            <p className="mt-3">
              Engaged only if you use Zavi to provision infrastructure: a database, a hosted site,
              or a domain. If you do not use those features, these never receive your data.
            </p>
            <Table rows={PROVISIONING} />
          </section>

          <section id="directed" className="scroll-mt-[100px]">
            <h2 className="text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]">
              3. Integrations you connect yourself
            </h2>
            <p className="mt-3">
              These are not sub-processors we appointed. You connect each one yourself, and we use
              that access only for what you connected it for. Disconnecting the integration, or
              removing Zavi&apos;s access in that provider&apos;s own settings, ends our access. Data flowing to these providers is a disclosure at your direction.
            </p>
            <div className="mt-4 rounded-xl border border-[#f0f0f0] bg-[#f9f9f9] px-4 py-3 leading-[1.8]">
              {DIRECTED.join(" · ")}
            </div>
          </section>

          <section id="changes" className="scroll-mt-[100px]">
            <h2 className="text-[22px] font-semibold leading-[33px] tracking-[-0.8px] text-[#0e0f11]">
              4. How we announce changes
            </h2>
            <p className="mt-3">
              We update this page when we add or remove a sub-processor, and we change the date at
              the top when we do. If you would like to be emailed before a new core sub-processor
              starts processing your data, email{" "}
              <a href="mailto:support@zaviagent.com" className={link}>
                support@zaviagent.com
              </a>{" "}
              and we will add you to the notification list. Customers on a signed Data Processing
              Addendum receive advance notice as set out in that agreement.
            </p>
          </section>
        </article>
      </div>

      <GrowthFooter startHref="/start" />
    </main>
  );
}
