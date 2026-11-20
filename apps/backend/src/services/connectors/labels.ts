
import { toolkitDisplayName } from "@/services/connectors/composio/display-name";

const FIRST_PARTY_LABELS: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  jira: "Jira",
  stripe: "Stripe",
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  operator_db: "Your database",
  linear: "Linear",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  discord: "Discord",
  intercom: "Intercom",
  email: "Email",
  linkedin_social: "LinkedIn",
  x_social: "X (Twitter)",
  reddit_social: "Reddit",
  instagram_social: "Instagram",
  tiktok: "TikTok",
};

const PIPEDREAM_NAME_OVERRIDES: Record<string, string> = {
  posthog: "PostHog",
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  clickup: "ClickUp",
  typeform: "Typeform",
  mailchimp: "Mailchimp",
  sendgrid: "SendGrid",
  quickbooks: "QuickBooks",
  woocommerce: "WooCommerce",
  bigquery: "BigQuery",
  dropbox: "Dropbox",
  google_sheets: "Google Sheets",
  google_docs: "Google Docs",
  google_drive: "Google Drive",
  google_calendar: "Google Calendar",
  google_analytics: "Google Analytics",
  google_search_console: "Google Search Console",
  openai: "OpenAI",
  aws: "AWS",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  paypal: "PayPal",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
  microsoft_teams: "Microsoft Teams",
  microsoft_outlook: "Microsoft Outlook",
};

function titleCaseSegment(slug: string): string {
  const seg = String(slug ?? "")
    .split(".")
    .filter(Boolean)
    .pop();
  if (!seg) return "";
  return seg
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function connectorLabel(slug: string): string {
  const s = String(slug ?? "").trim();
  if (!s) return "";

  if (s.startsWith("composio.")) {
    const toolkit = s.slice("composio.".length);
    if (!toolkit) return titleCaseSegment(s);
    return toolkitDisplayName(toolkit);
  }

  if (s.startsWith("pipedream.")) {
    const app = s.slice("pipedream.".length);
    if (!app) return titleCaseSegment(s);
    return PIPEDREAM_NAME_OVERRIDES[app] ?? titleCaseSegment(app);
  }

  if (FIRST_PARTY_LABELS[s]) return FIRST_PARTY_LABELS[s];

  return titleCaseSegment(s);
}

export async function connectorLabelFromCatalog(slug: string): Promise<string> {
  const s = String(slug ?? "").trim();
  if (!s.startsWith("pipedream.")) return connectorLabel(s);

  const app = s.slice("pipedream.".length);
  if (!app) return titleCaseSegment(s);

  try {
    const { getAppName } = await import("@/services/connectors/pipedream/api");
    const name = await getAppName(app);
    if (name) return name;
  } catch {
  }
  return connectorLabel(s);
}
