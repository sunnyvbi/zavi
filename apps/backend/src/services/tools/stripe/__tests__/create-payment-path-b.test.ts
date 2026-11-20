import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const paymentIntentsCreate = vi.fn();

const fakeStripe = {
  paymentIntents: { create: paymentIntentsCreate },
} as const;

let platformGate: "open" | "no_key" | "disabled" = "open";
let connectedAccount: string | null = "acct_tenant1";
let chosenModel: "path_a" | "path_b" | "unset" = "path_b";
let payoutsEnabled = false;

const {
  assertWithinCapsSpy,
  recordUsageSpy,
  reserveHeldFundSpy,
  markHeldFundChargedSpy,
  reservedState,
  capState,
} = vi.hoisted(() => {
  const capState: { error: ExpectedToolError | null } = { error: null };
  const reservedState: { status: "pending" | "held" | "remitting" | "remitted" } = {
    status: "pending",
  };
  return {
    capState,
    reservedState,
    assertWithinCapsSpy: vi.fn(async () => {
      if (capState.error) throw capState.error;
    }),
    recordUsageSpy: vi.fn(async () => {}),
    reserveHeldFundSpy: vi.fn(
      async (input: {
        tenant_id: string;
        amount_minor: number;
        currency?: string;
        client_reference: string;
        reserve_held_minor?: number;
        platform_fee_minor?: number;
      }) => ({
        id: "hf_1",
        tenant_id: input.tenant_id,
        charge_id: reservedState.status === "pending" ? null : "pi_PRIOR",
        amount_minor: input.amount_minor,
        currency: input.currency ?? "usd",
        client_reference: input.client_reference,
        status: reservedState.status,
        reserve_held_minor: input.reserve_held_minor ?? 0,
        platform_fee_minor: input.platform_fee_minor ?? 0,
        remitted_transfer_id: null,
        created_at: "now",
        updated_at: "now",
      }),
    ),
    markHeldFundChargedSpy: vi.fn(async () => {}),
  };
});

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
    assertWithinCaps: assertWithinCapsSpy,
    recordUsage: recordUsageSpy,
  };
});

vi.mock("@/services/tools/stripe/held-funds", async (orig) => {
  const actual = (await orig()) as typeof import("../held-funds");
  return {
    ...actual,
    reserveHeldFund: reserveHeldFundSpy,
    markHeldFundCharged: markHeldFundChargedSpy,
  };
});

vi.mock("@/services/tools/stripe/reserves", async (orig) => {
  const actual = (await orig()) as typeof import("../reserves");
  return {
    ...actual,
    resolveReservePolicy: async () => ({ bps: 1000, releaseDays: 7 }),
  };
});

import { createPaymentTool } from "../create_payment";

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  log: () => {},
};

beforeEach(() => {
  paymentIntentsCreate.mockReset();
  assertWithinCapsSpy.mockClear();
  recordUsageSpy.mockClear();
  reserveHeldFundSpy.mockClear();
  markHeldFundChargedSpy.mockClear();
  platformGate = "open";
  connectedAccount = "acct_tenant1";
  chosenModel = "path_b";
  payoutsEnabled = false;
  capState.error = null;
  reservedState.status = "pending";
});

describe("create_payment — Slice 1 Path B HOLD mode (collect before onboard)", () => {
  it("collects GROSS onto the PLATFORM with NO transfer_data / on_behalf_of / application_fee, reserves then charges the held row", async () => {
    payoutsEnabled = false;
    paymentIntentsCreate.mockResolvedValue({
      id: "pi_HELD",
      client_secret: "pi_HELD_secret",
      status: "requires_payment_method",
      amount: 30000,
      currency: "usd",
    });

    const out = (await createPaymentTool.execute(ctx, {
      amount: 30000,
      application_fee_amount: 1500,
      client_reference: "order-hold-1",
    })) as {
      path: string;
      mode: string;
      connected_account: string | null;
      payment_intent_id: string;
      reserve_held_minor: number;
    };

    expect(out.path).toBe("path_b");
    expect(out.mode).toBe("held");
    expect(out.connected_account).toBeNull();
    expect(out.payment_intent_id).toBe("pi_HELD");
    expect(out.reserve_held_minor).toBe(3000);

    const [params, opts] = paymentIntentsCreate.mock.calls[0];
    expect(params.transfer_data).toBeUndefined();
    expect(params.on_behalf_of).toBeUndefined();
    expect(params.application_fee_amount).toBeUndefined();
    expect(opts.stripeAccount).toBeUndefined();
    expect(opts.idempotencyKey).toBe(
      "pi-11111111-1111-1111-1111-111111111111-path_b-order-hold-1",
    );

    expect(reserveHeldFundSpy).toHaveBeenCalledTimes(1);
    const reservedArg = reserveHeldFundSpy.mock.calls[0][0];
    expect(reservedArg).toMatchObject({
      tenant_id: ctx.tenant_id,
      amount_minor: 30000,
      currency: "usd",
      client_reference: "order-hold-1",
      reserve_held_minor: 3000,
      platform_fee_minor: 1500,
    });

    expect(markHeldFundChargedSpy).toHaveBeenCalledWith({ id: "hf_1", charge_id: "pi_HELD" });

    expect(recordUsageSpy).toHaveBeenCalledWith(ctx.tenant_id, 30000);
  });

  it("idempotent retry: an already-charged held row does NOT mint a second PaymentIntent", async () => {
    payoutsEnabled = false;
    reservedState.status = "held";
    const out = (await createPaymentTool.execute(ctx, {
      amount: 30000,
      application_fee_amount: 1500,
      client_reference: "order-hold-1",
    })) as { mode: string; status: string; payment_intent_id: string | null };

    expect(out.mode).toBe("held");
    expect(out.status).toBe("already_collected");
    expect(out.payment_intent_id).toBe("pi_PRIOR");
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(markHeldFundChargedSpy).not.toHaveBeenCalled();
  });

  it("does NOT flip the held row to charged when the platform charge fails", async () => {
    payoutsEnabled = false;
    paymentIntentsCreate.mockRejectedValue(
      Object.assign(new Error("card_declined"), { type: "card_error" }),
    );
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "order-x" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(markHeldFundChargedSpy).not.toHaveBeenCalled();
    expect(recordUsageSpy).not.toHaveBeenCalled();
  });
});

describe("create_payment — Slice 1 Path B payouts-enabled (destination charge unchanged)", () => {
  it("keeps the destination charge path when the account is payouts-enabled", async () => {
    payoutsEnabled = true;
    paymentIntentsCreate.mockResolvedValue({
      id: "pi_DEST",
      client_secret: "pi_DEST_secret",
      status: "requires_payment_method",
      amount: 20000,
      currency: "usd",
    });

    const out = (await createPaymentTool.execute(ctx, {
      amount: 20000,
      application_fee_amount: 1000,
      client_reference: "order-dest-1",
    })) as { path: string; mode: string; connected_account: string | null };

    expect(out.path).toBe("path_b");
    expect(out.mode).toBe("direct");
    expect(out.connected_account).toBe("acct_tenant1");

    const [params, opts] = paymentIntentsCreate.mock.calls[0];
    expect(params.transfer_data).toEqual({ destination: "acct_tenant1" });
    expect(params.on_behalf_of).toBe("acct_tenant1");
    expect(params.application_fee_amount).toBe(1000);
    expect(opts.stripeAccount).toBeUndefined();

    expect(reserveHeldFundSpy).not.toHaveBeenCalled();
    expect(markHeldFundChargedSpy).not.toHaveBeenCalled();
    expect(recordUsageSpy).toHaveBeenCalledWith(ctx.tenant_id, 20000);
  });
});

describe("create_payment — Slice 1 Path A unchanged (never holds)", () => {
  it("creates the direct charge on the connected account; never checks payouts / never holds", async () => {
    chosenModel = "path_a";
    payoutsEnabled = false;
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
      client_reference: "order-a-1",
    })) as { path: string; mode: string };

    expect(out.path).toBe("path_a");
    expect(out.mode).toBe("direct");
    const [params, opts] = paymentIntentsCreate.mock.calls[0];
    expect(params.transfer_data).toBeUndefined();
    expect(params.on_behalf_of).toBeUndefined();
    expect(opts.stripeAccount).toBe("acct_tenant1");
    expect(reserveHeldFundSpy).not.toHaveBeenCalled();
    expect(markHeldFundChargedSpy).not.toHaveBeenCalled();
    expect(recordUsageSpy).toHaveBeenCalledWith(ctx.tenant_id, 10000);
  });
});

describe("create_payment — Slice 4 caps", () => {
  it("checks caps BEFORE creating any charge and refuses when over (path_b)", async () => {
    chosenModel = "path_b";
    capState.error = new ExpectedToolError("payment_cap_exceeded", "over the daily cap", {
      reason: "amount",
    });
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "order-cap" }),
    ).rejects.toMatchObject({ code: "payment_cap_exceeded" });
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(reserveHeldFundSpy).not.toHaveBeenCalled();
    expect(recordUsageSpy).not.toHaveBeenCalled();
  });

  it("checks caps BEFORE creating any charge and refuses when over (path_a)", async () => {
    chosenModel = "path_a";
    capState.error = new ExpectedToolError("payment_cap_exceeded", "over the count cap", {
      reason: "count",
    });
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "order-cap-a" }),
    ).rejects.toMatchObject({ code: "payment_cap_exceeded" });
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(recordUsageSpy).not.toHaveBeenCalled();
  });

  it("passes the re-derived ctx.tenant_id + amount to the cap gate (C8)", async () => {
    chosenModel = "path_a";
    paymentIntentsCreate.mockResolvedValue({
      id: "pi_A",
      client_secret: "s",
      status: "requires_payment_method",
      amount: 4200,
      currency: "usd",
    });
    await createPaymentTool.execute(ctx, { amount: 4200, client_reference: "order-c8" });
    expect(assertWithinCapsSpy).toHaveBeenCalledWith({
      tenant_id: ctx.tenant_id,
      amount_minor: 4200,
    });
  });

  it("runs the cap gate AFTER the E3 platform gate (inert rail never reaches caps)", async () => {
    platformGate = "disabled";
    await expect(
      createPaymentTool.execute(ctx, { amount: 1000, client_reference: "order-gate" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(assertWithinCapsSpy).not.toHaveBeenCalled();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });
});
