import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";
import { LegalHero } from "@/components/marketing/LegalHero";
import { TermsToc, type TocItem } from "@/components/marketing/TermsToc";

export const metadata: Metadata = marketingPageMetadata(
  "/privacy",
  "Privacy Policy | Zavi",
  "Zavi privacy policy. What we collect, why, and how we handle your data.",
);

const LAST_UPDATED = "2026-11-02";

const link =
  "font-medium text-[#0e0f11] underline underline-offset-2 transition-opacity hover:opacity-70";
const code =
  "rounded-[4px] bg-[#f0f0f0] px-1.5 py-0.5 text-[13px] font-medium text-[#1f1f1f]";

type Section = { id: string; title: string; body: React.ReactNode };

const SECTIONS: Section[] = [
  {
    id: "collect",
    title: "What we collect",
    body: (
      <>
        <p>We collect the minimum needed to operate Zavi for you:</p>
        <ul className="flex flex-col gap-1 pl-6">
          <li><strong>Account information.</strong> Email, name, and optional company name when you sign up.</li>
          <li><strong>Signup location.</strong> Where available, we retain the approximate country and city of your signup request from our hosting provider for internal customer reporting. We do not store your IP address in this reporting record, request precise device location, or replace it with the location of later sign-ins.</li>
          <li><strong>Authentication identifiers.</strong> OAuth subject IDs from GitHub or Google when you choose those sign-in methods. We do not receive your password.</li>
          <li><strong>Connector data.</strong> When you connect Slack, GitHub, or another integration, we receive the data those connectors are scoped to read. We store OAuth tokens in Supabase Vault and never expose them to the client browser.</li>
          <li><strong>Content you send to agents.</strong> Your messages, the files and images you attach, and the connector data an agent reads to answer you. To generate a response, this content is sent to the foundation model providers listed in our{" "}
            <a href="/legal/subprocessors" className={link}>sub-processors</a> page, and may pass through our model gateway in transit. Those providers process it to return a response and are contractually barred from using it to train their models.</li>
          <li><strong>Usage telemetry.</strong> Public funnel page views, whitelisted product events, agent run IDs, run latency, and cost. Our own telemetry pipeline does not record raw model inputs, raw model outputs, prompts, or user content. Internal agent telemetry is whitelisted to <code className={code}>{`{ tool_name, ms, code, iter }`}</code>. That is a statement about telemetry specifically, not about the Service as a whole: the content you send to an agent does reach model providers, as described directly above.</li>
          <li><strong>Reports you send from chat.</strong> If you send us a report from chat, we keep your note and a link to that chat for up to 180 days to fix the problem.</li>
          <li><strong>Cookies.</strong> First-party session cookies set by Supabase Auth to keep you signed in, and first-party analytics storage used by PostHog, Mixpanel and Google Analytics, which you can <strong>turn off at any time</strong> in the cookie banner. We do not use advertising cookies or advertising trackers. PostHog session recordings hide passwords, login codes, API keys and email addresses in your browser before anything is sent; the cookie policy has the details. Our{" "}
            <a href="/cookie-policy" className={link}>cookie policy</a> lists every cookie and storage key by name. You can change your choice at any time from the &ldquo;Cookie preferences&rdquo; control in the footer or on your account page, and you can ask us to delete analytics data associated with you by emailing{" "}
            <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a>.</li>
        </ul>
      </>
    ),
  },
  {
    id: "why",
    title: "Why we collect it",
    body: (
      <p>
        We use the data above to (a) operate the Service, (b) generate agent outputs you
        requested, (c) keep you signed in, (d) bill you if you are on a paid plan, and (e)
        communicate service-related notices. We do not sell your data and we do not use it to
        train any foundation model.
      </p>
    ),
  },
  {
    id: "share",
    title: "How we share it",
    body: (
      <>
        <p>
          We share data with our sub-processors to operate the Service. Each one is contractually
          limited to processing your data on our behalf, for a stated purpose. The complete,
          current list (what each vendor is for, which ones are engaged only if you use a
          particular feature, and how we announce changes) is on our{" "}
          <a href="/legal/subprocessors" className={link}>sub-processors</a> page. It is part of
          this policy.
        </p>
        <p>
          Separately, integrations you connect yourself (Slack, GitHub, Google, Meta and the
          others listed on that page) receive data at your direction, under the scopes you approve.
          Disconnecting one ends our access.
        </p>
        <p>
          We do not share your data with any other third party except (i) at your direction, (ii)
          to comply with a valid legal demand, or (iii) to protect our or others&apos; rights or
          safety. We do not sell your data.
        </p>
      </>
    ),
  },
  {
    id: "where",
    title: "Where your data lives",
    body: (
      <p>
        All production data is hosted in AWS <code className={code}>us-west-1</code> (Northern
        California). Data is encrypted at rest by Supabase and AWS, and encrypted in transit over
        TLS 1.2+. We do not offer EU residency at this time; if that&apos;s a requirement for you,
        contact us.
      </p>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <>
        <p>
          We keep each category of data only as long as it is needed for the purpose it was
          collected for:
        </p>
        <ul className="flex flex-col gap-1 pl-6">
          <li><strong>Account information and connector tokens</strong>: for as long as your account is active.</li>
          <li><strong>Your messages, agent runs and the content attached to them</strong>: for as long as your account is active, unless you delete them sooner.</li>
          <li><strong>Indexed Slack messages</strong>: 90 days, then deleted on a rolling basis.</li>
          <li><strong>Meeting recordings</strong>: deleted after transcription; if processing or that deletion fails, the recording can remain with our vendor. Transcripts and the notes distilled from them are kept for as long as your account is active.</li>
          <li><strong>Usage telemetry and agent run metrics</strong>: for as long as your account is active.</li>
          <li><strong>AI-assistant connection and tool-call records</strong>: for as long as your account is active.</li>
          <li><strong>Reports you send from chat</strong>: up to 180 days, then deleted.</li>
          <li><strong>Billing and tax records</strong>: up to 7 years, because we are required to keep them.</li>
        </ul>
        <p>
          You can delete your account yourself under Account (
          <a href="https://www.zaviagent.com/account" className={link}>www.zaviagent.com/account</a>
          ), or email{" "}
          <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a> and we
          will do it for you. Either way it is deactivated straight away. To have the above erased,
          email <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a>{" "}
          and we will delete it, except records we are legally required to retain.
        </p>
      </>
    ),
  },
  {
    id: "breach",
    title: "If something goes wrong",
    body: (
      <p>
        If we discover a breach of security that compromises your personal data, we will notify you
        and any regulator that must be told, without undue delay and within the deadlines the
        applicable law sets. The notice will tell you what happened, what data was involved, and
        what we are doing about it. Customers on a signed Data Processing Addendum receive notice
        on the timeline set out in that agreement.
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <p>
        Depending on your jurisdiction, you may have the right to access, correct, port, or delete
        the personal data we hold about you, and to object to or restrict certain processing. To
        exercise any right, email{" "}
        <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a>. We
        confirm receipt within 10 business days and respond within one month. If a request is
        complex, we will tell you before that month ends, say why, and give a new date, never
        later than the law allows: two further months under the GDPR, or a further 45 days under
        the CCPA. We may need to verify your identity before acting on a request for access,
        deletion or correction. You may use an authorised agent, who must provide proof that you
        permitted them to act for you. If we decline a request, you may appeal by replying to our
        response; we will give you a written decision on the appeal. If you are in California, see
        the California section below. If you are in the EU or UK, see the EU / UK section.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        Zavi is a B2B service for adults. You must be at least 18 to hold an account, as required
        by our <a href="/terms" className={link}>Terms of Service</a>. We do not knowingly collect
        data from anyone under 18. If we learn that we have, we will delete the account and the
        associated personal data promptly.
      </p>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        We follow defense-in-depth practices: per-tenant row-level security in Postgres,
        Vault-stored OAuth tokens, no service-role credentials in the browser bundle (CI enforced),
        and prod secrets in AWS Secrets Manager with least-privilege IAM. For more, see our{" "}
        <a href="/security" className={link}>Security page</a>. If you believe you&apos;ve found a
        vulnerability, please report it to{" "}
        <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a>.
      </p>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <p>
        If you access the Service from outside the United States, you understand that your data
        will be processed in the United States. When we transfer personal data from the EU/UK to
        the U.S., we rely on Standard Contractual Clauses with our sub-processors.
      </p>
    ),
  },
  {
    id: "california",
    title: "California (CCPA / CPRA)",
    body: (
      <p>
        California residents have the right to know what categories of personal information we
        collect, the categories of sources, the business purposes, and the categories of third
        parties with whom we share it. That is described in the collection, purpose and sharing
        sections above, together with our{" "}
        <a href="/legal/subprocessors" className={link}>sub-processors</a> page. The categories we
        collect are identifiers, commercial information, internet and network activity, user
        content, and (because we hold the OAuth tokens you grant us) account access credentials,
        which California treats as sensitive personal information. We use those tokens only to
        operate the connectors you authorised, which is a use that does not trigger the right to
        limit. We do not sell personal information and we do not share it for cross-context
        behavioural advertising, so we do not offer a &ldquo;Do Not Sell or Share&rdquo; link;
        should that ever change, we will honour opt-out preference signals including Global Privacy
        Control. You can request access, deletion, correction or portability by emailing{" "}
        <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a>, and we
        will not discriminate against you for exercising any of these rights.
      </p>
    ),
  },
  {
    id: "eu-uk",
    title: "EU / UK (GDPR)",
    body: (
      <p>
        If you are in the EU or UK, your lawful bases for processing are: (a) performance of a
        contract (to operate the Service), (b) legitimate interests (to improve and secure the
        Service), and (c) consent where we explicitly ask for it (e.g., marketing emails). You have
        the right to lodge a complaint with your local supervisory authority.
      </p>
    ),
  },
  {
    id: "meetings",
    title: "Meeting recording and transcription",
    body: (
      <>
        <p>
          If you turn on the Zavi Notetaker, a bot joins the meetings you schedule it for on Zoom,
          Google Meet or Microsoft Teams, and transcribes them so your agents can use what was
          decided. We use <a href="https://recall.ai" target="_blank" rel="noreferrer" className={link}>Recall.ai</a>{" "}
          to operate the bot.
        </p>
        <ul className="flex flex-col gap-1 pl-6">
          <li>
            <strong>The bot announces itself.</strong> It joins under a visible name and posts a
            message stating that it is recording and transcribing. That message cannot be
            removed.
          </li>
          <li>
            <strong>The recording is deleted after transcription.</strong> We keep the derived
            transcript and the notes distilled from it, and the recording is deleted at our vendor
            as well. If processing or that deletion fails, the recording can remain with our
            vendor.
          </li>
          <li>
            <strong>It joins only meetings you send it to.</strong> That is the meeting link and
            times you set in workspace settings, or a meeting someone in your workspace asks it to
            join now.
          </li>
          <li>
            <strong>Getting consent is your responsibility.</strong> Several U.S. states, including
            California, Florida, Illinois, Pennsylvania and Washington, require every participant to
            consent before a call is recorded. We give you the announcement and the controls; you
            are the one in the room. Do not use the Notetaker where you do not have every
            participant&apos;s consent.
          </li>
          <li>
            <strong>Turning it off.</strong> Disable the Notetaker in workspace settings and it
            stops joining. To have stored transcripts and notes deleted, see{" "}
            <a href="/legal/data-deletion" className={link}>Data deletion</a>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "ai-assistants",
    title: "Using Zavi from AI assistants",
    body: (
      <>
        <p>
          You can connect Zavi to an AI assistant such as Claude, ChatGPT or Codex. The assistant
          then talks to Zavi through our connector at{" "}
          <code className={code}>api.zaviagent.com/mcp</code>, using the permissions you approve on a Zavi sign-in screen. Setup and the full tool list are on our{" "}
          <a href="/docs/ai-clients" className={link}>AI assistants</a> page.
        </p>
        <ul className="flex flex-col gap-1 pl-6">
          <li>
            <strong>What we receive.</strong> The requests your assistant sends to Zavi and the
            inputs to each tool it calls. A request that starts an agent run, such as a question you
            ask Zavi, is stored with that run like any run you start in Zavi. When the assistant marks
            a growth step done or reports a goal&apos;s number, what it says changed and the number
            are stored in your workspace. Searches and reads are not stored, apart from the call
            record below.
          </li>
          <li>
            <strong>What we store about the connection.</strong> The assistant&apos;s registration
            details (its name and the addresses it returns to after sign-in), the permissions you
            approved and the workspace you connected, and access and refresh tokens, stored only as
            one-way hashes. Access tokens expire after 1 hour and refresh tokens after 30 days.
          </li>
          <li>
            <strong>What we log.</strong> For every tool call: the tool, your user and workspace, a
            one-way hash of the inputs, a one-way hash of the IP address, how long the call took and
            whether it worked. We do not log the content of the request or the response. We use
            these records for security, abuse prevention and troubleshooting.
          </li>
          <li>
            <strong>What we send to the assistant.</strong> Only what it asks for on your behalf,
            from the workspace you connected: agent answers, run results, notes from your company
            brain, and your goals and open growth steps. Once that content reaches the assistant, its
            provider (for example Anthropic or OpenAI) processes it under its own terms and privacy
            policy. Zavi never sees your other conversations with the assistant.
          </li>
          <li>
            <strong>Your controls.</strong> Disconnect Zavi in the assistant&apos;s settings at any
            time. To revoke every assistant connection from Zavi&apos;s side, email{" "}
            <a href="mailto:developer@zaviagent.com" className={link}>developer@zaviagent.com</a>.
            Workspace owners and admins can revoke personal access tokens in Zavi under Settings → MCP. Every right in
            this policy applies to this data too.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "slack-content",
    title: "Slack workspace content",
    body: (
      <>
        <p>
          If you connect Slack and grant message scopes, we index messages the Zavi bot receives so
          your agents can answer questions about what your team has already discussed. This covers
          public channels the bot has been invited to, private channels it has been invited to,
          direct messages with the bot, and group DMs it is a member of. It does not cover
          conversations the bot is not part of.
        </p>
        <ul className="flex flex-col gap-1 pl-6">
          <li>
            <strong>Sensitive values are stripped before storage.</strong> Every string in an
            incoming Slack event is run through a redactor before the row is written: email
            addresses, phone numbers, U.S. Social Security numbers, credit-card numbers, and
            authentication tokens and API keys.
          </li>
          <li>
            <strong>Slack&apos;s own visibility rules are enforced.</strong> An agent only surfaces
            content from conversations the person asking is a member of.
          </li>
          <li>
            <strong>Retention is 90 days.</strong> Indexed messages older than 90 days are deleted
            on a rolling basis by a daily job.
          </li>
          <li>
            <strong>Deletions follow through.</strong> Deleting a message in Slack deletes the
            indexed row and any note distilled from it. Editing re-runs the redactor. Uninstalling
            the Slack app purges the workspace.
          </li>
          <li>
            <strong>You can switch indexing off.</strong> Uninstall the Zavi Slack app, or email{" "}
            <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a> and we
            will turn indexing off. Either stops new writes and purges the indexed content along
            with any notes distilled from it. It also covers your colleagues: this content includes messages written by other people in
            your workspace, so you are responsible for telling your team that Zavi is connected.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "google-ads",
    title: "Google Ads data",
    body: (
      <p>
        If you connect your Google Ads account, the Zavi Ads Manager agent uses the Google Ads API
        on your behalf. We read campaign structure and performance data (campaigns, ad groups, ads,
        keywords, budgets, and metrics such as impressions, clicks, conversions, and cost) to
        generate recommendations. We write changes back to Google Ads (budget shifts, campaign status, ad updates) only after you explicitly approve the specific change. Google Ads data
        is stored in AWS <code className={code}>us-west-1</code>, encrypted at rest and in transit;
        Google OAuth tokens are held in Supabase Vault and never exposed to the browser. We use this
        data solely to operate the Ads Manager for you, we do not sell or share it beyond the
        sub-processors above, and we do not use it to train any foundation model. Our use of Google
        data complies with the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer" className={link}>
          Google API Services User Data Policy
        </a>
        , including its Limited Use requirements. Disconnecting the integration revokes our access
        immediately. Full detail:{" "}
        <a href="/integrations/google-ads" className={link}>Zavi &amp; the Google Ads API</a>.
      </p>
    ),
  },
  {
    id: "meta-ads",
    title: "Meta (Facebook and Instagram) Ads data",
    body: (
      <p>
        If you connect your Meta ad account, Zavi&apos;s Meta Ads channel (the{" "}
        <code className={code}>meta_ads</code> agent) uses the Meta Marketing API on your behalf
        under the <code className={code}>ads_read</code> and{" "}
        <code className={code}>ads_management</code> permissions you grant at the Facebook consent
        dialog. We read ad-account structure and performance data (campaigns, ad sets, ads,
        budgets, and metrics such as impressions, clicks, conversions, spend, CPA, and ROAS) to
        generate recommendations. If you also allow access to your Facebook Page (the{" "}
        <code className={code}>pages_show_list</code>,{" "}
        <code className={code}>pages_manage_ads</code> and{" "}
        <code className={code}>pages_read_engagement</code> permissions), we read which Pages your
        ad account can promote and your Page&apos;s recent posts with their like, comment and share
        counts, only so you can pick a post to boost; boosting creates a paused ad that spends
        nothing until you turn it on. We write changes to your ad account (new ads and campaigns,
        budget shifts, campaign and ad-set status) only when you approve that specific change, or,
        if you turn on Autopilot with an ad budget, within the limits you set. We do not read your
        Facebook profile, friends, messages, or any personal content, and we do not request
        permissions beyond the ads and Page scopes above and{" "}
        <code className={code}>leads_retrieval</code>, which we use only to read your lead
        forms&apos; questions and lead counts, never the leads themselves. Meta data is stored in AWS{" "}
        <code className={code}>us-west-1</code>, encrypted at rest and in transit; the Meta OAuth
        access token is held in Supabase Vault and never exposed to the browser. We use this data
        solely to operate Zavi&apos;s Meta Ads channel for you, we
        do not sell or share it beyond the sub-processors above, and we do not use it to train any
        foundation model. Disconnecting the integration in Zavi, or removing Zavi from{" "}
        <a href="https://www.facebook.com/settings?tab=applications" target="_blank" rel="noreferrer" className={link}>
          your Facebook Apps and Websites settings
        </a>
        , revokes our access. See{" "}
        <a href="/legal/data-deletion" className={link}>Data deletion</a> for how to have the stored
        data removed.
      </p>
    ),
  },
  {
    id: "chrome-extension",
    title: "Zavi Chrome extension",
    body: (
      <>
        <p>
          The Zavi Chrome extension is a side panel for your Zavi account. You ask about the
          browser tab you are on, or ask Zavi to do something in it, and Zavi answers in the panel
          or works in that tab. This section describes the extension specifically. Everything else
          on this page applies to it as well.
        </p>
        <ul className="flex flex-col gap-1 pl-6">
          <li>
            <strong>When a screenshot is taken.</strong> When you press Send in the panel, every
            time you press Send, including follow-up messages, and at each step while Zavi is
            working in your tab. There is no preview step. The extension does not capture anything
            when you open the panel, switch tabs, or load a page yourself.
          </li>
          <li>
            <strong>What we receive with each message.</strong> A screenshot of the visible part of
            the tab you are on (scaled down to at most 1568 pixels on its longest side), the tab&rsquo;s
            web address with the query string and fragment removed, and the tab title. If a page
            cannot be captured, for example Chrome&rsquo;s own pages or the Chrome Web Store, we receive
            your message as text only and the panel tells you so.
          </li>
          <li>
            <strong>When Zavi works in your tab.</strong> If you ask Zavi to do something in the
            tab, it works there using the accounts you are already logged into. It clicks, types,
            scrolls and opens pages on the same website, and Chrome shows a bar saying the tab is
            being controlled while it works. With each step we receive a screenshot of the tab, the
            tab&rsquo;s list of buttons and fields, the page address, and what the step did. Before
            any step that clearly spends money (publishing an ad, changing a budget, paying or checking
            out), Zavi stops and asks you to confirm in the panel. Press Stop or close the panel at
            any time to stop it. It never works in a tab you didn&rsquo;t ask it to, and it stops if
            a step takes the tab to a different website.
          </li>
          <li>
            <strong>A screenshot is not filtered.</strong> It shows whatever was visible in the tab,
            which can include names, messages from other people, figures, or anything else on
            screen. We do not blank out parts of it. Only press Send on a tab you are comfortable
            sharing with your Zavi account.
          </li>
          <li>
            <strong>What Zavi does with it.</strong> Zavi uses the screenshot, address and title to
            answer your message and, if you ask, to carry out the request in the tab or through the
            tools connected to your Zavi account, the same as Zavi chat on the web or on your
            phone. Actions your account requires approval for are shown in the panel for you to
            approve or reject.
          </li>
          <li>
            <strong>Agreement first.</strong> Before the first screenshot is sent, the extension
            asks you to agree to this section, including that Zavi clicks, types and moves around
            the tab when you ask. Chrome may also ask whether Zavi can capture pages. Until you
            agree, no screenshot is sent and Zavi does not work in the tab.
          </li>
          <li>
            <strong>What we store, and where.</strong> The screenshot is stored with your message in
            your own Zavi account, the same way an image you paste into Zavi chat is stored, in AWS{" "}
            <code className={code}>us-west-1</code>, encrypted at rest and in transit. The address
            and title are stored with the message. Of the screenshots taken while Zavi works in your
            tab, we keep up to 5 from each task, stored the same way. Page content is never written
            into our internal operational telemetry.
          </li>
          <li>
            <strong>Who can see it.</strong> Zavi staff supporting your account, and Zavi&rsquo;s own
            review of answer quality, which is how we find and fix answers that were wrong. That is
            what the agreement asks you to agree to. Nobody else sees it.
          </li>
          <li>
            <strong>What we do not do with it.</strong> We do not sell it. We do not transfer it to
            advertising platforms, data brokers, or anyone who resells information. We do not use it
            for advertising of any kind. We do not use it to train any foundation model. We do not
            use it for credit or lending decisions. Our use of information received from the Chrome
            extension follows the{" "}
            <a
              className={link}
              href="https://developer.chrome.com/docs/webstore/program-policies/user-data-faq"
              target="_blank"
              rel="noopener noreferrer"
            >
              Chrome Web Store User Data Policy
            </a>
            , including its Limited Use requirements.
          </li>
          <li>
            <strong>Changing your mind.</strong> Open settings in the Zavi side panel and turn page
            reading off. The extension stops sending screenshots, any task running in your tab
            stops, and the screenshots it already sent for you are deleted, including the ones kept
            from tasks. You can also remove Zavi&rsquo;s site access from Chrome&rsquo;s
            extension settings, or remove the extension. To ask us to delete everything, see{" "}
            <a className={link} href="/legal/data-deletion">
              Data deletion
            </a>
            .
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "growth-scores",
    title: "Growth scores of public websites",
    body: (
      <>
        <p>
          Zavi scores some business websites on its own initiative, using the same free growth check
          anyone can run at zaviagent.com/start, for its public Growth Leaderboard and for research we
          publish as totals. Sites come from public lists of recently launched products.
        </p>
        <ul className="mt-3 list-disc pl-5">
          <li>
            <strong>What we read:</strong> only what is public: the site&apos;s pages, where it appears
            in Google results, whether AI assistants name it, Google PageSpeed results, how the site
            looks on a phone, and the contact email address the site itself publishes. We never log in
            anywhere and never guess or buy email addresses.
          </li>
          <li>
            <strong>The notice:</strong> before a site we scored appears on the leaderboard, we send one
            email to the contact address on that site saying what we scored, with a link to the full
            result and a link to remove it. We send no further emails about it. A site with no
            same-domain contact address is never listed.
          </li>
          <li>
            <strong>Removing it:</strong> the removal link in that email, or the &ldquo;Remove this
            listing&rdquo; link on the result page (confirmed from an address at the site&apos;s own
            domain), takes the listing down at once, and that domain is never scanned or listed again.
            You can also write to support@zaviagent.com.
          </li>
          <li>
            <strong>How long:</strong> a result expires after 90 days. We keep the domain of a removed
            site, and a record of the one notice (the domain, the address we wrote to and when), so we
            can keep those promises.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "data-deletion",
    title: "Deleting your data",
    body: (
      <p>
        You can ask us to delete the data we hold about you at any time, including data we obtained
        from a connected third-party account such as Meta or Google. Disconnecting a connector
        revokes our access immediately; deleting your Zavi account removes stored account and
        connector data within 30 days, except records we are legally required to retain. Full
        step-by-step instructions, including what to do if you no longer have access to your Zavi
        account, are on our{" "}
        <a href="/legal/data-deletion" className={link}>Data deletion</a> page.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We may update this Privacy Policy from time to time. Material changes will be communicated
        by email or in-product notice at least 14 days before they take effect.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        <strong>Zavi Labs, Inc.</strong> is the controller of the personal data described in this
        policy. 39763 Fog Shrew Rd, Newark, CA 94560. Contact{" "}
        <a href="mailto:support@zaviagent.com" className={link}>support@zaviagent.com</a> with any
        privacy question, or to exercise any of the rights described above.
      </p>
    ),
  },
];

const TOC: TocItem[] = SECTIONS.map((s) => ({ id: s.id, label: s.title }));

export default async function PrivacyPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-white text-ink selection:bg-ink selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <LegalHero
        kicker="Privacy Policy"
        title="Privacy Policy."
        subtitle={
          <>
            Last updated <strong className="font-bold text-[#191919]">{LAST_UPDATED}</strong>.
            Privacy questions:{" "}
            <a href="mailto:support@zaviagent.com" className="text-[#191919] underline underline-offset-2 hover:opacity-70">
              support@zaviagent.com
            </a>
            .
          </>
        }
      />

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
