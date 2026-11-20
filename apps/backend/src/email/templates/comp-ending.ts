import { renderEmail, escapeEmailHtml } from "../theme";

export type CompEmailKind = "week" | "day";

export function renderCompEndingEmail(args: {
  kind: CompEmailKind;
  tierName: string;
  endsAt: Date;
  now: Date;
  freeIncludes: readonly string[];
  freeDailyCredits: number;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const h = escapeEmailHtml;
  const plan = `free ${args.tierName} plan`;
  const lastDay = new Date(args.endsAt.getTime() - 1);
  const date = lastDay.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const sameDay = lastDay.toISOString().slice(0, 10) === args.now.toISOString().slice(0, 10);
  const when = args.kind === "day" ? (sameDay ? "today" : "tomorrow") : `on ${date}`;
  const subject = `Your ${plan} ends ${when}`;
  const midnight = args.endsAt.getUTCHours() === 0 && args.endsAt.getUTCMinutes() === 0
    && args.endsAt.getUTCSeconds() === 0 && args.endsAt.getUTCMilliseconds() === 0;
  const time = `${String(args.endsAt.getUTCHours()).padStart(2, "0")}:${String(args.endsAt.getUTCMinutes()).padStart(2, "0")} UTC`;
  const endsLine = midnight ? `runs through ${date} (UTC)` : `ends on ${date} at ${time}`;
  const after = midnight ? `After ${date}` : `After ${date} at ${time}`;
  const lead = `Your ${plan} ${endsLine}. After that your workspace moves to the Free plan. Your work and data stay.`;
  const keepLine = `To keep ${args.tierName}, choose it in Billing.`;
  const keeps = [...args.freeIncludes, `${args.freeDailyCredits.toLocaleString("en-US")} credits every day`];
  const question = "One question: what did you expect Zavi to do? Just reply to this email.";

  const html = renderEmail({
    preheader: `${after} your workspace moves to Free. Here is what you keep.`,
    kicker: "Your plan",
    title: `Your ${plan} ends ${when}`,
    intro: h(lead),
    body: [
      `<p style="margin:0 0 8px 0;"><strong>On Free you keep:</strong></p>`,
      `<ul style="margin:0 0 16px 0;padding-left:20px;">${keeps.map((k) => `<li>${h(k)}</li>`).join("")}</ul>`,
      `<p style="margin:0 0 16px 0;">${h(keepLine)}</p>`,
      `<p style="margin:0;">${h(question)}</p>`,
    ].join(""),
    ctaText: `Keep ${args.tierName}`,
    ctaUrl: h(args.billingUrl),
    linkFallback: true,
    footerVariant: "neutral",
  });
  const text = [
    subject,
    "",
    lead,
    "",
    "On Free you keep:",
    ...keeps.map((k) => `- ${k}`),
    "",
    keepLine,
    `Keep ${args.tierName}: ${args.billingUrl}`,
    "",
    question,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");
  return { subject, html, text };
}
