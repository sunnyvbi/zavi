
import { bulkSendCardFields } from "@zavi/shared";

export type ExactField = { label: string; value: string };

const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function formatMinor(amount: unknown, currency: unknown): string {
  const cur = typeof currency === "string" ? currency.toLowerCase() : "usd";
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "?";
  const major = ZERO_DECIMAL.has(cur)
    ? String(amount)
    : THREE_DECIMAL.has(cur)
      ? (amount / 1000).toFixed(3)
      : (amount / 100).toFixed(2);
  return `${major} ${cur.toUpperCase()}`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function fields(pairs: Array<[string, unknown]>): ExactField[] {
  const out: ExactField[] = [];
  for (const [label, v] of pairs) {
    const value = typeof v === "number" ? String(v) : str(v);
    if (value !== null) out.push({ label, value });
  }
  return out;
}

function fileLines(files: unknown): string | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  return files
    .map((f) => {
      const x = (f ?? {}) as { path?: unknown; action?: unknown; content?: unknown; diff?: unknown };
      const text = typeof x.diff === "string" ? x.diff : typeof x.content === "string" ? x.content : "";
      const lines = text ? text.split("\n").length : 0;
      return `${String(x.path ?? "?")} (${String(x.action ?? "change")}${lines ? `, ${lines} lines` : ""})`;
    })
    .join("\n");
}

export const EMAIL_CAMPAIGN_SEND_CLASS = "email_campaign.create_and_send";
const EMAIL_TOOL_NAMES: Readonly<Record<string, string>> = { mailchimp: "Mailchimp", klaviyo: "Klaviyo", sendgrid: "SendGrid" };

function emailCampaignSendFields(b: Record<string, unknown>): ExactField[] {
  const people = typeof b.approved_count === "number" && Number.isFinite(b.approved_count) ? b.approved_count.toLocaleString("en-US") : null;
  return fields([
    ["Subject", b.subject],
    ["Preview", b.preview_text],
    ["From", typeof b.from_name === "string" && typeof b.from_email === "string" ? `${b.from_name} <${b.from_email}>` : null],
    ["Replies go to", b.reply_to],
    ["Sending with", typeof b.tool === "string" ? (EMAIL_TOOL_NAMES[b.tool] ?? b.tool) : null],
    ["List", b.audience_name],
    ["People", people],
    ["Message", b.body_text],
  ]);
}

export function exactActionFields(decision_class: string | null | undefined, body: unknown): ExactField[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;

  if (decision_class === "send_email") {
    if (typeof b.to !== "string" || typeof b.subject !== "string" || typeof b.body_text !== "string") return null;
    return fields([["To", b.to], ["Reply-To", b.reply_to], ["Subject", b.subject], ["Message", b.body_text]]);
  }
  if (decision_class === "bulk_outbound.send") return bulkSendCardFields(b);
  if (decision_class === EMAIL_CAMPAIGN_SEND_CLASS) {
    if (typeof b.subject !== "string" || typeof b.body_text !== "string" || typeof b.audience_id !== "string") return null;
    return emailCampaignSendFields(b);
  }
  if (b.governed_by !== "chokepoint") return null;

  switch (decision_class) {
    case "create_jira_issue":
      return fields([["Project", b.project_key], ["Type", b.issue_type], ["Summary", b.summary], ["Description", b.description_markdown]]);
    case "jira.add_comment":
      return fields([["Issue", b.issue_key], ["Comment", b.body_markdown]]);
    case "linear.create_issue":
      return fields([["Team", b.team_id], ["Title", b.title], ["Description", b.description_markdown]]);
    case "linear.add_comment":
      return fields([["Issue", b.issue_id], ["Comment", b.body_markdown]]);
    case "github.open_pr_direct":
      return fields([
        ["Repo", b.repo],
        ["Into", b.base_branch],
        ["From branch", b.head_branch],
        ["Title", b.title],
        ["Description", b.body],
        ["Files", fileLines(b.files)],
        ["Push to main", b.push_to_main === true ? "Yes, where this repo allows it. Otherwise a pull request is opened." : null],
      ]);
    case "github.merge_pr_direct":
      return fields([
        ["Repo", typeof b.owner === "string" && typeof b.repo === "string" ? `${b.owner}/${b.repo}` : null],
        ["Pull request", typeof b.pull_number === "number" ? `#${b.pull_number}` : null],
        ["Commit title", b.commit_title],
        ["Commit message", b.commit_message],
        ["Merges only if", "CI is green and the pull request has an approving review"],
      ]);
    case "stripe.create_payment":
      return fields([
        ["Charge", formatMinor(b.amount, b.currency)],
        ["Zavi fee", formatMinor(b.application_fee_amount, b.currency)],
        ["Reference", b.client_reference],
        ["Description", b.description],
        ["Receipt to", b.receipt_email],
      ]);
    case "stripe.remit_to_tenant":
      return fields([
        ["Payout", formatMinor(b.net_minor, b.currency)],
        ["Collected", formatMinor(b.gross_minor, b.currency)],
        ["Reserve kept", formatMinor(b.reserve_minor, b.currency)],
        ["Zavi fee", formatMinor(b.fee_minor, b.currency)],
        ["Reference", b.client_reference],
        ["Description", b.description],
      ]);
    case "dispute-response.submit-evidence":
    case "dispute-response.final-submit-evidence": {
      const p = (b.evidence_packet ?? {}) as { dispute_id?: unknown; evidence_fields?: Record<string, unknown> };
      return fields([
        ["Dispute", p.dispute_id],
        ["Action", b.submit_final === true ? "Submit to Stripe for review (closes the dispute to new evidence)" : "Save as a draft on Stripe"],
        ...Object.entries(p.evidence_fields ?? {}).map(([k, v]): [string, unknown] => [k.replace(/_/g, " "), v]),
      ]);
    }
    case "stripe.create_connected_account":
      return fields([["Company name", b.company_name]]);
    default:
      return null;
  }
}
