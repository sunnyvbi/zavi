
import { renderEmail, escapeEmailHtml } from "../theme";

export function renderUpgradeActionsReadyEmail(args: {
  total: number;
  channelsUrl: string;
}): { html: string; text: string; subject: string } {
  const n = Math.max(0, Math.floor(args.total));
  const things = n === 1 ? "1 action" : `${n} actions`;
  const verb = n === 1 ? "is" : "are";
  const subject = n === 0 ? "Zavi finished running your channels" : `Your ${things} ${verb} ready`;
  const line =
    n === 0
      ? "Zavi finished running your channels. Nothing needs you right now."
      : `Zavi finished running your channels. ${things} ${verb} waiting for you.`;

  const html = renderEmail({
    preheader: line,
    kicker: "Your channels",
    eyebrow: "Work done",
    title: escapeEmailHtml(subject),
    intro: escapeEmailHtml(line),
    ctaText: n === 0 ? "Open Channels" : "See your actions",
    ctaUrl: args.channelsUrl,
    body: "",
    footerNote: "You're getting this because you upgraded your Zavi plan.",
    footerVariant: "founder-growth",
  });

  const text = [line, "", `${n === 0 ? "Open Channels" : "See your actions"}: ${args.channelsUrl}`, "", "Zavi · zaviagent.com"].join("\n");
  return { html, text, subject };
}
