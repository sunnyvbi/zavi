import { renderEmail, escapeEmailHtml } from "../theme";

export function formatInvoiceAmount(cents: number | null, currency: string | null): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return null;
  const amount = (cents / 100).toFixed(2);
  const cur = (currency ?? "usd").toLowerCase();
  return cur === "usd" ? `$${amount}` : `${amount} ${cur.toUpperCase()}`;
}

export function renderPaymentFailedEmail(args: {
  amountCents: number | null;
  currency: string | null;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const h = escapeEmailHtml;
  const amount = formatInvoiceAmount(args.amountCents, args.currency);
  const subject = "Your Zavi payment didn't go through";
  const lead = amount
    ? `We couldn't charge your card for your Zavi plan (${amount}).`
    : "We couldn't charge your card for your Zavi plan.";
  const ask = "Please update your card in Billing so your plan keeps working.";
  const help = "Questions? Just reply to this email.";
  const html = renderEmail({
    preheader: "Update your card so your plan keeps working.",
    kicker: "Billing",
    title: "Your payment didn't go through",
    intro: h(lead),
    body: `<p style="margin:0 0 12px 0;">${h(ask)}</p><p style="margin:0;">${h(help)}</p>`,
    ctaText: "Update your card",
    ctaUrl: h(args.billingUrl),
    linkFallback: true,
    footerVariant: "neutral",
  });
  const text = [subject, "", lead, ask, "", `Update your card: ${args.billingUrl}`, "", help, "", "Zavi · zaviagent.com"].join("\n");
  return { subject, html, text };
}
