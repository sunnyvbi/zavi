
import { renderEmail, escapeEmailHtml } from "../theme";

export function renderPreviewReadyEmail(args: {
  displayName: string;
  total: number;
  channelNames: readonly string[];
  planName: string;
  planUsd: number;
  channelsUrl: string;
  realCards?: number;
}): { html: string; text: string; subject: string } {
  const name = args.displayName;
  const nameHtml = escapeEmailHtml(name);
  const n = args.total;
  const things = n === 1 ? "1 action" : `${n} actions`;
  const channels = listNames(args.channelNames);
  const plan = `${args.planName} ($${args.planUsd}/mo)`;

  const subject = `Zavi finished ${things} for ${name}`;
  const real = args.realCards ?? 0;
  const upsell =
    real >= n
      ? `Read and copy them now. Upgrade to ${plan} and Zavi posts and applies them for you, and keeps running these channels.`
      : real > 0
        ? `${real} of them are ready to read and copy now. Upgrade to ${plan} to see the rest, and Zavi posts and applies them for you.`
        : `Upgrade to ${plan} and Zavi runs these channels for real, with every action written out for you to put to work.`;

  const html = renderEmail({
    preheader: `${things} are ready for ${name} across ${channels}.`,
    kicker: "Your channels",
    eyebrow: "Work done",
    title: `${escapeEmailHtml(things)} <em>ready</em>`,
    intro: `Zavi worked through your growth plan for ${nameHtml} and has ${escapeEmailHtml(things)} ready on ${escapeEmailHtml(channels)}.`,
    ctaText: `See my ${things}`,
    ctaUrl: args.channelsUrl,
    body: `
      <p>${escapeEmailHtml(upsell)}</p>
    `,
    footerNote: `You're getting this because you created ${nameHtml} on Zavi.`,
    footerVariant: "founder-growth",
  });

  const text = [
    `Zavi worked through your growth plan for ${name} and has ${things} ready on ${channels}.`,
    "",
    upsell,
    "",
    `See them: ${args.channelsUrl}`,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "your channels";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
