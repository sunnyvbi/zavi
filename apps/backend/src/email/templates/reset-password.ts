
import { renderEmail } from "../theme";

export function renderResetPasswordEmail(args: {
  actionUrl: string;
  expiresInMinutes?: number;
}): { html: string; text: string; subject: string } {
  const exp = args.expiresInMinutes ?? 60;

  const subject = "Reset your Zavi password";

  const html = renderEmail({
    preheader: "Click the link to choose a new password. Expires in " + exp + " minutes.",
    kicker: "Account",
    eyebrow: "Password reset",
    title: "Reset your <em>password</em>",
    intro: "We got a request to reset your Zavi password. Click below to choose a new one.",
    ctaText: "Reset password",
    ctaUrl: args.actionUrl,
    linkFallback: true,
    body: `
      <p>Didn't request a reset? You can ignore this email. Your password won't change.</p>
    `,
    footerNote:
      "For your security, the link works once and expires in " +
      exp +
      " minutes. Zavi will never ask you to share it.",
    footerVariant: "neutral",
  });

  const text = [
    "Reset your Zavi password",
    "",
    "Open this link to choose a new password:",
    args.actionUrl,
    "",
    `Expires in ${exp} minutes. If you didn't request a reset, ignore this email.`,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
