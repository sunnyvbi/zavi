
import { renderEmail, escapeEmailHtml, oneLineName } from "../theme";

export type DatabaseRequestAccessArgs = {
  requesterLabel: string;
  requesterEmail: string | null;
  link: string;
};

export function renderDatabaseRequestAccessEmail(args: DatabaseRequestAccessArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const name = oneLineName(args.requesterLabel) || "A teammate";
  const email = oneLineName(args.requesterEmail);
  const who = email && email !== name ? `${name} (${email})` : name;
  const subject = `${name} asked to connect your database to Zavi`;
  const lead = `${who} asked an owner or admin to connect your database in Zavi. Connect it from Connectors > Integrations > Your database:`;
  const h = escapeEmailHtml;
  const html = renderEmail({
    preheader: `${who} asked to connect your database to Zavi.`,
    kicker: "Your database",
    title: "Connect your database",
    intro: h(lead),
    ctaText: "Open Connectors",
    ctaUrl: h(args.link),
    linkFallback: true,
    body: "",
    footerVariant: "neutral",
  });
  const text = [subject, "", lead, args.link, "", "Zavi · zaviagent.com"].join("\n");
  return { subject, html, text };
}
