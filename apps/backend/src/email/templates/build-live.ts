
import { renderEmail, escapeEmailHtml } from "../theme";
import { zaviAdminLink } from "./site-admin-login";

function ownerAdminHtml(adminUrl: string | null, loginUrl: string | null): string {
  if (!adminUrl && !loginUrl) return "";
  const page = adminUrl
    ? `Your admin page is at <a href="${escapeEmailHtml(zaviAdminLink(adminUrl))}">${escapeEmailHtml(zaviAdminLink(adminUrl))}</a>. It shows what your visitors send you, like sign-ups, bookings and messages.`
    : "You are the site's admin.";
  const login = loginUrl
    ? ` <a href="${escapeEmailHtml(loginUrl)}">Log in to your admin</a> with this one-time link (no password; it expires soon).`
    : ` To log in, open your workspace and press "Email me a new login link".`;
  return `
      <p>${page}${login}</p>`;
}

function ownerAdminText(adminUrl: string | null, loginUrl: string | null): string[] {
  if (!adminUrl && !loginUrl) return [];
  const lines = [adminUrl ? `Your admin page: ${zaviAdminLink(adminUrl)}` : "You are the site's admin."];
  lines.push(
    loginUrl
      ? `Log in to your admin with this one-time link (no password; it expires soon): ${loginUrl}`
      : `To log in, open your workspace and press "Email me a new login link".`,
  );
  return [...lines, ""];
}

export function renderBuildLiveEmail(args: {
  siteName: string;
  liveUrl: string;
  workspaceUrl: string;
  admin?: { adminUrl: string; setupUrl: string } | null;
  ownerLoginUrl?: string | null;
  ownerAdminUrl?: string | null;
}): { html: string; text: string; subject: string } {
  const name = args.siteName;
  const nameHtml = escapeEmailHtml(name);
  const urlHtml = escapeEmailHtml(args.liveUrl);

  const subject = `${name} is live`;
  const admin = args.admin ?? null;
  const adminHtml = admin
    ? `
      <p>Your site's admin page is at <a href="${escapeEmailHtml(zaviAdminLink(admin.adminUrl))}">${escapeEmailHtml(zaviAdminLink(admin.adminUrl))}</a>.</p>
      <p><a href="${escapeEmailHtml(admin.setupUrl)}">Log in to your admin</a>. One click, no password. The link works once and expires in 7 days.</p>
    `
    : "";

  const html = renderEmail({
    preheader: `${name} finished building. Open it at ${args.liveUrl}.`,
    kicker: "Build finished",
    eyebrow: "It's up",
    title: "Your site is <em>live</em>",
    intro: `${nameHtml} finished building and is live at <a href="${urlHtml}">${urlHtml}</a>.`,
    ctaText: "Open your site",
    ctaUrl: args.liveUrl,
    body: `${adminHtml}${ownerAdminHtml(args.ownerAdminUrl ?? null, args.ownerLoginUrl ?? null)}
      <p>Want changes? Tell Zavi in your workspace and it will update the site.</p>
      <p style="margin-top:12px;"><a href="${escapeEmailHtml(args.workspaceUrl)}">Open your workspace</a></p>
    `,
    footerNote: `You're getting this because you asked Zavi to build ${nameHtml}.`,
    footerVariant: "founder-growth",
  });

  const adminText = admin
    ? [
        `Your site's admin page: ${zaviAdminLink(admin.adminUrl)}`,
        `Log in to your admin, one click, no password (works once, expires in 7 days): ${admin.setupUrl}`,
        "",
      ]
    : [];
  const text = [
    `${name} finished building and is live at ${args.liveUrl}`,
    "",
    ...adminText,
    ...ownerAdminText(args.ownerAdminUrl ?? null, args.ownerLoginUrl ?? null),
    "Want changes? Tell Zavi in your workspace and it will update the site.",
    `Your workspace: ${args.workspaceUrl}`,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
