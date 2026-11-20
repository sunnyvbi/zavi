import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const paymentIntentsCreate = vi.fn();
const transfersCreate = vi.fn();

const fakeStripe = {
  paymentIntents: { create: paymentIntentsCreate },
  transfers: { create: transfersCreate },
} as const;

let platformGate: "open" | "no_key" | "disabled" = "open";
let connectedAccount: string | null = "acct_tenant1";
let chosenModel: "path_a" | "path_b" | "unset" = "path_a";
let payoutsEnabled = true;

vi.mock("@/services/tools/stripe/_platform-client", async (orig) => {
  const actual = (await orig()) as typeof import("../_platform-client");
  return {
    ...actual,
    platformStripeClient: () => {
      if (platformGate === "no_key") {
        throw new ExpectedToolError("stripe_platform_not_configured", "no key");
      }
      if (platformGate === "disabled") {
        throw new ExpectedToolError("stripe_provisioning_disabled", "rail off");
      }
      return fakeStripe as never;
    },
    resolveConnectedAccountId: async () => connectedAccount,
    resolveConnectedAccountPayoutsEnabled: async () => payoutsEnabled,
  };
});

vi.mock("@/services/tools/stripe/money-model", async (orig) => {
  const actual = (await orig()) as typeof import("../money-model");
  return {
    ...actual,
    resolveMoneyModel: async () => {
      if (chosenModel === "unset") {
        throw new ExpectedToolError("money_model_not_chosen", "choose A/B first");
      }
      return chosenModel;
    },
  };
});

vi.mock("@/services/tools/stripe/payment-caps", async (orig) => {
  const actual = (await orig()) as typeof import("../payment-caps");
  return {
    ...actual,
    assertWithinCaps: async () => {},
    recordUsage: async () => {},
  };
});

const remitHeldState: { row: unknown; claimNull: boolean } = { row: null, claimNull: false };
vi.mock("@/services/tools/stripe/held-funds", async (orig) => {
  const actual = (await orig()) as typeof import("../held-funds");
  return {
    ...actual,
    reserveHeldFund: async (input: { tenant_id: string; client_reference: string; amount_minor: number }) => ({
      id: "hf_1",
      tenant_id: input.tenant_id,
      charge_id: null,
      amount_minor: input.amount_minor,
      currency: "usd",
      client_reference: input.client_reference,
      status: "pending",
      reserve_held_minor: 0,
      platform_fee_minor: 0,
      remitted_transfer_id: null,
      created_at: "now",
      updated_at: "now",
    }),
    markHeldFundCharged: async () => {},
    findHeldFundByRef: async () => remitHeldState.row,
    claimHeldFundForRemit: async () => (remitHeldState.claimNull ? null : remitHeldState.row),
    markHeldFundRemitted: async () => true,
    releaseHeldFundClaim: async () => true,
  };
});

vi.mock("@/services/tools/stripe/reserves", async (orig) => {
  const actual = (await orig()) as typeof import("../reserves");
  return {
    ...actual,
    resolveReservePolicy: async () => ({ bps: 1000, releaseDays: 7 }),
  };
});

import { createPaymentTool, MAX_PAYMENT_AMOUNT_MINOR } from "../create_payment";
import { remitToTenantTool } from "../remit_to_tenant";

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  log: () => {},
};

beforeEach(() => {
  paymentIntentsCreate.mockReset();
  transfersCreate.mockReset();
  platformGate = "open";
  connectedAccount = "acct_tenant1";
  chosenModel = "path_a";
  payoutsEnabled = true;
  remitHeldState.row = {
    id: "hf_1",
    tenant_id: ctx.tenant_id,
    charge_id: "ch_123",
    amount_minor: 9500,
    currency: "usd",
    client_reference: "remit-1",
    status: "held",
    reserve_held_minor: 950,
    platform_fee_minor: 0,
    remitted_transfer_id: null,
    created_at: "now",
    updated_at: "now",
  };
  remitHeldState.claimNull = false;
});

describe("stripe.create_payment — Path A (direct charge)", () => {
  it("creates a PaymentIntent ON the connected account with application_fee_amount + idempotency key", async () => {
    chosenModel = "path_a";
    paymentIntentsCreate.mockResolvedValue({
      id: "pi_A",
      client_secret: "pi_A_secret",
      status: "requires_payment_method",
      amount: 10000,
      currency: "usd",
    });
    const out = (await createPaymentTool.execute(ctx, {
      amount: 10000,
      application_fee_amount: 500,
      client_reference: "order-1",
    })) as { path: string; application_fee_amount: number; payment_intent_id: string };

    expect(out.path).toBe("path_a");
    expect(out.payment_intent_id).toBe("pi_A");
    expect(out.application_fee_amount).toBe(500);

    const [params, opts] = paymentIntentsCreate.mock.calls[0];
    expect(params.application_fee_amount).toBe(500);
    expect(params.transfer_data).toBeUndefined();
    expect(params.on_behalf_of).toBeUndefined();
    expect(params.metadata.praxis_money_model).toBe("path_a");
    expect(opts.stripeAccount).toBe("acct_tenant1");
    expect(opts.idempotencyKey).toBe(
      "pi-11111111-1111-1111-1111-111111111111-path_a-order-1",
    );
  });
});

describe("stripe.create_payment — Path B (destination charge)", () => {
  it("creates a PaymentIntent on the PLATFORM with transfer_data.destination + on_behalf_of", async () => {
    chosenModel = "path_b";
    paymentIntentsCreate.mockResolvedValue({
      id: "pi_B",
      client_secret: "pi_B_secret",
      status: "requires_payment_method",
      amount: 20000,
      currency: "usd",
    });
    const out = (await createPaymentTool.execute(ctx, {
      amount: 20000,
      application_fee_amount: 1000,
      client_reference: "order-2",
    })) as { path: string };

    expect(out.path).toBe("path_b");
    const [params, opts] = paymentIntentsCreate.mock.calls[0];
    expect(params.transfer_data).toEqual({ destination: "acct_tenant1" });
    expect(params.on_behalf_of).toBe("acct_tenant1");
    expect(params.application_fee_amount).toBe(1000);
    expect(opts.stripeAccount).toBeUndefined();
    expect(opts.idempotencyKey).toBe(
      "pi-11111111-1111-1111-1111-111111111111-path_b-order-2",
    );
  });
});

describe("stripe.create_payment — safety", () => {
  it("rejects application_fee >= amount (never an inverted split)", async () => {
    await expect(
      createPaymentTool.execute(ctx, {
        amount: 1000,
        application_fee_amount: 1000,
        client_reference: "x",
      }),
    ).rejects.toMatchObject({ code: "application_fee_too_high" });
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("rejects an amount over the hard per-transaction ceiling", async () => {
    await expect(
      createPaymentTool.execute(ctx, {
        amount: MAX_PAYMENT_AMOUNT_MINOR + 1,
        client_reference: "x",
      }),
    ).rejects.toThrow();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("fail-closed when the money model is unset (never guesses a liability path)", async () => {
    chosenModel = "unset";
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "x" }),
    ).rejects.toMatchObject({ code: "money_model_not_chosen" });
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("refuses when the tenant has no connected account", async () => {
    connectedAccount = null;
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "x" }),
    ).rejects.toMatchObject({ code: "no_connected_account" });
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("is inert when the platform rail is gated off (no charge attempted)", async () => {
    platformGate = "disabled";
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "x" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });
});

describe("stripe.remit_to_tenant — Path B remit (transfers.create)", () => {
  it("claims the held row then creates a Transfer of the NET (gross minus stored reserve+fee) with source_transaction + idempotency", async () => {
    chosenModel = "path_b";
    payoutsEnabled = true;
    transfersCreate.mockResolvedValue({
      id: "tr_1",
      amount: 8550,
      currency: "usd",
      destination: "acct_tenant1",
    });
    const out = (await remitToTenantTool.execute(ctx, {
      client_reference: "remit-1",
    })) as {
      transfer_id: string;
      path: string;
      amount: number;
      collected_minor: number;
      reserve_held_minor: number;
    };

    expect(out.path).toBe("path_b");
    expect(out.transfer_id).toBe("tr_1");
    expect(out.collected_minor).toBe(9500);
    expect(out.reserve_held_minor).toBe(950);
    const [params, opts] = transfersCreate.mock.calls[0];
    expect(params.destination).toBe("acct_tenant1");
    expect(params.source_transaction).toBe("ch_123");
    expect(params.amount).toBe(8550);
    expect(opts.idempotencyKey).toBe(
      "tr-11111111-1111-1111-1111-111111111111-remit-1",
    );
  });

  it("refuses remit under Path A (Path A never holds funds on the platform)", async () => {
    chosenModel = "path_a";
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "x" }),
    ).rejects.toMatchObject({ code: "remit_not_allowed_for_path_a" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("refuses remit when the connected account is not payouts-ready", async () => {
    chosenModel = "path_b";
    payoutsEnabled = false;
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-np" }),
    ).rejects.toMatchObject({ code: "account_not_payouts_ready" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("refuses an ad-hoc remit with no matching held row (ledger-bound)", async () => {
    chosenModel = "path_b";
    remitHeldState.row = null;
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "no-row" }),
    ).rejects.toMatchObject({ code: "held_fund_not_found" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });
});
