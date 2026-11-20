
import { renderEmail, escapeEmailHtml } from "../theme";

export function renderWelcomeBuildEmail(args: {
  displayName: string;
  buildUrl: string;
}): { html: string; text: string; subject: string } {
  const name = args.displayName;
  const nameHtml = escapeEmailHtml(name);

  const subject = `${name} is building on Zavi`;

  const html = renderEmail({
    preheader: `Your app for ${name} is being built right now. Here's what to do while it builds.`,
    kicker: "Welcome",
    eyebrow: "You're in",
    title: "Your app is <em>building</em>",
    intro: `We're building ${nameHtml} right now. Open your build to watch it come together live.`,
    ctaText: "Open your build",
    ctaUrl: args.buildUrl,
    body: `
      <p>While it builds:</p>
      <ol style="margin:14px 0 0;padding-left:20px;line-height:1.7;">
        <li><strong>Watch it come together.</strong> The live preview updates as Zavi builds.</li>
        <li><strong>Refine it in plain language.</strong> Tell Zavi what to change: a different layout, a new feature, a fix.</li>
        <li><strong>Connect Slack if you like.</strong> DM Zavi or @mention @Zavi in any channel and it replies in the thread.</li>
      </ol>
      <p style="margin-top:20px;">Reply to this email any time. A human reads it.</p>
    `,
    footerNote:
      "You're getting this because you just started building " +
      nameHtml +
      " on Zavi.",
    footerVariant: "founder-growth",
  });

  const text = [
    `We're building ${name} on Zavi right now.`,
    "",
    "While it builds:",
    "1. Watch it come together. The live preview updates as Zavi builds.",
    "2. Refine it. Tell Zavi what to change: a different layout, a new feature, a fix.",
    "3. Connect Slack if you like. DM Zavi or @mention @Zavi in any channel.",
    "",
    `Open your build: ${args.buildUrl}`,
    "",
    "Reply any time. A human reads it.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
