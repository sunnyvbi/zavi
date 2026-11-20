
import { cardCopy } from "./cardCopy";
import { actionLink, deliverableOf, type ActionItem } from "./types";

export const MAILTO_MAX = 1800;

export const DEV_MAIL_OPENED = "Your mail app opened. Add your developer's address and send it.";
export const DEV_MAIL_COPIED = "The email was too long for your mail app, so it is copied. Paste it in, add your developer's address and send it.";
export const DEV_MAIL_BLOCKED = "The email was too long for your mail app and your browser blocked copying. Copy the steps from this card.";

export function cardOwner(a: ActionItem): string | null {
  const o = a.body?.owner ?? a.body?.step?.owner;
  return typeof o === "string" && o ? o : null;
}

export const isDeveloperCard = (a: ActionItem): boolean => cardOwner(a) === "developer";

export function devMail(a: ActionItem, opts: { link?: string | null; content?: string | null } = {}): { subject: string; body: string } {
  const lead = cardCopy(a, false).leadFull.trim();
  const steps = (a.how_to ?? []).map((s, i) => `Step ${i + 1}: ${s}`);
  const content = (opts.content ?? deliverableOf(a)?.content ?? "").trim();
  const label = deliverableOf(a)?.label ?? "What to use";
  const link = opts.link ?? actionLink(a);
  const blocks = [
    a.title,
    lead && lead !== a.title ? lead : "",
    steps.join("\n"),
    content ? `${label}:\n\n${content}` : "",
    link ? `Link: ${link}` : "",
  ].filter(Boolean);
  return { subject: a.title, body: blocks.join("\n\n") };
}

export async function openDevMail(mail: { subject: string; body: string }): Promise<string> {
  const subject = `mailto:?subject=${encodeURIComponent(mail.subject)}`;
  const full = `${subject}&body=${encodeURIComponent(mail.body)}`;
  if (full.length <= MAILTO_MAX) {
    window.location.href = full;
    return DEV_MAIL_OPENED;
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(mail.body);
    copied = true;
  } catch {
  }
  window.location.href = subject;
  return copied ? DEV_MAIL_COPIED : DEV_MAIL_BLOCKED;
}
