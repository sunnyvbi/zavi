
import { renderEmail, escapeEmailHtml } from "../theme";

export type EmailSendOutcomeArgs = {
  outcome: "sent" | "failed" | "unknown";
  subject: string;
  listName: string;
  sent: number | null;
  total: number | null;
  reason: string | null;
  cardUrl: string;
  byAutopilot: boolean;
  kind?: "audience_mismatch";
  acceptedBy?: string;
};

const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;

export function emailSendOutcomeLine(a: Pick<EmailSendOutcomeArgs, "outcome" | "subject" | "listName" | "sent" | "total" | "reason" | "kind" | "acceptedBy">): string {
  const what = `"${a.subject.slice(0, 120)}"`;
  if (a.kind === "audience_mismatch") {
    const why = (a.reason ?? "").trim();
    return `Your email ${what} was not sent to "${a.listName}" by Zavi.${why ? ` ${why}` : ""}`;
  }
  if (a.outcome === "sent" && a.acceptedBy) {
    const list = a.sent !== null ? `a list of ${people(a.sent)}, "${a.listName}"` : `"${a.listName}"`;
    return `${a.acceptedBy} accepted your email ${what} for ${list}. Delivery is not confirmed yet: Zavi reads its numbers after 1 hour.`;
  }
  if (a.outcome === "sent") {
    return a.sent !== null ? `Your email ${what} was sent to ${people(a.sent)} on "${a.listName}".` : `Your email ${what} was sent to "${a.listName}".`;
  }
  if (a.outcome === "unknown") {
    const why = (a.reason ?? "").trim();
    const head = `Your email ${what} to "${a.listName}" may have gone out. The email provider did not confirm it, so Zavi will not send it again and nobody gets it twice.`;
    return why ? `${head} ${why}` : head;
  }
  const sent = a.sent ?? 0;
  const head = sent > 0
    ? `Your email ${what} stopped after ${a.total !== null ? `${sent.toLocaleString("en-US")} of ${people(a.total)}` : people(sent)} on "${a.listName}".`
    : `Your email ${what} to "${a.listName}" was not sent.`;
  const why = (a.reason ?? "").trim();
  return why ? `${head} ${why}` : head;
}

export function renderEmailSendOutcomeEmail(a: EmailSendOutcomeArgs): { subject: string; html: string; text: string } {
  const line = emailSendOutcomeLine(a);
  const mismatch = a.kind === "audience_mismatch";
  const unknown = !mismatch && a.outcome === "unknown";
  const partial = !mismatch && a.outcome === "failed" && (a.sent ?? 0) > 0;
  const subject = a.outcome === "sent" && a.acceptedBy ? `Accepted, not confirmed: ${a.subject}` : a.outcome === "sent" ? `Sent: ${a.subject}` : mismatch ? `Check your email tool: ${a.subject}` : unknown ? `May have gone out: ${a.subject}` : partial ? `Stopped part way: ${a.subject}` : `Not sent: ${a.subject}`;
  const who = a.byAutopilot
    ? a.outcome === "sent"
      ? `Autopilot ${a.acceptedBy ? `handed this email to ${a.acceptedBy}` : "sent this email"} on its own, within the limits of your Auto send setting. You did not approve it.`
      : "Autopilot approved this email on its own, within the limits of your Auto send setting. You did not approve it."
    : "You approved this email in Zavi.";
  const html = renderEmail({
    preheader: line,
    kicker: "Email campaigns",
    title: a.outcome === "sent" && a.acceptedBy ? `${escapeEmailHtml(a.acceptedBy)} <em>accepted</em> your email` : a.outcome === "sent" ? "Your email was <em>sent</em>" : mismatch ? "Your email is going to <em>a different list</em>" : unknown ? "Your email <em>may have gone out</em>" : partial ? "Your email <em>stopped part way</em>" : "Your email was <em>not sent</em>",
    intro: escapeEmailHtml(line),
    ctaText: "Open the email in Zavi",
    ctaUrl: a.cardUrl,
    body: `<p>${escapeEmailHtml(who)}</p>`,
    footerNote: mismatch
      ? "You're getting this because an email you approved is going out to a different list than the one you approved."
      : a.byAutopilot
        ? "You're getting this because Autopilot sent an email for your workspace."
        : "You're getting this because an email you approved finished sending.",
    footerVariant: "founder-growth",
  });
  const text = [line, "", who, "", `Open the email in Zavi: ${a.cardUrl}`, ""].join("\n");
  return { subject, html, text };
}
