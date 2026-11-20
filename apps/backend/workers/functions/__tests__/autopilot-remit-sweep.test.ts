
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { runRemitSweep, type RemitSweepDeps } from "../autopilot-remit-sweep";
import type { HeldFundRow } from "@/services/tools/stripe/held-funds";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ACCT = "acct_ready123";

function heldRow(over: Partial<HeldFundRow> = {}): HeldFundRow {
  return {
    id: over.id ?? "hf_1",
    tenant_id: TENANT,
    charge_id: over.charge_id ?? "ch_abc",
    amount_minor: over.amount_minor ?? 10_000,
    currency: over.currency ?? "usd",
    client_reference: over.client_reference ?? "order-1",
    status: "held",
    reserve_held_minor: over.reserve_held_minor ?? 1_000,
    platform_fee_minor: over.platform_fee_minor ?? 0,
    remitted_transfer_id: null,
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
    ...over,
  };
}

function baseDeps(over: Partial<RemitSweepDeps> = {}): RemitSweepDeps {
  return {
    resolveTenantByAccount: async () => TENANT,
    resolveConnectedAccountPayoutsEnabled: async () => true,
    resolveConnectedAccountId: async () => ACCT,
    listHeldFundsForTenant: async () => [heldRow()],
    claimHeldFundForRemit: async ({ id }) => heldRow({ id }),
    markHeldFundRemitted: async () => true,
    releaseHeldFundClaim: async () => true,
    createTransfer: async (_p, _o) => ({ id: "tr_1", amount: _p.amount }),
    ...over,
  };
}

describe("runRemitSweep", () => {
  it("held → transfers NET (collected minus reserve) → marks remitted", async () => {
    const transfers: Array<{ params: unknown; opts: { idempotencyKey: string } }> = [];
    const marked: Array<{ id: string; transfer_id: string }> = [];
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        createTransfer: async (p, o) => {
          transfers.push({ params: p, opts: o });
          return { id: "tr_99", amount: p.amount };
        },
        markHeldFundRemitted: async (a) => {
          marked.push(a);
          return true;
        },
      }),
    );
    expect(r.outcome).toBe("swept");
    expect(r.tenant_id).toBe(TENANT);
    expect(r.remitted).toBe(1);
    expect((transfers[0].params as { amount: number }).amount).toBe(9000);
    expect((transfers[0].params as { destination: string }).destination).toBe(ACCT);
    expect((transfers[0].params as { source_transaction?: string }).source_transaction).toBe(
      "ch_abc",
    );
    expect(transfers[0].opts.idempotencyKey).toBe(`tr-${TENANT}-order-1`);
    expect(marked).toEqual([{ id: "hf_1", transfer_id: "tr_99" }]);
  });

  it("C8: account with no owning tenant → no_tenant, no transfer", async () => {
    const createTransfer = vi.fn();
    const r = await runRemitSweep(
      ACCT,
      baseDeps({ resolveTenantByAccount: async () => null, createTransfer }),
    );
    expect(r.outcome).toBe("no_tenant");
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("payouts gate: account not payouts-ready → no transfer (held stays held)", async () => {
    const createTransfer = vi.fn();
    const markHeldFundRemitted = vi.fn();
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        resolveConnectedAccountPayoutsEnabled: async () => false,
        createTransfer,
        markHeldFundRemitted,
      }),
    );
    expect(r.outcome).toBe("not_payouts_ready");
    expect(r.tenant_id).toBe(TENANT);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(markHeldFundRemitted).not.toHaveBeenCalled();
  });

  it("no connected account id resolvable → no_connected_account, no transfer", async () => {
    const createTransfer = vi.fn();
    const r = await runRemitSweep(
      ACCT,
      baseDeps({ resolveConnectedAccountId: async () => null, createTransfer }),
    );
    expect(r.outcome).toBe("no_connected_account");
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("zero-net row (stored reserve == gross) is skipped, never claimed/transferred", async () => {
    const createTransfer = vi.fn();
    const markHeldFundRemitted = vi.fn();
    const claimHeldFundForRemit = vi.fn();
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        listHeldFundsForTenant: async () => [
          heldRow({ amount_minor: 10_000, reserve_held_minor: 10_000 }),
        ],
        claimHeldFundForRemit,
        createTransfer,
        markHeldFundRemitted,
      }),
    );
    expect(r.outcome).toBe("swept");
    expect(r.remitted).toBe(0);
    expect(r.rows?.[0].outcome).toBe("skipped_zero_net");
    expect(claimHeldFundForRemit).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
    expect(markHeldFundRemitted).not.toHaveBeenCalled();
  });

  it("nets out BOTH the stored reserve AND the stored platform fee", async () => {
    let capturedAmount = -1;
    await runRemitSweep(
      ACCT,
      baseDeps({
        listHeldFundsForTenant: async () => [
          heldRow({ amount_minor: 10_000, reserve_held_minor: 1_000, platform_fee_minor: 1_500 }),
        ],
        createTransfer: async (p) => {
          capturedAmount = p.amount;
          return { id: "tr_x", amount: p.amount };
        },
      }),
    );
    expect(capturedAmount).toBe(7500);
  });

  it("BLOCKER 1/2: a row whose claim is LOST (null) is skipped, never transferred", async () => {
    const createTransfer = vi.fn();
    const markHeldFundRemitted = vi.fn();
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        claimHeldFundForRemit: async () => null,
        createTransfer,
        markHeldFundRemitted,
      }),
    );
    expect(r.outcome).toBe("swept");
    expect(r.remitted).toBe(0);
    expect(r.rows?.[0].outcome).toBe("skipped_claim_lost");
    expect(createTransfer).not.toHaveBeenCalled();
    expect(markHeldFundRemitted).not.toHaveBeenCalled();
  });

  it("releases the claim (remitting → held) when a transfer DEFINITIVELY fails", async () => {
    const released: string[] = [];
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        createTransfer: async () => {
          throw Object.assign(new Error("invalid"), { type: "StripeInvalidRequestError" });
        },
        releaseHeldFundClaim: async ({ id }) => {
          released.push(id);
          return true;
        },
      }),
    );
    expect(r.remitted).toBe(0);
    expect(r.rows?.[0].outcome).toBe("error");
    expect(released).toEqual(["hf_1"]);
  });

  it("does NOT release the claim on an AMBIGUOUS transfer failure (may have committed)", async () => {
    const released: string[] = [];
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        createTransfer: async () => {
          throw Object.assign(new Error("network"), { type: "StripeConnectionError" });
        },
        releaseHeldFundClaim: async ({ id }) => {
          released.push(id);
          return true;
        },
      }),
    );
    expect(r.remitted).toBe(0);
    expect(r.rows?.[0].outcome).toBe("error_ambiguous");
    expect(released).toEqual([]);
  });

  it("sweeps multiple held rows; one failure does not abort the rest", async () => {
    const marked: string[] = [];
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        listHeldFundsForTenant: async () => [
          heldRow({ id: "hf_a", client_reference: "order-a", amount_minor: 5_000 }),
          heldRow({ id: "hf_b", client_reference: "order-b", amount_minor: 8_000 }),
          heldRow({ id: "hf_c", client_reference: "order-c", amount_minor: 3_000 }),
        ],
        createTransfer: async (p) => {
          if (p.metadata.client_reference === "order-b")
            throw Object.assign(new Error("invalid"), { type: "StripeInvalidRequestError" });
          return { id: `tr_${p.metadata.client_reference}`, amount: p.amount };
        },
        markHeldFundRemitted: async (a) => {
          marked.push(a.id);
          return true;
        },
      }),
    );
    expect(r.outcome).toBe("swept");
    expect(r.remitted).toBe(2);
    expect(marked.sort()).toEqual(["hf_a", "hf_c"]);
    const bRow = r.rows?.find((x) => x.client_reference === "order-b");
    expect(bRow?.outcome).toBe("error");
  });

  it("empty held set → swept with 0 remitted (no-op, still attributes tenant)", async () => {
    const createTransfer = vi.fn();
    const r = await runRemitSweep(
      ACCT,
      baseDeps({ listHeldFundsForTenant: async () => [], createTransfer }),
    );
    expect(r.outcome).toBe("swept");
    expect(r.remitted).toBe(0);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("non-ch_ charge_id is NOT passed as source_transaction (pi_* or null)", async () => {
    let captured: { source_transaction?: string } | null = null;
    await runRemitSweep(
      ACCT,
      baseDeps({
        listHeldFundsForTenant: async () => [heldRow({ charge_id: "pi_xyz" })],
        createTransfer: async (p) => {
          captured = p as { source_transaction?: string };
          return { id: "tr_1", amount: p.amount };
        },
      }),
    );
    expect(captured!.source_transaction).toBeUndefined();
  });

  it("C8 isolation: lists held funds for EXACTLY the re-derived tenant + every transfer goes to THAT tenant's account", async () => {
    const listedFor: string[] = [];
    const destinations: string[] = [];
    const r = await runRemitSweep(
      ACCT,
      baseDeps({
        resolveTenantByAccount: async () => TENANT,
        resolveConnectedAccountId: async (t) => {
          expect(t).toBe(TENANT);
          return ACCT;
        },
        listHeldFundsForTenant: async (t) => {
          listedFor.push(t);
          return [
            heldRow({ id: "hf_a", client_reference: "order-a" }),
            heldRow({ id: "hf_b", client_reference: "order-b" }),
          ];
        },
        createTransfer: async (p) => {
          destinations.push(p.destination);
          return { id: `tr_${p.metadata.client_reference}`, amount: p.amount };
        },
      }),
    );
    expect(r.outcome).toBe("swept");
    expect(r.remitted).toBe(2);
    expect(listedFor).toEqual([TENANT]);
    expect(destinations).toEqual([ACCT, ACCT]);
  });
});
