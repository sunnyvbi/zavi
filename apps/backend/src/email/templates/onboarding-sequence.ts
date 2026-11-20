
import { renderEmail, escapeEmailHtml, oneLineName } from "../theme";
import { destinationUrl, type SequenceStep } from "@/services/onboarding-emails/steps";

export function greetingName(full: string | null | undefined): string {
  const first = oneLineName(full, 60).split(" ")[0] ?? "";
  if (!first || /[@<>]/.test(first) || !/[\p{L}\p{N}]/u.test(first)) return "there";
  return first.length > 40 ? first.slice(0, 40) : first;
}

export const DETAIL_MAX = 160;

export type ResultItem = {
  prefix?: string;
  title: string;
  detail: string;
};

export type InlineLink = { before: string; linkText: string; after: string; url: string };

export type ResultsContent = {
  subject: string;
  headline: string;
  intro: string;
  items: readonly ResultItem[];
  moreLines: readonly string[];
  linkLine?: InlineLink;
  button: string;
  ctaUrl: string;
  afterButton?: string;
};

export function itemLines(item: ResultItem): { title: string; detail: string } {
  const title = oneLineName(item.title, 140);
  return {
    title: item.prefix ? `${oneLineName(item.prefix, 40)}: ${title}` : title,
    detail: oneLineName(item.detail, DETAIL_MAX),
  };
}

export function renderOnboardingSequenceEmail(args: {
  step: SequenceStep;
  firstName: string;
  workspaceUrl: string;
  imageBaseUrl: string;
  unsubscribeUrl: string;
  results?: ResultsContent;
}): { html: string; text: string; subject: string } {
  const { step, firstName, workspaceUrl, imageBaseUrl, unsubscribeUrl, results } = args;
  const ctaUrl = results ? results.ctaUrl : destinationUrl(step.destination, workspaceUrl, step.step);
  const button = results ? results.button : step.button;
  const afterButton = results ? results.afterButton : step.afterButton;
  const greeting = `Hi ${firstName},`;
  const para = (s: string) => `<p>${escapeEmailHtml(s)}</p>`;

  const lines = (results?.items ?? []).map(itemLines);
  const listHtml = results
    ? [
        para(results.intro),
        lines.length
          ? `<ul style="padding-left:20px;margin:0 0 16px 0;">${lines
              .map(
                (l) =>
                  `<li style="margin:0 0 10px 0;"><strong>${escapeEmailHtml(l.title)}</strong>${
                    l.detail ? `<br>${escapeEmailHtml(l.detail)}` : ""
                  }</li>`,
              )
              .join("")}</ul>`
          : "",
        ...results.moreLines.map(para),
        results.linkLine
          ? `<p>${escapeEmailHtml(results.linkLine.before)}<a href="${escapeEmailHtml(results.linkLine.url)}">${escapeEmailHtml(
              results.linkLine.linkText,
            )}</a>${escapeEmailHtml(results.linkLine.after)}</p>`
          : "",
      ]
    : step.paragraphs.map(para);

  const html = renderEmail({
    preheader: results ? undefined : step.preheader || undefined,
    title: escapeEmailHtml(results ? results.headline : step.headline),
    body: [para(greeting), ...listHtml].filter(Boolean).join("\n"),
    ctaText: escapeEmailHtml(button),
    ctaUrl: escapeEmailHtml(ctaUrl),
    afterCta: [afterButton ? para(afterButton) : "", `<p><strong>Zavi</strong><br>AI Growth Agent For Your Business</p>`].join("\n"),
    heroImage: {
      src: `${imageBaseUrl.replace(/\/+$/, "")}/email/onboarding/${step.image}`,
      alt: step.alt,
    },
    unsubscribeUrl,
    footerVariant: "founder-growth",
  });

  const bodyText = results
    ? [
        results.intro,
        "",
        ...lines.flatMap((l) => [`- ${l.title}`, ...(l.detail ? [`  ${l.detail}`] : [])]),
        ...(lines.length ? [""] : []),
        ...results.moreLines.flatMap((m) => [m, ""]),
        ...(results.linkLine
          ? [`${results.linkLine.before}${results.linkLine.linkText}${results.linkLine.after} ${results.linkLine.url}`, ""]
          : []),
      ]
    : step.paragraphs.flatMap((p) => [p, ""]);

  const text = [
    greeting,
    "",
    ...bodyText,
    `${button}: ${ctaUrl}`,
    "",
    ...(afterButton ? [afterButton, ""] : []),
    "Zavi",
    "AI Growth Agent For Your Business",
    "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return { html, text, subject: results ? results.subject : step.subject };
}
