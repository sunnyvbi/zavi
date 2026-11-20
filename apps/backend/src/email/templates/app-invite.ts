import { escapeEmailHtml, renderEmail } from "../theme";

export function renderAppInviteEmail(args: {
  inviteUrl: string;
  siteHost: string;
  role: "user" | "admin";
  expiresAt: string;
}): { html: string; text: string; subject: string } {
  const host = escapeEmailHtml(args.siteHost);
  const url = escapeEmailHtml(args.inviteUrl);
  const asAdmin = args.role === "admin";
  const expires = new Date(args.expiresAt);
  const expiresText = Number.isNaN(expires.getTime())
    ? "in 7 days"
    : `on ${expires.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  const subject = asAdmin
    ? `You've been invited to help run ${args.siteHost}`
    : `You've been invited to join ${args.siteHost}`;

  const html = renderEmail({
    preheader: `Create your account on ${args.siteHost}.`,
    kicker: "Invite",
    eyebrow: "You're invited",
    title: asAdmin ? `Join <em>${host}</em> as an admin` : `Join <em>${host}</em>`,
    intro: asAdmin
      ? `You've been invited to create an admin account on ${host}. Admins can manage the site's users and data.`
      : `You've been invited to create an account on ${host}.`,
    ctaText: "Accept invite",
    ctaUrl: url,
    linkFallback: true,
    body: `
      <p>This invite expires ${escapeEmailHtml(expiresText)}. Didn't expect it? You can ignore this email.</p>
    `,
    footerNote: "This link is just for you. Don't forward it.",
    footerVariant: "neutral",
  });

  const text = [
    subject,
    "",
    asAdmin
      ? `Open this link to create an admin account on ${args.siteHost}:`
      : `Open this link to create an account on ${args.siteHost}:`,
    args.inviteUrl,
    "",
    `This invite expires ${expiresText}. If you didn't expect it, you can ignore this email.`,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
