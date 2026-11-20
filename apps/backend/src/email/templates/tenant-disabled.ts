import { renderEmail, escapeEmailHtml, oneLineName } from "../theme";
import { workspaceUrl } from "@/services/web-base";

const SUPPORT = "support@zaviagent.com";

export function renderTenantDisabledEmail(args: {
  disabled: boolean;
  workspaceName: string | null;
}): { subject: string; html: string; text: string } {
  const name = oneLineName(args.workspaceName) || "your workspace";
  const h = escapeEmailHtml;
  if (args.disabled) {
    const subject = "Your Zavi workspace has been disabled";
    const lead = `We have disabled the Zavi workspace ${name}. You can no longer sign in to it, and Zavi has stopped all work for it.`;
    const details = [
      { label: "Agents and Autopilot", value: "Stopped. Nothing runs on a schedule." },
      {
        label: "Your ads",
        value: "Still running in your own ad accounts. Zavi no longer changes them, so pause them there if you want them off.",
      },
      { label: "Billing", value: "A paid plan will not renew. You keep it until the end of the current period." },
      { label: "Your data", value: "Kept. The workspace can be turned back on." },
    ];
    const help = `Questions, or think this is a mistake? Write to ${SUPPORT}.`;
    const html = renderEmail({
      preheader: "You can no longer sign in, and Zavi has stopped all work for it.",
      kicker: "Your workspace",
      title: "Your workspace is disabled",
      intro: h(lead),
      details,
      body: `<p style="margin:0;">${h(help)}</p>`,
      footerVariant: "neutral",
    });
    const text = [
      subject,
      "",
      lead,
      "",
      ...details.map((d) => `${d.label}: ${d.value}`),
      "",
      help,
      "",
      "Zavi · zaviagent.com",
    ].join("\n");
    return { subject, html, text };
  }
  const subject = "Your Zavi workspace has been re-enabled";
  const lead = `We have turned the Zavi workspace ${name} back on. You can sign in again.`;
  const details = [
    { label: "Agents and Autopilot", value: "Scheduled work picks up again. Your settings are as you left them." },
    { label: "Billing", value: "If your plan was set to end when we disabled the workspace, it renews as normal again." },
  ];
  const help = `Questions? Write to ${SUPPORT}.`;
  const link = workspaceUrl();
  const html = renderEmail({
    preheader: "You can sign in again.",
    kicker: "Your workspace",
    title: "Your workspace is back on",
    intro: h(lead),
    details,
    body: `<p style="margin:0;">${h(help)}</p>`,
    ctaText: "Open Zavi",
    ctaUrl: h(link),
    footerVariant: "neutral",
  });
  const text = [
    subject,
    "",
    lead,
    "",
    ...details.map((d) => `${d.label}: ${d.value}`),
    "",
    link,
    "",
    help,
    "",
    "Zavi · zaviagent.com",
  ].join("\n");
  return { subject, html, text };
}
