import { sgSend } from "./sendAuthEmail";
import { renderEmail, webOrigin, EMAIL_FONT, EMAIL_PALETTE as C } from "./theme";
import { resolveAgentSendingIdentity } from "./sending-identity";
import { resolveAgentEmailRecipients } from "@/services/notifications/agent-email-recipients";
import { recordDigestSendAudit } from "@/services/workspace/digest-send-audit";

export type MentionAlertItem = {
  channelLabel: string;
  title: string;
  excerpt: string;
  url: string;
  context: string;
  sentiment: "positive" | "neutral" | "negative" | null;
};

export type MentionAlertOutcome = { sent: true; count: number } | { sent: false; reason: string };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function subjectFor(items: MentionAlertItem[]): string {
  const channels = [...new Set(items.map((i) => i.channelLabel))];
  const where = channels.length === 1 ? channels[0] : channels.slice(0, -1).join(", ") + " and " + channels[channels.length - 1];
  return items.length === 1
    ? `You were mentioned on ${where}`
    : `${items.length} new mentions on ${where}`;
}

const SENTIMENT_STYLE: Record<string, { fg: string; bg: string }> = {
  positive: { fg: "#0B6B4F", bg: "#E8F4EF" },
  negative: { fg: "#9B1B22", bg: "#FBECED" },
  neutral: { fg: C.muted, bg: "#f0f1f3" },
};

function sentimentPill(sentiment: string): string {
  const t = SENTIMENT_STYLE[sentiment] ?? SENTIMENT_STYLE.neutral;
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background-color:${t.bg};color:${t.fg};font-family:'Plus Jakarta Sans','Poppins',sans-serif;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(sentiment)}</span>`;
}

function metaLine(i: MentionAlertItem): string {
  return [i.channelLabel, ...i.context.split("\u00b7")]
    .map((part) => escapeHtml(part.trim()))
    .filter(Boolean)
    .join("&nbsp;&nbsp;&nbsp;");
}

function titleFor(items: MentionAlertItem[]): string {
  return items.length === 1
    ? "You were <em>mentioned</em>"
    : `${items.length} new <em>mentions</em>`;
}

export function renderMentionAlert(items: MentionAlertItem[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = subjectFor(items);
  const intro =
    items.length === 1
      ? "Someone talked about you. Here is the thread, so you can reply while it is still live."
      : "People talked about you. Here are the threads, so you can reply while they are still live.";

  const line = (i: MentionAlertItem) =>
    [
      `${i.channelLabel} \u00b7 ${i.context}${i.sentiment ? ` \u00b7 ${i.sentiment}` : ""}`,
      i.title,
      i.excerpt ? `"${truncate(i.excerpt, 240)}"` : null,
      i.url,
    ]
      .filter(Boolean)
      .join("\n   ");

  const text = `${intro}\n\n${items.map((i, n) => `${n + 1}. ${line(i)}`).join("\n\n")}\n\nYou're getting this because mention alerts are on for your workspace. You can turn them off any time in Settings.`;

  const htmlItems = items
    .map((i, n) => {
      const rule = n === items.length - 1 ? "" : `border-bottom:1px solid ${C.rule};`;
      return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px 0;">
        <tr>
          <td style="padding:0 0 22px 0;${rule}">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 10px 0;">
              <tr>
                <td style="vertical-align:middle;padding:0 10px 0 0;font-family:'Plus Jakarta Sans','Poppins',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${C.muted};">${metaLine(i)}</td>
                <td style="vertical-align:middle;">${i.sentiment ? sentimentPill(i.sentiment) : ""}</td>
              </tr>
            </table>
            <a href="${escapeHtml(i.url)}" target="_blank" style="display:inline-block;font-family:${EMAIL_FONT};font-size:19px;font-weight:700;line-height:1.3;letter-spacing:-0.02em;color:${C.ink};text-decoration:none;">${escapeHtml(i.title)}</a>
            ${
              i.excerpt
                ? `<div style="margin:9px 0 0 0;padding:0 0 0 13px;border-left:2px solid ${C.rule};font-family:'Plus Jakarta Sans','Poppins',sans-serif;font-size:14px;line-height:1.65;color:${C.body};">${escapeHtml(truncate(i.excerpt, 240))}</div>`
                : ""
            }
            <a href="${escapeHtml(i.url)}" target="_blank" style="display:inline-block;margin:13px 0 0 0;font-family:'Plus Jakarta Sans','Poppins',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${C.accent};text-decoration:none;border-bottom:1px solid ${C.ink};padding-bottom:3px;">Read the thread &rarr;</a>
          </td>
        </tr>
      </table>`;
    })
    .join("");

  const channels = [...new Set(items.map((i) => i.channelLabel))].join("&nbsp;&nbsp;&nbsp;");

  const html = renderEmail({
    preheader: items[0]?.title ?? intro,
    kicker: "Mentions",
    eyebrow: escapeHtml(channels),
    title: titleFor(items),
    intro: escapeHtml(intro),
    body: htmlItems,
    ctaText: "Open Zavi",
    ctaUrl: `${webOrigin()}/workspace`,
    footerNote:
      "You're getting this because mention alerts are on for your workspace. You can turn them off any time in Settings.",
    footerVariant: "neutral",
  });

  return { subject, html, text };
}

export async function sendMentionAlertEmail(args: {
  tenant_id: string;
  items: MentionAlertItem[];
}): Promise<MentionAlertOutcome> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    return { sent: false, reason: "no_system_key" };
  }
  if (args.items.length === 0) {
    return { sent: false, reason: "no_mentions" };
  }

  const recipients = await resolveAgentEmailRecipients(args.tenant_id);
  if (recipients.length === 0) {
    return { sent: false, reason: "no_recipients" };
  }

  const rendered = renderMentionAlert(args.items);
  const identity = await resolveAgentSendingIdentity(args.tenant_id);

  let sentCount = 0;
  let failCount = 0;
  for (const r of recipients) {
    try {
      await sgSend(r.email, rendered.subject, rendered.html, rendered.text, {
        email: identity.from,
        name: identity.name,
      });
      sentCount += 1;
    } catch (e) {
      failCount += 1;
      console.warn(
        `[mention-alert] send failed: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200),
      );
    }
  }

  if (sentCount > 0) {
    await recordDigestSendAudit({
      tenant_id: args.tenant_id,
      source_worker: "mention-alert",
      subject: rendered.subject,
      verdict: "sent",
      violations: sentCount < recipients.length ? ["partial_send_failure"] : [],
    }).catch(() => undefined);
  }

  if (sentCount === 0) {
    return { sent: false, reason: `all_sends_failed:${failCount}` };
  }
  return { sent: true, count: sentCount };
}
