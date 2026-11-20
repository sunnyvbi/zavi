
import type { MailKind, MailRequest } from "./types";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const COPY: Record<MailKind, { subject: string; lead: string; cta?: string; foot: string }> = {
  verify_signup: {
    subject: "Confirm your email for {site}",
    lead: "Confirm this email address to finish creating your account on {site}.",
    cta: "Confirm email",
    foot: "If you did not sign up on {site}, ignore this email.",
  },
  magic_link: {
    subject: "Your sign-in link for {site}",
    lead: "Use this link to sign in to {site}. It works once.",
    cta: "Sign in",
    foot: "If you did not ask to sign in, ignore this email.",
  },
  recovery: {
    subject: "Reset your password for {site}",
    lead: "Use this link to choose a new password for your account on {site}. It works once.",
    cta: "Reset password",
    foot: "If you did not ask for this, ignore this email. Your password stays the same.",
  },
  invite: {
    subject: "You have been invited to {site}",
    lead: "You have been invited to {site}. Use this link to accept.",
    cta: "Accept invite",
    foot: "If you were not expecting this, ignore this email.",
  },
  email_otp: {
    subject: "Your sign-in link for {site}",
    lead: "Use this link to continue on {site}. It works once.",
    cta: "Continue",
    foot: "If you did not ask for this, ignore this email.",
  },
  email_change_confirm: {
    subject: "Confirm your new email for {site}",
    lead: "Someone asked to use this address for an account on {site}. Confirm only if it was you.",
    cta: "Confirm new email",
    foot: "If you did not ask for this, ignore this email and nothing will change.",
  },
  email_changed_notice: {
    subject: "Your email for {site} was changed",
    lead: "The email of your account on {site} was changed to {detail}.",
    foot: "If you did not do this, contact the owner of {site} right away.",
  },
  account_exists: {
    subject: "You already have an account on {site}",
    lead: "Someone tried to sign up on {site} with this email, but you already have an account.",
    cta: "Sign in",
    foot: "If that was you, sign in or reset your password. If not, you can ignore this email.",
  },
};

export function renderSiteAuthMail(req: MailRequest): { subject: string; html: string; text: string } {
  const c = COPY[req.kind];
  const name = req.site.name.slice(0, 60);
  const fill = (s: string, html: boolean) =>
    s.replace(/\{site\}/g, html ? esc(name) : name).replace(/\{detail\}/g, html ? esc(req.detail ?? "") : req.detail ?? "");
  const subject = fill(c.subject, false).replace(/[\r\n]/g, " ");
  const button =
    c.cta && req.link
      ? `<p><a href="${esc(req.link)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${esc(c.cta)}</a></p>`
      : "";
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
<p style="font-weight:600">${esc(name)}</p><p>${fill(c.lead, true)}</p>${button}
<p style="color:#666;font-size:13px">${fill(c.foot, true)}</p></div>`;
  const text = [fill(c.lead, false), c.cta && req.link ? `${c.cta}: ${req.link}` : "", fill(c.foot, false)]
    .filter(Boolean)
    .join("\n\n");
  return { subject, html, text };
}
