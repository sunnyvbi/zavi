
import { alert as defaultAlert } from "@/services/logging/alert";
import { resolveTenantOwnerEmailOrThrow, sgSend } from "@/email/sendAuthEmail";
import { renderPaymentFailedEmail, formatInvoiceAmount } from "@/email/templates/payment-failed";
import { sendOnce as defaultSendOnce } from "@/email/send-once";
import { billingUrl } from "@/services/web-base";

export type PaymentFailedInput = {
  tenantId: string;
  invoiceId: string;
  amountDueCents: number | null;
  currency: string | null;
  attemptCount: number | null;
  billingReason: string | null;
};

export type PaymentFailedDeps = {
  alert: typeof defaultAlert;
  sendOnce: typeof defaultSendOnce;
  ownerEmail: (tenantId: string) => Promise<string | null>;
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
};

const defaultDeps = (): PaymentFailedDeps => ({
  alert: defaultAlert,
  sendOnce: defaultSendOnce,
  ownerEmail: resolveTenantOwnerEmailOrThrow,
  send: (to, subject, html, text) => sgSend(to, subject, html, text),
});

export function paymentFailedEmailKey(invoiceId: string): string {
  return `payment_failed:${invoiceId}`;
}

export function paymentFailedOpsKey(invoiceId: string): string {
  return `payment_failed_ops:${invoiceId}`;
}

export async function notifyPaymentFailed(
  input: PaymentFailedInput,
  over: Partial<PaymentFailedDeps> = {},
): Promise<"sent" | "already_sent" | "uncertain" | "no_owner_email"> {
  const deps = { ...defaultDeps(), ...over };
  const amount = formatInvoiceAmount(input.amountDueCents, input.currency) ?? "unknown amount";
  const owner = await deps.ownerEmail(input.tenantId);

  await deps.sendOnce(paymentFailedOpsKey(input.invoiceId), () => deps.alert({
    source: "stripe-billing-webhook",
    code: "payment_failed",
    tenant_id: input.tenantId,
    msg: `Payment failed: invoice ${input.invoiceId} (${amount}) for tenant ${input.tenantId}.`,
    email: {
      dedupeKey: paymentFailedOpsKey(input.invoiceId),
      subjectDetail: `Payment failed: ${amount}`,
      detail: [
        `Tenant: ${input.tenantId}`,
        `Invoice: ${input.invoiceId}`,
        `Amount: ${amount}`,
        `Attempt: ${input.attemptCount ?? "unknown"} (${input.billingReason ?? "unknown reason"})`,
        owner
          ? "Owner email: sending the \"update your card\" email next (failures show up as billing.payment_failed.notify_failed)."
          : "Owner email: the owner has no email address, so only you were told.",
        "Zavi changed nothing: the subscription events from Stripe decide the plan, as before.",
        "One email per invoice.",
      ].join("\n"),
      required: true,
    },
  }), { releaseOnAnyError: true });

  if (!owner) return "no_owner_email";
  const mail = renderPaymentFailedEmail({
    amountCents: input.amountDueCents,
    currency: input.currency,
    billingUrl: billingUrl(input.tenantId),
  });
  return deps.sendOnce(paymentFailedEmailKey(input.invoiceId), () => deps.send(owner, mail.subject, mail.html, mail.text));
}
