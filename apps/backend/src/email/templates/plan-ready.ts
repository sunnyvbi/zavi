
import { renderEmail, escapeEmailHtml, oneLineName } from "../theme";

export const PLAN_READY_SUBJECT = "Your growth plan is ready";

export function renderPlanReadyEmail(args: {
  firstName: string;
  company: string;
  planUrl: string;
  imageBaseUrl: string;
  unsubscribeUrl: string;
}): { html: string; text: string; subject: string } {
  const company = oneLineName(args.company, 80) || "your business";
  const greeting = `Hi ${args.firstName},`;
  const paragraphs = [
    `Your growth plan for ${company} is ready.`,
    "It shows what to aim for, what is holding growth back, and the channels I will work on first.",
    "Have a look and change anything that does not fit. It is your plan.",
  ];
  const button = "Open your growth plan";
  const para = (s: string) => `<p>${escapeEmailHtml(s)}</p>`;

  const html = renderEmail({
    preheader: paragraphs[0],
    title: escapeEmailHtml(PLAN_READY_SUBJECT),
    body: [para(greeting), ...paragraphs.map(para)].join("\n"),
    ctaText: escapeEmailHtml(button),
    ctaUrl: escapeEmailHtml(args.planUrl),
    afterCta: `<p><strong>Zavi</strong><br>AI Growth Agent For Your Business</p>`,
    heroImage: {
      src: `${args.imageBaseUrl.replace(/\/+$/, "")}/email/onboarding/02-growth-strategy.jpg`,
      alt: "Zavi marks the next step on a simple growth plan.",
    },
    ...(args.unsubscribeUrl ? { unsubscribeUrl: args.unsubscribeUrl } : {}),
    footerVariant: "founder-growth",
  });

  const text = [
    greeting,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    `${button}: ${args.planUrl}`,
    "",
    "Zavi",
    "AI Growth Agent For Your Business",
    ...(args.unsubscribeUrl ? ["", `Unsubscribe: ${args.unsubscribeUrl}`] : []),
  ].join("\n");

  return { html, text, subject: PLAN_READY_SUBJECT };
}
