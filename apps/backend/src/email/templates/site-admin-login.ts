
import { renderEmail, escapeEmailHtml } from "../theme";

export function zaviAdminLink(adminUrl: string): string {
  try {
    const url = new URL(adminUrl);
    url.searchParams.set("from", "zavi");
    return url.toString();
  } catch {
    return adminUrl;
  }
}

export function renderSiteAdminLoginEmail(args: {
  siteName: string;
  adminUrl: string;
  loginUrl: string;
  workspaceUrl: string;
}): { html: string; text: string; subject: string } {
  const name = args.siteName;
  const nameHtml = escapeEmailHtml(name);
  const adminLink = zaviAdminLink(args.adminUrl);
  const adminHtml = escapeEmailHtml(adminLink);
  const subject = `Your admin login for ${name}`.replace(/[\r\n]/g, " ");

  const html = renderEmail({
    preheader: `Your one-time link to the admin page of ${name}.`,
    kicker: "Your site",
    eyebrow: "Admin login",
    title: `Your admin login for ${nameHtml}`,
    intro: `You own ${nameHtml}. Your admin page is where you see what your visitors send you, like sign-ups, bookings and messages.`,
    ctaText: "Log in to your admin",
    ctaUrl: escapeEmailHtml(args.loginUrl),
    linkFallback: true,
    body: `
      <p>The button logs you in once, without a password. The link expires soon, so use it now.</p>
      <p>Your admin page is always at <a href="${adminHtml}">${adminHtml}</a>. For a new login link later, open your workspace and press "Email me a new login link".</p>
      <p style="margin-top:12px;"><a href="${escapeEmailHtml(args.workspaceUrl)}">Open your workspace</a></p>
    `,
    footerNote: `You're getting this because you own ${nameHtml}, a site built with Zavi.`,
    footerVariant: "founder-growth",
  });

  const text = [
    `You own ${name}. Your admin page is where you see what your visitors send you, like sign-ups, bookings and messages.`,
    "",
    `Log in to your admin (works once, no password, expires soon): ${args.loginUrl}`,
    "",
    `Your admin page is always at ${adminLink}. For a new login link later, open your workspace and press "Email me a new login link".`,
    `Your workspace: ${args.workspaceUrl}`,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
