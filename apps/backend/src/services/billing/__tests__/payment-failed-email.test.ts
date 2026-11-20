
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}), logEventConfirmed: vi.fn(async () => true) }));

import { notifyPaymentFailed, paymentFailedEmailKey, paymentFailedOpsKey } from "../payment-failed-email";
import { renderPaymentFailedEmail, formatInvoiceAmount } from "@/email/templates/payment-failed";

const TENANT = "11111111-1111-1111-1111-111111111111";
const input = {
  tenantId: TENANT, invoiceId: "in_1", amountDueCents: 24000, currency: "usd",
  attemptCount: 1, billingReason: "subscription_cycle",
};

function onceLedger() {
  const sent = new Set<string>();
  return vi.fn(async (key: string, send: () => Promise<void>, _opts?: { releaseOnAnyError?: boolean }) => {
    if (sent.has(key)) return "already_sent" as const;
    await send();
    sent.add(key);
    return "sent" as const;
  });
}

beforeEach(() => {
  process.env.WEB_BASE_URL = "https://www.zaviagent.com";
});

describe("notifyPaymentFailed", () => {
  it("pages Ravi with ids + amount only, then emails the owner a Billing link", async () => {
    const alert = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const out = await notifyPaymentFailed(input, {
      alert, send, sendOnce: onceLedger(), ownerEmail: async () => "owner@example.com",
    });
    expect(out).toBe("sent");
    expect(alert).toHaveBeenCalledTimes(1);
    const page = (alert.mock.calls[0] as unknown[])[0] as { msg: string; email: { dedupeKey: string; detail: string; required: boolean } };
    expect(page.email.required).toBe(true);
    expect(page.msg).toContain("in_1");
    expect(page.msg).toContain("$240.00");
    expect(`${page.msg}\n${page.email.detail}`).not.toContain("owner@example.com");
    expect(send).toHaveBeenCalledTimes(1);
    const [to, subject, , text] = send.mock.calls[0] as unknown as string[];
    expect(to).toBe("owner@example.com");
    expect(subject).toBe("Your Zavi payment didn't go through");
    expect(text).toContain(`https://www.zaviagent.com/workspace?tab=settings&company=${TENANT}#billing`);
  });

  it("a second failed retry of the SAME invoice sends nothing more", async () => {
    const alert = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const deps = { alert, send, sendOnce: onceLedger(), ownerEmail: async () => "owner@example.com" };
    await notifyPaymentFailed(input, deps);
    const again = await notifyPaymentFailed({ ...input, attemptCount: 2 }, deps);
    expect(again).toBe("already_sent");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a new invoice is a new email", async () => {
    const send = vi.fn(async () => {});
    const deps = { alert: vi.fn(async () => {}), send, sendOnce: onceLedger(), ownerEmail: async () => "owner@example.com" };
    await notifyPaymentFailed(input, deps);
    await notifyPaymentFailed({ ...input, invoiceId: "in_2" }, deps);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keys Ravi's page and the customer email separately, both on the invoice", () => {
    expect(paymentFailedOpsKey("in_9")).toBe("payment_failed_ops:in_9");
    expect(paymentFailedEmailKey("in_9")).toBe("payment_failed:in_9");
  });

  it("no owner email: Ravi is still paged, nobody else is emailed", async () => {
    const alert = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    const out = await notifyPaymentFailed(input, { alert, send, sendOnce: onceLedger(), ownerEmail: async () => null });
    expect(out).toBe("no_owner_email");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed customer send throws (the webhook 500s and Stripe redelivers) without paging Ravi twice", async () => {
    const alert = vi.fn(async () => {});
    const sendOnce = onceLedger();
    const deps = { alert, sendOnce, ownerEmail: async () => "owner@example.com" };
    await expect(
      notifyPaymentFailed(input, { ...deps, send: vi.fn(async () => { throw new Error("sendgrid down"); }) }),
    ).rejects.toThrow("sendgrid down");
    const send = vi.fn(async () => {});
    expect(await notifyPaymentFailed(input, { ...deps, send })).toBe("sent");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("renderPaymentFailedEmail", () => {
  it("names the amount, asks for a card update, links Billing, and has no dashes", () => {
    const m = renderPaymentFailedEmail({ amountCents: 2000, currency: "usd", billingUrl: "https://x.test/billing" });
    expect(m.text).toContain("$20.00");
    expect(m.text).toContain("update your card");
    expect(m.html).toContain("https://x.test/billing");
    expect(m.text).not.toMatch(/[—–]|--/);
  });

  it("formats non-USD and unknown amounts honestly", () => {
    expect(formatInvoiceAmount(1050, "eur")).toBe("10.50 EUR");
    expect(formatInvoiceAmount(null, "usd")).toBeNull();
    expect(renderPaymentFailedEmail({ amountCents: null, currency: null, billingUrl: "u" }).text).toContain(
      "We couldn't charge your card for your Zavi plan.",
    );
  });

  it("the ops page is released on ANY failure, so a network error is paged on Stripe's next delivery", async () => {
    const sendOnce = onceLedger();
    const alert = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(
      notifyPaymentFailed(input, { alert, sendOnce, send: vi.fn(async () => {}), ownerEmail: async () => "owner@example.com" }),
    ).rejects.toThrow("ECONNREFUSED");
    const opsCall = sendOnce.mock.calls.find((c) => c[0] === paymentFailedOpsKey("in_1"));
    expect(opsCall?.[2]).toEqual({ releaseOnAnyError: true });
  });
});
