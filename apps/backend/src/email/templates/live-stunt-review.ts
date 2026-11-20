import { renderEmail } from "../theme";

export type LiveStuntReviewEmail = {
  day: string;
  dayNumber: number;
  headline: string;
  link: string;
  ttlHours: number;
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function renderLiveStuntReviewEmail(e: LiveStuntReviewEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Mission log, day ${e.dayNumber}: review and publish`;
  const note = `Nothing is public until you press Publish. The link works once, for ${e.ttlHours} hours.`;
  const text = `Day ${e.dayNumber} (${e.day}) draft:\n\n${e.headline}\n\nReview it: ${e.link}\n\n${note}\n`;
  const html = renderEmail({
    preheader: subject,
    kicker: "Live review",
    eyebrow: `Mission log · Day ${e.dayNumber}`,
    title: "Review before it goes <em>live</em>",
    intro: `<strong>${esc(e.headline)}</strong>`,
    body: `<p>Day ${e.dayNumber} (${esc(e.day)}) is ready for review.</p>`,
    ctaText: "Review and publish",
    ctaUrl: esc(e.link),
    footerNote: esc(note),
    footerVariant: "founder-growth",
  });
  return { subject, html, text };
}
