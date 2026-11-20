
import { renderEmail, escapeEmailHtml } from "../theme";

export function renderWelcomeEmail(args: {
  displayName: string;
  workspaceUrl: string;
}): { html: string; text: string; subject: string } {
  const name = args.displayName;
  const nameHtml = escapeEmailHtml(name);

  const planUrl = `${args.workspaceUrl}?tab=growth-strategy`;
  const connectSlackUrl = `${args.workspaceUrl}?tab=settings#connector-slack`;

  const subject = `${name} is on Zavi: start your growth plan`;

  const html = renderEmail({
    preheader: `Open Zavi and it drafts a growth plan for ${name}.`,
    kicker: "Welcome",
    eyebrow: "You're in",
    title: "Your growth plan starts <em>here</em>",
    intro: `Open Zavi and it drafts a growth plan for ${nameHtml}: the channels most likely to bring you customers, and what to do first on each.`,
    ctaText: "Start my growth plan",
    ctaUrl: planUrl,
    body: `
      <p>What happens next:</p>
      <ol style="margin:14px 0 0;padding-left:20px;line-height:1.7;">
        <li><strong>Read the plan.</strong> Tell Zavi what to change.</li>
        <li><strong>Zavi works the channels.</strong> The actions it finds show up in Channels, ready for you to review.</li>
        <li><strong>Talk to Zavi in Slack if you like.</strong> <a href="${connectSlackUrl}">Connect Slack</a>, then DM Zavi or @mention @Zavi in any channel.</li>
      </ol>
      <p style="margin-top:20px;">Reply to this email any time. A human reads it.</p>
    `,
    footerNote:
      "You're getting this because you just finished setting up " +
      nameHtml +
      " on Zavi.",
    footerVariant: "founder-growth",
  });

  const text = [
    `Open Zavi and it drafts a growth plan for ${name}: the channels most likely to bring you customers, and what to do first on each.`,
    "",
    `Start my growth plan: ${planUrl}`,
    "",
    "What happens next:",
    "1. Read the plan. Tell Zavi what to change.",
    "2. Zavi works the channels. The actions it finds show up in Channels, ready for you to review.",
    `3. Talk to Zavi in Slack if you like. Connect Slack: ${connectSlackUrl}`,
    "",
    "Reply any time. A human reads it.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
