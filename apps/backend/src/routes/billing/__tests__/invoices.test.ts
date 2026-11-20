
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  customerId: null as string | null,
  subError: null as unknown,
  scopedTo: null as string | null,
  stripe: null as unknown,
  list: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: (tid: string) => {
    mocks.scopedTo = tid;
    return {
      from: () => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: mocks.customerId === null ? null : { stripe_customer_id: mocks.customerId },
              error: mocks.subError,
            }),
        };
        return chain;
      },
    };
  },
}));
vi.mock("@/services/billing/client", () => ({ billingStripe: () => mocks.stripe }));

import { billingInvoices } from "../invoices";

function res() {
  const out = { code: 200, body: null as unknown };
  return {
    status(c: number) {
      out.code = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
    out,
  };
}

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "in_1",
  number: "INV-1043",
  created: 1_756_684_800,
  amount_paid: 12_000,
  amount_due: 12_000,
  status: "paid",
  invoice_pdf: "https://stripe.test/in_1.pdf",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "t1", user_id: "u1" });
  mocks.customerId = "cus_abc";
  mocks.subError = null;
  mocks.list = vi.fn().mockResolvedValue({ data: [invoice()] });
  mocks.stripe = { invoices: { list: mocks.list } };
});

describe("GET /api/billing/invoices", () => {
  it("asks Stripe for the authenticated tenant's customer, and shapes the row", async () => {
    const r = res();
    await billingInvoices({} as never, r as never);
    expect(mocks.scopedTo).toBe("t1");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_abc" }));
    expect(r.out.code).toBe(200);
    expect(r.out.body).toEqual({
      invoices: [
        {
          id: "in_1",
          number: "INV-1043",
          created: 1_756_684_800,
          amount_due_usd: 120,
          status: "paid",
          pdf_url: "https://stripe.test/in_1.pdf",
        },
      ],
    });
  });

  it("a tenant that never subscribed gets an empty list, not an error", async () => {
    mocks.customerId = null;
    const r = res();
    await billingInvoices({} as never, r as never);
    expect(r.out.code).toBe(200);
    expect(r.out.body).toEqual({ invoices: [] });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("drops drafts and voids — a draft is not a bill the customer has", async () => {
    mocks.list.mockResolvedValue({
      data: [invoice(), invoice({ id: "in_2", status: "draft" }), invoice({ id: "in_3", status: "void" })],
    });
    const r = res();
    await billingInvoices({} as never, r as never);
    const { invoices } = r.out.body as { invoices: { id: string }[] };
    expect(invoices.map((i) => i.id)).toEqual(["in_1"]);
  });

  it("an OPEN invoice reports what is still due, not what was paid", async () => {
    mocks.list.mockResolvedValue({
      data: [invoice({ status: "open", amount_paid: 0, amount_due: 2_000 })],
    });
    const r = res();
    await billingInvoices({} as never, r as never);
    const { invoices } = r.out.body as { invoices: { amount_due_usd: number }[] };
    expect(invoices[0].amount_due_usd).toBe(20);
  });

  it("is inert while billing is unconfigured", async () => {
    mocks.stripe = null;
    const r = res();
    await billingInvoices({} as never, r as never);
    expect(r.out.code).toBe(503);
  });

  it("a Stripe failure is a 502, never a partial list", async () => {
    mocks.list.mockRejectedValue(new Error("stripe down"));
    const r = res();
    await billingInvoices({} as never, r as never);
    expect(r.out.code).toBe(502);
  });
});
