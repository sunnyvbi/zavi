
import { renderEmail } from "../theme";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const CREATOR_EMAIL_DEFAULT_FOOTER = "You get this email because you use the Zavi creator network.";

export type CreatorNotificationEmailArgs = {
  title: string;
  subject?: string;
  intro: string;
  quote?: string;
  quoteFrom?: string;
  lines?: string[];
  ctaText?: string;
  ctaUrl?: string;
  kicker?: string;
  eyebrow?: string;
  footerNote?: string;
};

export function renderCreatorNotificationEmail(
  args: CreatorNotificationEmailArgs,
): { subject: string; html: string; text: string } {
  const subject = args.subject && args.subject.trim().length > 0 ? args.subject : args.title;
  const intro = (args.intro ?? "").trim();
  const quote = (args.quote ?? "").trim();
  const lines = (args.lines ?? []).filter((l) => l && l.trim().length > 0);
  const footerNote = args.footerNote ?? CREATOR_EMAIL_DEFAULT_FOOTER;

  const quoteFrom = (args.quoteFrom ?? "").trim() || "Message";
  const body = lines
    .map((l) => `<p style="margin:0 0 14px 0;">${escapeHtml(l)}</p>`)
    .join("\n");

  const html = renderEmail({
    preheader: (quote || intro || args.title).slice(0, 140),
    kicker: args.kicker ?? "Zavi",
    eyebrow: args.eyebrow ?? "Creators",
    title: escapeHtml(args.title),
    intro: escapeHtml(intro),
    ctaText: args.ctaText,
    ctaUrl: args.ctaUrl,
    ...(quote
      ? { quote: { from: quoteFrom, text: quote } }
      : {}),
    body: body || (quote ? "" : `<p style="margin:0;">Open Zavi to see the details.</p>`),
    footerNote: escapeHtml(footerNote),
    footerVariant: "neutral",
  });

  const text = [
    args.title,
    ...(intro ? ["", intro] : []),
    ...(quote ? ["", ...quote.split("\n").map((l) => `> ${l}`)] : []),
    ...(lines.length ? ["", ...lines] : []),
    ...(args.ctaUrl ? ["", args.ctaText ? `${args.ctaText}: ${args.ctaUrl}` : args.ctaUrl] : []),
    "",
    footerNote,
    "",
    "Zavi, zaviagent.com",
  ].join("\n");

  return { subject, html, text };
}
