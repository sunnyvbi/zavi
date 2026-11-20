
import { renderEmail } from "../theme";

export function renderEmailChangeEmail(args: {
  actionUrl: string;
  side: "new" | "current";
  newEmail: string;
}): { html: string; text: string; subject: string } {
  const toNew = args.side === "new";
  const subject = toNew ? "Confirm your new Zavi email" : "Confirm your Zavi email change";
  const intro = toNew
    ? "Click below to make this the email you sign in with and get Zavi emails at."
    : `Someone asked to change your Zavi sign-in email to ${escapeHtml(args.newEmail)}. Click below if it was you.`;

  const html = renderEmail({
    preheader: toNew ? "Confirm this address to finish changing your Zavi email." : "Confirm the change to your Zavi sign-in email.",
    kicker: "Account",
    eyebrow: "Email change",
    title: toNew ? "Confirm your new <em>email</em>" : "Confirm the <em>change</em>",
    intro,
    ctaText: "Confirm email change",
    ctaUrl: args.actionUrl,
    linkFallback: true,
    body: `
      <p>Didn't ask for this? Ignore this email. Your email stays the same.</p>
    `,
    footerNote: "The link works once. Zavi will never ask you to share it.",
    footerVariant: "neutral",
  });

  const text = [
    subject,
    "",
    toNew ? "Open this link to confirm your new email:" : `Open this link to confirm changing your email to ${args.newEmail}:`,
    args.actionUrl,
    "",
    "Didn't ask for this? Ignore this email. Your email stays the same.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
