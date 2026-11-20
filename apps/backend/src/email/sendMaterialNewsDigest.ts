
import { sgSend } from "./sendAuthEmail";
import { EMAIL_FONT, EMAIL_PALETTE as C, renderEmail, webOrigin } from "./theme";
import { resolveAgentSendingIdentity } from "./sending-identity";
import { resolveAgentEmailRecipients } from "@/services/notifications/agent-email-recipients";
import { recordDigestSendAudit } from "@/services/workspace/digest-send-audit";

export type MaterialNewsFinding = {
  headline: string;
  why: string;
  url: string;
};

export type MaterialNewsEmailOutcome =
  | { sent: true; count: number }
  | { sent: false; reason: string };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render(findings: MaterialNewsFinding[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject =
    findings.length === 1
      ? "1 thing worth knowing in your market"
      : `${findings.length} things worth knowing in your market`;

  const intro = `A few things happened in your market that could matter to you. We keep this rare on purpose, only when it's worth your time.`;

  const textItems = findings
    .map(
      (f, i) =>
        `${i + 1}. ${f.headline}\n   Why it matters: ${f.why}\n   ${f.url}`,
    )
    .join("\n\n");
  const text = `${intro}\n\n${textItems}\n\nYou're getting this because material-news alerts are on for your workspace. You can turn them off any time in Settings.`;

  const htmlItems = findings
    .map(
      (f) => `
      <div style="margin:0 0 20px 0;padding:0 0 20px 0;border-bottom:1px solid ${C.rule};">
        <a href="${escapeHtml(f.url)}" style="font-family:${EMAIL_FONT};font-size:19px;font-weight:700;line-height:1.3;letter-spacing:-0.02em;color:${C.ink};text-decoration:none;">${escapeHtml(f.headline)}</a>
        <div style="margin-top:8px;color:${C.body};font-size:14px;line-height:1.6;">${escapeHtml(f.why)}</div>
        <a href="${escapeHtml(f.url)}" style="display:inline-block;margin-top:12px;color:${C.accent};font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;">Read more &rarr;</a>
      </div>`,
    )
    .join("");
  const html = renderEmail({
    preheader: subject,
    kicker: "Market news",
    eyebrow: "Worth knowing",
    title:
      findings.length === 1
        ? "One signal worth <em>knowing</em>"
        : `${findings.length} signals worth <em>knowing</em>`,
    intro: escapeHtml(intro),
    body: htmlItems,
    ctaText: "Open Zavi",
    ctaUrl: `${webOrigin()}/workspace`,
    footerNote:
      "You're getting this because material-news alerts are on for your workspace. You can turn them off any time in Settings.",
    footerVariant: "neutral",
  });

  return { subject, html, text };
}

export async function sendMaterialNewsDigestEmail(args: {
  tenant_id: string;
  findings: MaterialNewsFinding[];
  tenantName?: string;
}): Promise<MaterialNewsEmailOutcome> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    return { sent: false, reason: "no_system_key" };
  }
  if (args.findings.length === 0) {
    return { sent: false, reason: "no_findings" };
  }

  const recipients = await resolveAgentEmailRecipients(args.tenant_id);
  if (recipients.length === 0) {
    return { sent: false, reason: "no_recipients" };
  }

  const rendered = render(args.findings);
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
        `[material-news-digest] send failed: ${e instanceof Error ? e.message : "unknown"}`.slice(
          0,
          200,
        ),
      );
    }
  }

  if (sentCount > 0) {
    await recordDigestSendAudit({
      tenant_id: args.tenant_id,
      source_worker: "material-news-digest",
      subject: rendered.subject,
      verdict: "sent",
      violations: sentCount < recipients.length ? ["partial_send_failure"] : [],
    }).catch(() => {
    });
  }

  if (sentCount === 0) {
    return { sent: false, reason: `all_sends_failed:${failCount}` };
  }
  return { sent: true, count: sentCount };
}
