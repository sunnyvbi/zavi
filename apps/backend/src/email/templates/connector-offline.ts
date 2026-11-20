import { renderEmail, escapeEmailHtml, oneLineName } from "../theme";

export type ConnectorOfflineArgs = {
  feature: string;
  machine: string | null;
  lastSeenAge: string | null;
  link: string;
};

export function renderConnectorOfflineEmail(args: ConnectorOfflineArgs): { subject: string; html: string; text: string } {
  const feature = oneLineName(args.feature) || "A scheduled job";
  const machine = oneLineName(args.machine) || "your server";
  const seen = args.lastSeenAge ? `was last seen ${args.lastSeenAge} ago` : "has not checked in yet";
  const subject = `${feature} skipped: your Zavi Connector is offline`;
  const lead = `It did not run because your connector on ${machine} ${seen}. It runs again at its next scheduled time once the connector is back.`;
  const fix = `To bring it back, run docker restart zavi-connector on ${machine}.`;
  const h = escapeEmailHtml;
  const html = renderEmail({
    preheader: subject,
    kicker: "Your database",
    title: subject,
    intro: `${h(lead)}<br/><br/>${h(fix)}`,
    ctaText: "Open Connectors",
    ctaUrl: h(args.link),
    linkFallback: true,
    body: "",
    footerVariant: "neutral",
  });
  const text = [subject, "", lead, "", fix, "", args.link, "", "Zavi · zaviagent.com"].join("\n");
  return { subject, html, text };
}
