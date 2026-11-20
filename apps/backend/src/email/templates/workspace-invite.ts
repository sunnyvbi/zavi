
import { renderEmail, escapeEmailHtml, oneLineName } from "../theme";

export const INVITER_FALLBACK = "A workspace admin";

export type WorkspaceInviteEmailArgs = {
  actionUrl: string;
  inviterLabel: string;
  inviterEmail?: string | null;
  tenantName: string | null;
};

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function renderWorkspaceInviteEmail(args: WorkspaceInviteEmailArgs): {
  html: string;
  text: string;
  subject: string;
} {
  const url = args.actionUrl;
  const company = oneLineName(args.tenantName);
  const inviter = oneLineName(args.inviterLabel) || INVITER_FALLBACK;
  const email = oneLineName(args.inviterEmail);
  const known = inviter !== INVITER_FALLBACK;
  const inviterFull = known && email && email !== inviter ? `${inviter} (${email})` : inviter;
  const inviterShort = inviter.includes("@") ? inviter : inviter.split(" ")[0];

  const subject = company
    ? `${inviter} invited you to ${company} on Zavi`
    : `${inviter} invited you to a workspace on Zavi`;
  const preheader = company
    ? `${inviterFull} invited you to join ${company} on Zavi.`
    : `${inviterFull} invited you to join a workspace on Zavi.`;
  const lead = company
    ? `${inviterFull} invited you to work on ${possessive(company)} growth with them on Zavi.`
    : `${inviterFull} invited you to join their workspace on Zavi.`;
  const signIn = "You'll sign in first if you're not already.";
  const ignore = known
    ? `Don't know ${inviterShort}? You can ignore this email. Nothing changes until you accept.`
    : "Didn't expect this invite? You can ignore this email. Nothing changes until you accept.";
  const cta = company ? `Join ${company}` : "Join workspace";
  const footerNote = "This link is just for you. Zavi will never ask you to share it.";
  const h = escapeEmailHtml;

  const html = renderEmail({
    preheader,
    kicker: "Workspace",
    eyebrow: "You're invited",
    title: company ? `Join <em>${h(company)}</em> on Zavi` : "Join the <em>workspace</em>",
    intro: `${h(lead)} ${h(signIn)}`,
    ctaText: h(cta),
    ctaUrl: h(url),
    linkFallback: true,
    body: `
      <p>${h(ignore)}</p>
    `,
    footerNote,
    footerVariant: "neutral",
  });

  const text = [
    subject,
    "",
    lead,
    "",
    `Open this link to accept the invite. ${signIn}`,
    url,
    "",
    ignore,
    "",
    footerNote,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}
