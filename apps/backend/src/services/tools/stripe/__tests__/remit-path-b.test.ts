import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import type { HeldFundRow } from "../held-funds";

const transfersCreate = vi.fn();

const fakeStripe = {
  transfers: { create: transfersCreate },
} as const;

let platformGate: "open" | "no_key" | "disabled" = "open";
let connectedAccount: string | null = "acct_tenant1";
let chosenModel: "path_a" | "path_b" | "unset" = "path_b";
let payoutsEnabled = true;

const {
  heldState,
  findHeldFundByRefSpy,
  claimHeldFundForRemitSpy,
  markHeldFundRemittedSpy,
  releaseHeldFundClaimSpy,
} = vi.hoisted(() => {
  const heldState: { row: unknown; claimNull: boolean } = { row: null, claimNull: false };
  return {
    heldState,
    findHeldFundByRefSpy: vi.fn(async () => heldState.row),
    claimHeldFundForRemitSpy: vi.fn(async () => (heldState.claimNull ? null : heldState.row)),
    markHeldFundRemittedSpy: vi.fn(async () => true),
    releaseHeldFundClaimSpy: vi.fn(async () => true),
  };
});

function makeHeld(over: Partial<HeldFundRow> = {}): HeldFundRow {
  return {
    id: over.id ?? "hf_1",
    tenant_id: "11111111-1111-1111-1111-111111111111",
    charge_id: over.charge_id ?? "ch_abc",
    amount_minor: over.amount_minor ?? 9500,
    currency: over.currency ?? "usd",
    client_reference: over.client_reference ?? "remit-1",
    status: over.status ?? "held",
    reserve_held_minor: over.reserve_held_minor ?? 950,
    platform_fee_minor: over.platform_fee_minor ?? 0,
    remitted_transfer_id: over.remitted_transfer_id ?? null,
    created_at: "now",
    updated_at: "now",
    ...over,
  };
}

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

vi.mock("@/services/tools/stripe/held-funds", async (orig) => {
  const actual = (await orig()) as typeof import("../held-funds");
  return {
    ...actual,
    findHeldFundByRef: findHeldFundByRefSpy,
    claimHeldFundForRemit: claimHeldFundForRemitSpy,
    markHeldFundRemitted: markHeldFundRemittedSpy,
    releaseHeldFundClaim: releaseHeldFundClaimSpy,
  };
});

import { remitToTenantTool } from "../remit_to_tenant";

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  log: () => {},
};

beforeEach(() => {
  transfersCreate.mockReset();
  findHeldFundByRefSpy.mockClear();
  claimHeldFundForRemitSpy.mockClear();
  markHeldFundRemittedSpy.mockClear();
  releaseHeldFundClaimSpy.mockClear();
  platformGate = "open";
  connectedAccount = "acct_tenant1";
  chosenModel = "path_b";
  payoutsEnabled = true;
  heldState.row = makeHeld();
  heldState.claimNull = false;
});

describe("remit_to_tenant — Slice 2 payouts gate", () => {
  it("refuses with account_not_payouts_ready when the account is not payouts-enabled (no transfer)", async () => {
    payoutsEnabled = false;
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-np" }),
    ).rejects.toMatchObject({ code: "account_not_payouts_ready" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("proceeds when the account IS payouts-enabled (held row → claim → transfer NET)", async () => {
    payoutsEnabled = true;
    transfersCreate.mockResolvedValue({
      id: "tr_ok",
      amount: 8550,
      currency: "usd",
      destination: "acct_tenant1",
    });
    const out = (await remitToTenantTool.execute(ctx, {
      client_reference: "remit-ok",
    })) as { transfer_id: string };
    expect(out.transfer_id).toBe("tr_ok");
    expect(claimHeldFundForRemitSpy).toHaveBeenCalledWith({ id: "hf_1" });
    expect(markHeldFundRemittedSpy).toHaveBeenCalledWith({ id: "hf_1", transfer_id: "tr_ok" });
    expect(transfersCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses when the tenant has no connected account (before the payouts probe matters)", async () => {
    connectedAccount = null;
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-nc" }),
    ).rejects.toMatchObject({ code: "no_connected_account" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });
});

describe("remit_to_tenant — ledger-bound (BLOCKER 1/2): claim before transfer", () => {
  it("refuses an ad-hoc remit with NO matching held row", async () => {
    heldState.row = null;
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "no-row" }),
    ).rejects.toMatchObject({ code: "held_fund_not_found" });
    expect(claimHeldFundForRemitSpy).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("refuses when the held row is already remitted (no double transfer)", async () => {
    heldState.row = makeHeld({ status: "remitted", remitted_transfer_id: "tr_old" });
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-1" }),
    ).rejects.toMatchObject({ code: "held_fund_already_remitted" });
    expect(claimHeldFundForRemitSpy).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("refuses when the row is not in a remittable state (pending/remitting)", async () => {
    heldState.row = makeHeld({ status: "remitting" });
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-1" }),
    ).rejects.toMatchObject({ code: "held_fund_not_remittable" });
    expect(claimHeldFundForRemitSpy).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("refuses with held_fund_claim_lost when the atomic claim returns null (sweep won the race)", async () => {
    heldState.claimNull = true;
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-1" }),
    ).rejects.toMatchObject({ code: "held_fund_claim_lost" });
    expect(claimHeldFundForRemitSpy).toHaveBeenCalledWith({ id: "hf_1" });
    expect(transfersCreate).not.toHaveBeenCalled();
    expect(markHeldFundRemittedSpy).not.toHaveBeenCalled();
  });

  it("releases the claim (remitting → held) when the transfer definitively fails", async () => {
    transfersCreate.mockRejectedValue(
      Object.assign(new Error("insufficient funds"), { type: "invalid_request_error" }),
    );
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-1" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(claimHeldFundForRemitSpy).toHaveBeenCalledWith({ id: "hf_1" });
    expect(releaseHeldFundClaimSpy).toHaveBeenCalledWith({ id: "hf_1" });
    expect(markHeldFundRemittedSpy).not.toHaveBeenCalled();
  });

  it("does NOT release the claim on an AMBIGUOUS transfer failure (may have committed → no >24h re-transfer)", async () => {
    transfersCreate.mockRejectedValue(
      Object.assign(new Error("connection dropped"), { type: "StripeConnectionError" }),
    );
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-1" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(claimHeldFundForRemitSpy).toHaveBeenCalledWith({ id: "hf_1" });
    expect(releaseHeldFundClaimSpy).not.toHaveBeenCalled();
    expect(markHeldFundRemittedSpy).not.toHaveBeenCalled();
  });
});

describe("remit_to_tenant — Slice 3 reserve + fee withholding (STORED row values)", () => {
  it("transfers the NET = gross minus the STORED reserve and fee (9500 - 950 - 0 = 8550)", async () => {
    heldState.row = makeHeld({ amount_minor: 9500, reserve_held_minor: 950, platform_fee_minor: 0 });
    transfersCreate.mockResolvedValue({
      id: "tr_net",
      amount: 8550,
      currency: "usd",
      destination: "acct_tenant1",
    });
    const out = (await remitToTenantTool.execute(ctx, {
      client_reference: "remit-net",
    })) as {
      amount: number;
      collected_minor: number;
      reserve_held_minor: number;
      platform_fee_minor: number;
    };

    const [params] = transfersCreate.mock.calls[0];
    expect(params.amount).toBe(8550);
    expect(params.source_transaction).toBe("ch_abc");
    expect(params.metadata.collected_minor).toBe("9500");
    expect(params.metadata.reserve_held_minor).toBe("950");
    expect(params.metadata.platform_fee_minor).toBe("0");
    expect(out.collected_minor).toBe(9500);
    expect(out.reserve_held_minor).toBe(950);
    expect(out.platform_fee_minor).toBe(0);
  });

  it("nets out BOTH reserve AND platform fee (10000 - 1000 reserve - 1500 fee = 7500)", async () => {
    heldState.row = makeHeld({
      amount_minor: 10000,
      reserve_held_minor: 1000,
      platform_fee_minor: 1500,
    });
    transfersCreate.mockResolvedValue({
      id: "tr_fee",
      amount: 7500,
      currency: "usd",
      destination: "acct_tenant1",
    });
    await remitToTenantTool.execute(ctx, { client_reference: "remit-fee" });
    const [params] = transfersCreate.mock.calls[0];
    expect(params.amount).toBe(7500);
    expect(params.metadata.platform_fee_minor).toBe("1500");
  });

  it("withholds nothing when the stored reserve + fee are 0 (full amount remitted)", async () => {
    heldState.row = makeHeld({ amount_minor: 9500, reserve_held_minor: 0, platform_fee_minor: 0 });
    transfersCreate.mockResolvedValue({
      id: "tr_full",
      amount: 9500,
      currency: "usd",
      destination: "acct_tenant1",
    });
    const out = (await remitToTenantTool.execute(ctx, {
      client_reference: "remit-full",
    })) as { reserve_held_minor: number };
    const [params] = transfersCreate.mock.calls[0];
    expect(params.amount).toBe(9500);
    expect(out.reserve_held_minor).toBe(0);
  });

  it("refuses with remit_amount_zero when reserve+fee leave nothing (never a zero/negative transfer; no claim taken)", async () => {
    heldState.row = makeHeld({ amount_minor: 9500, reserve_held_minor: 9500, platform_fee_minor: 0 });
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-zero" }),
    ).rejects.toMatchObject({ code: "remit_amount_zero" });
    expect(claimHeldFundForRemitSpy).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
  });
});

describe("remit_to_tenant — source-charge cap (defense-in-depth over-remit guard)", () => {
  it("refuses fail-closed with held_fund_row_corrupt when the stored reserve is NEGATIVE (would inflate netAmount above collected gross)", async () => {
    heldState.row = makeHeld({
      amount_minor: 9500,
      reserve_held_minor: -1000,
      platform_fee_minor: 0,
    });
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-corrupt-reserve" }),
    ).rejects.toMatchObject({ code: "held_fund_row_corrupt" });
    expect(claimHeldFundForRemitSpy).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("refuses fail-closed with held_fund_row_corrupt when the stored platform fee is NEGATIVE", async () => {
    heldState.row = makeHeld({
      amount_minor: 9500,
      reserve_held_minor: 0,
      platform_fee_minor: -500,
    });
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "remit-corrupt-fee" }),
    ).rejects.toMatchObject({ code: "held_fund_row_corrupt" });
    expect(claimHeldFundForRemitSpy).not.toHaveBeenCalled();
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("caps the transfer amount at row.amount_minor (source charge) — the amount passed to transfers.create NEVER exceeds the collected gross", async () => {
    heldState.row = makeHeld({ amount_minor: 9500, reserve_held_minor: 950, platform_fee_minor: 0 });
    transfersCreate.mockResolvedValue({
      id: "tr_cap_ok",
      amount: 8550,
      currency: "usd",
      destination: "acct_tenant1",
    });
    await remitToTenantTool.execute(ctx, { client_reference: "remit-cap-normal" });
    const [params] = transfersCreate.mock.calls[0];
    expect(params.amount).toBe(8550);
    expect(params.amount).toBeLessThanOrEqual(9500);
  });
});

describe("remit_to_tenant — Path A refusal unchanged", () => {
  it("refuses remit under Path A (never holds funds on the platform)", async () => {
    chosenModel = "path_a";
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "x" }),
    ).rejects.toMatchObject({ code: "remit_not_allowed_for_path_a" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("fail-closed when the money model is unset (never guesses)", async () => {
    chosenModel = "unset";
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "x" }),
    ).rejects.toMatchObject({ code: "money_model_not_chosen" });
    expect(transfersCreate).not.toHaveBeenCalled();
  });
});

describe("remit_to_tenant — E3 gate + idempotency + safety ordering", () => {
  it("is inert when the platform rail is gated off (gate resolved FIRST, no transfer)", async () => {
    platformGate = "disabled";
    await expect(
      remitToTenantTool.execute(ctx, { client_reference: "x" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(transfersCreate).not.toHaveBeenCalled();
  });

  it("derives a stable idempotency key from ctx.tenant_id + client_reference (C8)", async () => {
    transfersCreate.mockResolvedValue({
      id: "tr_id",
      amount: 8550,
      currency: "usd",
      destination: "acct_tenant1",
    });
    await remitToTenantTool.execute(ctx, { client_reference: "remit-key" });
    const [, opts] = transfersCreate.mock.calls[0];
    expect(opts.idempotencyKey).toBe("tr-11111111-1111-1111-1111-111111111111-remit-key");
  });
});
