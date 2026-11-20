
import { getChannel } from "@zavi/shared";
import { renderEmail } from "../theme";
import { markdownToEmailHtml } from "../markdown-email";

const MAX_SUBJECT_DETAIL = 60;

export const READY_OPENER = "Your agent finished today's run. Here's what it found.";

const FOOTER_NOTE =
  "You're getting this because this address is on your workspace's agent " +
  "email list. Remove it any time in Settings → Notifications.";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BUILTIN_AGENT_NAMES: Readonly<Record<string, string>> = {
  operator: "Zavi",
  advisor: "Advisor",
  "chief-of-staff": "Chief of Staff",
  engineer: "Engineer",
  qa: "QA",
  pm: "Product Manager",
  cgo: "Chief Growth Officer",
  "growth-lead": "Head of Growth",
  "performance-marketer": "Ads Manager",
  "funnel-analysis": "Funnel Analyst",
  "seo-geo": "SEO & AI Search",
  "content-design": "Content Designer",
  "content-seo": "Content Designer",
  "support-lead": "Support Lead",
  "dispute-response": "Dispute Response",
  research: "Research",
  "onboarding-discovery": "Onboarding Discovery",
  "supply-demand-balancer": "Supply & Demand",
  "browser-operator": "Browser Operator",
  fundraising: "Fundraising",
};

function readableAgentName(name: string): string {
  const t = name.trim();
  if (Object.prototype.hasOwnProperty.call(BUILTIN_AGENT_NAMES, t)) return BUILTIN_AGENT_NAMES[t];
  return getChannel(t)?.name ?? t;
}

export function renderAgentResultEmail(args: {
  agentSlug: string;
  agentNameIsTyped?: boolean;
  body: string;
  runUrl: string;
  tenantName?: string;
  ctaText?: string;
  ready?: boolean;
}): { html: string; text: string; subject: string } {
  const ctaText = args.ctaText ?? "Open the run in Zavi";
  const agent = args.agentNameIsTyped ? args.agentSlug.trim() : readableAgentName(args.agentSlug);

  const firstLine =
    args.body
      .split("\n")
      .map((l) => l.replace(/^[#\s>*-]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const detail =
    firstLine.length > MAX_SUBJECT_DETAIL
      ? `${firstLine.slice(0, MAX_SUBJECT_DETAIL - 1).trimEnd()}…`
      : firstLine;
  const subject = args.ready
    ? `${agent} is ready`
    : detail
      ? `${agent}: ${detail}`
      : `${agent}: scheduled run`;

  const html = renderEmail(
    args.ready
      ? {
          preheader: READY_OPENER,
          kicker: "Your agent",
          eyebrow: escapeHtml(agent),
          title: `${escapeHtml(agent)} <em>is ready</em>`,
          intro: READY_OPENER,
          ctaText,
          ctaUrl: args.runUrl,
          body: markdownToEmailHtml(args.body),
          footerNote: FOOTER_NOTE,
          footerVariant: "neutral",
        }
      : {
          preheader: detail || `Your scheduled ${agent} run is ready.`,
          kicker: "Scheduled run",
          eyebrow: escapeHtml(agent),
          title: `${escapeHtml(agent)} <em>ran</em>`,
          intro: args.tenantName
            ? `Here is what it found for ${escapeHtml(args.tenantName)}.`
            : "Here is what it found.",
          ctaText,
          ctaUrl: args.runUrl,
          body: markdownToEmailHtml(args.body),
          footerNote:
            "You're getting this because this address is on your workspace's agent " +
            "email list. Remove it any time in Settings → Notifications.",
          footerVariant: "neutral",
        },
  );

  const text = [
    args.ready ? `${agent} is ready` : `${agent}: scheduled run`,
    "",
    ...(args.ready ? [READY_OPENER, ""] : []),
    args.body,
    "",
    `${ctaText}: ${args.runUrl}`,
    "",
    "Zavi · zaviagent.com",
    "You're on your workspace's agent email list. Remove this address in Settings → Notifications.",
  ].join("\n");

  return { html, text, subject };
}
