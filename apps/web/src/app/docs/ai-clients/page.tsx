import type { Metadata } from "next";
import { marketingPageMetadata } from "@/lib/marketing/pageMetadata";
import Link from "next/link";
import { resolveMarketingSession } from "@/lib/resolveCta";
import { GrowthHeader } from "@/components/marketing/growth-home/GrowthHeader";
import { GrowthFooter } from "@/components/marketing/growth-home/GrowthFooter";

export const metadata: Metadata = marketingPageMetadata(
  "/docs/ai-clients",
  "Use Zavi from Claude, ChatGPT and Codex | Zavi",
  "Connect Zavi to Claude, ChatGPT or Codex: ask Zavi for growth work, work through your next growth steps and search your company brain from the chat.",
);

const LAST_UPDATED = "2026-11-02";
const MCP_URL = "https://api.zaviagent.com/mcp";
const CONTACT = "developer@zaviagent.com";

const TOOLS: Array<{ name: string; does: string; changes: string }> = [
  { name: "Ask Zavi", does: "Sends a question or task to Zavi. Zavi answers it or hands it to the right specialist agent.", changes: "Starts a run." },
  { name: "Run a Zavi agent", does: "Starts one agent you name.", changes: "Starts a run." },
  { name: "Get run status", does: "Shows whether a run has finished, and its result.", changes: "Read-only." },
  { name: "List recent runs", does: "Lists your workspace's latest runs.", changes: "Read-only." },
  { name: "List Zavi agents", does: "Lists the agents your workspace can use.", changes: "Read-only." },
  { name: "Read company brain", does: "Reads the notes Zavi keeps about your company.", changes: "Read-only." },
  { name: "Search Zavi workspace", does: "Searches your notes and runs.", changes: "Read-only." },
  { name: "Fetch a search result", does: "Opens one search result in full.", changes: "Read-only." },
  { name: "Get the next growth step", does: "Shows your active goals, the open steps Zavi wants done with the test behind each, and the tests due for a readout.", changes: "Read-only." },
  { name: "Mark a growth step done", does: "Records that a step is done and what changed. Zavi counts it as launched for the step's test.", changes: "Updates the step in Zavi." },
  { name: "Report a goal's number", does: "Saves a goal's current number as your own number.", changes: "Updates the goal in Zavi." },
];

const PROMPTS = [
  "What is my next growth step in Zavi?",
  "Ask Zavi what is holding back signups this month and what it would try first.",
  "Search my Zavi company brain for our pricing notes and summarize them.",
  "Show my recent Zavi runs and the result of the latest one.",
  "Which Zavi agents can I run?",
  "Ask Zavi to draft three LinkedIn posts for our launch next week.",
];

const TROUBLESHOOTING: Array<{ see: string; fix: string }> = [
  { see: "The sign-in window doesn't open", fix: "Allow pop-ups for your assistant's site and try again." },
  { see: "“agent … not found, or your role is read-only”", fix: "Your plan doesn't include that agent, or your workspace role can only read. Check Settings in Zavi." },
  { see: "“scope_denied”", fix: "Disconnect, connect again, and approve every permission." },
  { see: "“Your role in this workspace cannot mark steps done”", fix: "Your workspace role can only read. Ask a workspace owner or admin to change it." },
  { see: "“Only an owner or admin of this workspace can report a goal's number”", fix: "Ask a workspace owner or admin to report it, or to change your role." },
  { see: "“This goal is measured by a connected source”", fix: "Zavi reads this goal's number itself, so there is nothing to report." },
  { see: "“rate_limited”", fix: "Wait a minute, then try again." },
  { see: "An out-of-credits message", fix: "A workspace owner or admin can check the balance or top up in Zavi under Settings → Billing & Credits." },
  { see: "Results from the wrong company", fix: "You approved a different workspace. Switch workspace in Zavi, then disconnect and connect again." },
  { see: "Your assistant says it's no longer authorized", fix: "Disconnect and connect again." },
];

const link = "text-violet underline underline-offset-2";

export default async function AiClientsDocsPage() {
  const { cta, email } = await resolveMarketingSession();
  return (
    <main className="min-h-screen bg-cream text-ink selection:bg-violet selection:text-white">
      <GrowthHeader cta={cta} email={email} />
      {}
      <div aria-hidden="true" className="h-20 md:h-[100px]" />

      <section className="border-b border-ink/10">
        <div className="mx-auto max-w-[860px] px-6 md:px-10 pt-10 md:pt-12 pb-5 md:pb-6">
          <div className="kicker text-violet">Docs · AI assistants</div>
          <h1 className="mt-2 font-display font-semibold tracking-tightest leading-[1.0] text-[30px] md:text-[40px] text-ink">
            Use Zavi from Claude, ChatGPT and Codex.
          </h1>
          <p className="mt-3 text-[16px] text-inkMuted">
            Zavi is an AI growth agent for your business. Connect it to your assistant once with your
            Zavi login, then ask Zavi for growth work, work through your next growth steps and search
            your company brain without leaving the chat. Last updated{" "}
            <strong>{LAST_UPDATED}</strong>. Questions:{" "}
            <a href={`mailto:${CONTACT}`} className={link}>
              {CONTACT}
            </a>
            .
          </p>
        </div>
      </section>

      <article className="mx-auto max-w-[860px] px-6 md:px-10 py-10 md:py-14">
        <Section n="1" title="What you need">
          <ul>
            <li>
              A Zavi account. Create one free at{" "}
              <Link href="/" className={link}>
                www.zaviagent.com
              </Link>
              .
            </li>
            <li>
              A Claude account (claude.ai, Claude Desktop, Claude mobile or Claude Code), a ChatGPT
              account that can add custom MCP servers, or the Codex CLI.
            </li>
          </ul>
          <p>
            The connection uses the Zavi workspace that is active when you approve it. To connect a
            different workspace, switch to it in Zavi first, then connect again.
          </p>
        </Section>

        <Section n="2" title="Connect">
          <p>
            <strong>Claude (web, desktop and mobile)</strong>
          </p>
          <ol>
            <li>
              In Claude, open <strong>Customize → Connectors</strong> and add a custom connector
              with the URL <code>{MCP_URL}</code>.
            </li>
            <li>Select <strong>Connect</strong>. A Zavi sign-in window opens.</li>
            <li>Sign in, check the workspace name, and select <strong>Approve</strong>.</li>
            <li>
              In a chat, turn Zavi on from <strong>+ → Connectors</strong>.
            </li>
          </ol>
          <p>
            <strong>Claude Code</strong>
          </p>
          <pre className="overflow-x-auto rounded bg-ink/5 px-3 py-2 text-[14px]">
            <code>claude mcp add --transport http zavi {MCP_URL}</code>
          </pre>
          <p>
            Then run <code>/mcp</code> and finish signing in in your browser.
          </p>
          <p>
            <strong>ChatGPT</strong>
          </p>
          <ol>
            <li>
              Open <strong>chatgpt.com/plugins</strong>, select <strong>+</strong>, then{" "}
              <strong>Add custom MCP server</strong>.
            </li>
            <li>
              Name it Zavi, enter the URL <code>{MCP_URL}</code>, and choose OAuth with no client ID
              or secret.
            </li>
            <li>
              Accept the warning and select <strong>Create as a plugin</strong>. Then open Zavi under
              your personal plugins and select <strong>+</strong> to install it.
            </li>
            <li>
              On the home page, switch from <strong>Chat</strong> to <strong>Work</strong>, start a
              new chat, type <strong>@</strong> and pick Zavi.
            </li>
            <li>Sign in, check the workspace name, and select <strong>Approve</strong>.</li>
          </ol>
          <p>
            <strong>Codex CLI</strong>
          </p>
          <pre className="overflow-x-auto rounded bg-ink/5 px-3 py-2 text-[14px]">
            <code>{`codex mcp add zavi --url ${MCP_URL}\ncodex mcp login zavi`}</code>
          </pre>
          <p>
            Sign in and approve in your browser. Check the connection with <code>/mcp</code> inside
            Codex.
          </p>
        </Section>

        <Section n="3" title="What you're approving">
          <p>The Zavi sign-in screen lists three permissions:</p>
          <ul>
            <li>
              <strong>Read your agents, runs, and company brain:</strong> see which agents your
              workspace has, the runs they made, your goals and open growth steps, and the notes Zavi
              keeps about your business.
            </li>
            <li>
              <strong>Run agents on your behalf:</strong> start agent runs in your workspace, mark a
              growth step done, and report a goal&apos;s number.
            </li>
            <li>
              <strong>Stay connected without re-logging in:</strong> keep the connection signed in
              so you aren&apos;t asked every hour.
            </li>
          </ul>
          <p>You never paste a password or key into your assistant.</p>
        </Section>

        <Section n="4" title="What your assistant can do">
          <ul>
            {TOOLS.map((t) => (
              <li key={t.name}>
                <strong>{t.name}.</strong> {t.does} <em>{t.changes}</em>
              </li>
            ))}
          </ul>
          <p>
            A Zavi run takes a little time. Your assistant starts it, then checks back for the result.
            If it stops before the result arrives, ask &ldquo;Is my Zavi run done yet?&rdquo;
          </p>
          <p>
            <strong>Working through growth steps.</strong> Your assistant can get your next step. You
            do the step yourself, or ask your assistant to do it with a tool you connected to it, and
            your assistant marks it done in Zavi. On a test&apos;s readout date it can report the
            goal&apos;s number. A step Zavi carries out itself stays in Zavi and follows your approval
            settings there. A goal Zavi measures from a connected source can&apos;t be changed this
            way.
          </p>
        </Section>

        <Section n="5" title="Try these">
          <ul>
            {PROMPTS.map((p) => (
              <li key={p}>&ldquo;{p}&rdquo;</li>
            ))}
          </ul>
        </Section>

        <Section n="6" title="Approvals and limits">
          <ul>
            <li>
              <strong>Your workspace only.</strong> Your assistant sees only the workspace you
              approved. It can&apos;t see other Zavi customers&apos; data.
            </li>
            <li>
              <strong>Ad changes from Zavi need your approval.</strong> A change to ad spend or
              campaigns that Zavi makes from a run you started in your assistant is never applied
              without your approval in Zavi, even with Autopilot on, a spend cap set, or a custom agent
              doing the work. A change you ask your assistant to make with its own tools doesn&apos;t
              go through Zavi. Posting on social media and sending email follow your approval settings,
              the same as when you run the work in Zavi.
            </li>
            <li>
              <strong>No AI media or payments from your assistant.</strong> Runs started from your
              assistant don&apos;t generate AI images, video or audio, and don&apos;t take or send
              payments. Do those in the Zavi app. If a run from your assistant proposes recurring work and you approve it in Zavi, those
              later runs follow the normal Zavi rules.
            </li>
            <li>
              <strong>Credits.</strong> Runs started from your assistant use your Zavi credits, the
              same as runs started in Zavi.
            </li>
            <li>
              <strong>Rate limits.</strong> Up to 60 requests a minute per connection, and up to 10
              named agent runs a minute per workspace.
            </li>
          </ul>
        </Section>

        <Section n="7" title="What data is shared">
          <ul>
            <li>Your assistant sends Zavi your request and the inputs to each tool it calls.</li>
            <li>
              Zavi sends back what you asked for: answers, run results, notes from your company brain,
              and your goals and open growth steps. Once that content is in your chat, your
              assistant&apos;s provider (Anthropic or OpenAI) handles it under its own privacy policy.
            </li>
            <li>
              A question you ask Zavi, and the run it starts, is saved in your workspace like any
              run you start in Zavi. So is what your assistant says changed when it marks a step done,
              and a number it reports. Searches and reads are not saved.
            </li>
            <li>
              Zavi logs each tool call: which tool, when, how long it took, and whether it worked. The
              log does not include what you asked or what came back.
            </li>
          </ul>
          <p>
            Details are in the{" "}
            <Link href="/privacy" className={link}>
              Zavi privacy policy
            </Link>
            .
          </p>
        </Section>

        <Section n="8" title="Disconnect">
          <ul>
            <li>
              <strong>In Claude:</strong> open <strong>Customize → Connectors</strong>, select Zavi
              and remove it.
            </li>
            <li>
              <strong>In ChatGPT:</strong> remove Zavi from your plugins at{" "}
              <strong>chatgpt.com/plugins</strong>.
            </li>
            <li>
              <strong>In Codex:</strong> run <code>codex mcp remove zavi</code>.
            </li>
            <li>
              Removing Zavi stops your assistant calling it. It does not by itself revoke the tokens
              Zavi issued.
            </li>
            <li>
              <strong>From Zavi:</strong> email{" "}
              <a href={`mailto:${CONTACT}`} className={link}>
                {CONTACT}
              </a>{" "}
              and we&apos;ll revoke every AI-assistant connection for your account within two
              business days. Owners and admins
              can revoke personal access tokens in Zavi under <strong>Settings → MCP</strong>.
            </li>
          </ul>
        </Section>

        <Section n="9" title="Troubleshooting">
          <ul>
            {TROUBLESHOOTING.map((t) => (
              <li key={t.see}>
                <strong>{t.see}:</strong> {t.fix}
              </li>
            ))}
          </ul>
        </Section>

        <Section n="10" title="Help">
          <p>
            Support and security reports:{" "}
            <a href={`mailto:${CONTACT}`} className={link}>
              {CONTACT}
            </a>
            . See also our{" "}
            <Link href="/privacy" className={link}>
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className={link}>
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
      <div className="text-[16px] leading-[1.7] text-ink/85 space-y-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-1 [&_code]:bg-ink/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:break-words">
        {children}
      </div>
    </section>
  );
}
