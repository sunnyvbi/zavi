
import { sgSend } from "./sendAuthEmail";
import { renderEmail, webOrigin, escapeEmailHtml } from "./theme";

export type ClosedStatus = "done" | "wont_do";

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function renderFeedbackClosedEmail(args: {
  status: ClosedStatus;
  body: string;
  note: string | null;
}): { subject: string; html: string; text: string } {
  const done = args.status === "done";
  const subject = done ? "Your Zavi request is done" : "Update on your Zavi request";
  const intro = done
    ? "We finished something you asked for."
    : "We looked at something you asked for and are not planning to build it right now.";
  const quoted = truncate(args.body, 300);
  const note = args.note?.trim() || null;

  const text = [
    intro,
    "",
    `You wrote: "${quoted}"`,
    `Status: ${done ? "Done" : "Not planned"}`,
    note ? `Zavi team: ${note}` : null,
    "",
    `See all your requests in Zavi: ${webOrigin()}/workspace`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const html = renderEmail({
    preheader: intro,
    kicker: "Your feedback",
    title: done ? "Your request is <em>done</em>" : "Update on your <em>request</em>",
    intro: escapeEmailHtml(intro),
    body: `
      <p style="margin:0 0 6px 0;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6b6f76;">You wrote</p>
      <p style="margin:0 0 18px 0;padding:0 0 0 13px;border-left:2px solid #e5e5e5;font-size:15px;line-height:1.6;color:#2a2d33;">${escapeEmailHtml(quoted)}</p>
      <p style="margin:0 0 ${note ? "6px" : "0"} 0;font-size:15px;color:#2a2d33;"><strong>Status:</strong> ${done ? "Done" : "Not planned"}</p>
      ${note ? `<p style="margin:0;font-size:15px;line-height:1.6;color:#2a2d33;"><strong>Zavi team:</strong> ${escapeEmailHtml(note)}</p>` : ""}`,
    ctaText: "See your requests",
    ctaUrl: `${webOrigin()}/workspace`,
    footerNote: "You're getting this because you sent feedback from inside Zavi.",
    footerVariant: "neutral",
  });

  return { subject, html, text };
}

export async function sendFeedbackClosedEmail(args: {
  to: string;
  status: ClosedStatus;
  body: string;
  note: string | null;
}): Promise<void> {
  const r = renderFeedbackClosedEmail(args);
  await sgSend(args.to, r.subject, r.html, r.text, undefined, { noTracking: true });
}
