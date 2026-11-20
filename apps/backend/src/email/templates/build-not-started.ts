
import { EMAIL_PALETTE, renderEmail, escapeEmailHtml } from "../theme";

export function renderBuildNotStartedEmail(args: {
  displayName: string;
  workspaceUrl: string;
  reason: string;
}): { html: string; text: string; subject: string } {
  const name = args.displayName;
  const nameHtml = escapeEmailHtml(name);
  const reason = args.reason.trim();

  const subject = `${name}: your workspace is ready, the build isn't`;

  const html = renderEmail({
    preheader: `Your ${name} workspace is set up. The build didn't start. Here's why.`,
    kicker: "Welcome",
    eyebrow: "You're in",
    title: "Your workspace is ready. The build did not start.",
    intro: `Your ${nameHtml} workspace is set up and waiting for you. We did not start a build this time: no repo, database or hosting was created, and no credits were spent.`,
    ctaText: "Open your workspace",
    ctaUrl: args.workspaceUrl,
    body: `
      <p><strong>Why it didn't start:</strong></p>
      <p style="margin:10px 0 0;padding:14px 16px;background-color:${EMAIL_PALETTE.paper};border:1px solid ${EMAIL_PALETTE.rule};border-radius:12px;color:${EMAIL_PALETTE.ink};">${escapeEmailHtml(reason)}</p>
      <p style="margin-top:20px;">Reply to this email and a human will read it. If this looks wrong, tell us and we'll sort it out.</p>
    `,
    footerNote: `You're getting this because you just created ${nameHtml} on Zavi.`,
    footerVariant: "founder-growth",
  });

  const text = [
    `Your ${name} workspace is set up and waiting for you.`,
    "We did not start a build this time: no repo, database or hosting was created, and no credits were spent.",
    "",
    "Why it didn't start:",
    reason,
    "",
    `Your workspace: ${args.workspaceUrl}`,
    "",
    "Reply to this email and a human will read it.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
