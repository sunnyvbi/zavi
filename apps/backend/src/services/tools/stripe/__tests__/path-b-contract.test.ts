import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

type Row = Record<string, unknown>;

let systemConfigBlob: Record<string, unknown> = {};
let systemConfigError: boolean = false;
let heldFundsUpsertReturn: Row = {};
let dailyUsageRow: Row | null = null;
let dailyUsageError: boolean = false;
let lastHeldUpsert: { values?: Row; opts?: unknown } = {};
let lastDailyUpsert: { values?: Row; opts?: unknown } = {};
let heldListRows: Row[] = [];
let lastHeldUpdate: Row | null = null;
let heldFindRow: Row | null = null;
let lastRpc: { fn?: string; args?: Row } = {};
let rpcReturn: unknown = 1;

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.eq = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.update = vi.fn((vals: Row) => {
    if (table === "autopilot_held_funds") lastHeldUpdate = vals;
    return builder;
  });

  if (table === "system_config") {
    builder.select = vi.fn(chain);
    builder.maybeSingle = vi.fn(async () =>
      systemConfigError
        ? { data: null, error: { message: "boom" } }
        : { data: { blob: systemConfigBlob }, error: null },
    );
  }

  if (table === "autopilot_held_funds") {
    builder.upsert = vi.fn((vals: Row, opts: unknown) => {
      lastHeldUpsert = { values: vals, opts };
      return builder;
    });
    builder.select = vi.fn(chain);
    builder.single = vi.fn(async () => ({ data: heldFundsUpsertReturn, error: null }));
    builder.returns = vi.fn(async () => ({ data: heldListRows, error: null }));
    builder.maybeSingle = vi.fn(async () => ({ data: heldFindRow, error: null }));
  }

  if (table === "autopilot_payment_daily") {
    builder.select = vi.fn(chain);
    builder.maybeSingle = vi.fn(async () =>
      dailyUsageError
        ? { data: null, error: { message: "usage read boom" } }
        : { data: dailyUsageRow, error: null },
    );
    builder.upsert = vi.fn(async (vals: Row, opts: unknown) => {
      lastDailyUpsert = { values: vals, opts };
      return { data: null, error: null };
    });
  }

  return builder;
}

function makeRpc(fn: string, args: Row) {
  lastRpc = { fn, args };
  const result = { data: rpcReturn, error: null };
  const thenable: Record<string, unknown> = {
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return thenable;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (t: string) => makeBuilder(t),
    rpc: (fn: string, args: Row) => makeRpc(fn, args),
  }),
}));

import {
  reserveHeldFund,
  markHeldFundCharged,
  findHeldFundByRef,
  listHeldFundsForTenant,
  claimHeldFundForRemit,
  markHeldFundRemitted,
  releaseHeldFundClaim,
} from "../held-funds";
import {
  resolveReservePolicy,
  computeReserveWithhold,
  DEFAULT_RESERVE_POLICY,
} from "../reserves";
import {
  loadTodayUsage,
  assertWithinCaps,
  recordUsage,
  resolvePaymentCaps,
  DEFAULT_PAYMENT_CAPS,
} from "../payment-caps";
import { resolveConnectedAccountPayoutsEnabled } from "../_platform-client";

beforeEach(() => {
  systemConfigBlob = {};
  systemConfigError = false;
  heldFundsUpsertReturn = {};
  dailyUsageRow = null;
  dailyUsageError = false;
  lastHeldUpsert = {};
  lastDailyUpsert = {};
  heldListRows = [];
  lastHeldUpdate = null;
  heldFindRow = null;
  lastRpc = {};
  rpcReturn = 1;
});

describe("held-funds", () => {
  it("reserveHeldFund upserts a 'pending' row (ignoreDuplicates) keyed on (tenant_id, client_reference) and reads it back", async () => {
    heldFindRow = {
      id: "hf_1",
      tenant_id: "t1",
      client_reference: "ref-1",
      status: "pending",
      amount_minor: 1000,
      reserve_held_minor: 100,
      platform_fee_minor: 50,
    };
    const row = await reserveHeldFund({
      tenant_id: "t1",
      amount_minor: 1000,
      client_reference: "ref-1",
      reserve_held_minor: 100,
      platform_fee_minor: 50,
    });
    expect(row.id).toBe("hf_1");
    expect(row.status).toBe("pending");
    expect(lastHeldUpsert.values).toMatchObject({
      tenant_id: "t1",
      amount_minor: 1000,
      currency: "usd",
      client_reference: "ref-1",
      reserve_held_minor: 100,
      platform_fee_minor: 50,
      status: "pending",
    });
    expect(lastHeldUpsert.opts).toMatchObject({
      onConflict: "tenant_id,client_reference",
      ignoreDuplicates: true,
    });
  });

  it("reserveHeldFund rejects a non-positive amount", async () => {
    await expect(
      reserveHeldFund({ tenant_id: "t1", amount_minor: 0, client_reference: "ref-x" }),
    ).rejects.toThrow(/positive integer/);
  });

  it("reserveHeldFund rejects missing tenant_id (C8)", async () => {
    await expect(
      reserveHeldFund({ tenant_id: "", amount_minor: 100, client_reference: "ref" }),
    ).rejects.toThrow(/tenant_id/);
  });

  it("markHeldFundCharged flips pending → held with the charge id (scoped to status=pending)", async () => {
    await markHeldFundCharged({ id: "hf_1", charge_id: "pi_1" });
    expect(lastHeldUpdate).toMatchObject({
      status: "held",
      charge_id: "pi_1",
    });
  });

  it("findHeldFundByRef returns the matching row", async () => {
    heldFindRow = { id: "hf_9", status: "held" };
    const row = await findHeldFundByRef("t1", "ref-1");
    expect(row?.id).toBe("hf_9");
  });

  it("listHeldFundsForTenant returns rows", async () => {
    heldListRows = [{ id: "hf_1", status: "held" }];
    const rows = await listHeldFundsForTenant("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("hf_1");
  });

  it("claimHeldFundForRemit returns the row via the claim RPC (won)", async () => {
    rpcReturn = { id: "hf_1", status: "remitting" };
    const row = await claimHeldFundForRemit({ id: "hf_1" });
    expect(lastRpc.fn).toBe("autopilot_claim_held_fund_for_remit");
    expect(lastRpc.args).toMatchObject({ p_id: "hf_1" });
    expect(row?.id).toBe("hf_1");
  });

  it("claimHeldFundForRemit returns null when the RPC yields a null-id composite (lost)", async () => {
    rpcReturn = { id: null };
    const row = await claimHeldFundForRemit({ id: "hf_1" });
    expect(row).toBeNull();
  });

  it("markHeldFundRemitted finalizes via the RPC (true on 1 row)", async () => {
    rpcReturn = 1;
    const ok = await markHeldFundRemitted({ id: "hf_1", transfer_id: "tr_1" });
    expect(lastRpc.fn).toBe("autopilot_mark_held_fund_remitted");
    expect(lastRpc.args).toMatchObject({ p_id: "hf_1", p_transfer_id: "tr_1" });
    expect(ok).toBe(true);
  });

  it("markHeldFundRemitted returns false when 0 rows finalized (already finalized)", async () => {
    rpcReturn = 0;
    const ok = await markHeldFundRemitted({ id: "hf_1", transfer_id: "tr_1" });
    expect(ok).toBe(false);
  });

  it("markHeldFundRemitted requires a transfer id", async () => {
    await expect(markHeldFundRemitted({ id: "hf_1", transfer_id: "" })).rejects.toThrow(
      /transfer_id/,
    );
  });

  it("releaseHeldFundClaim reverts via the RPC (true on 1 row)", async () => {
    rpcReturn = 1;
    const ok = await releaseHeldFundClaim({ id: "hf_1" });
    expect(lastRpc.fn).toBe("autopilot_release_held_fund_claim");
    expect(lastRpc.args).toMatchObject({ p_id: "hf_1" });
    expect(ok).toBe(true);
  });
});

describe("reserves", () => {
  it("computeReserveWithhold floors bps math", () => {
    expect(computeReserveWithhold(10_000, 1000)).toBe(1000);
    expect(computeReserveWithhold(999, 1000)).toBe(99);
    expect(computeReserveWithhold(100, 0)).toBe(0);
  });

  it("computeReserveWithhold never exceeds amount or goes negative", () => {
    expect(computeReserveWithhold(100, 99999)).toBe(100);
    expect(computeReserveWithhold(-5, 1000)).toBe(0);
    expect(computeReserveWithhold(0, 1000)).toBe(0);
  });

  it("resolveReservePolicy reads system_config", async () => {
    systemConfigBlob = {
      autopilot_reserve_bps: 2500,
      autopilot_reserve_release_days: 14,
    };
    const p = await resolveReservePolicy();
    expect(p).toEqual({ bps: 2500, releaseDays: 14 });
  });

  it("resolveReservePolicy fail-safes to defaults on a read error", async () => {
    systemConfigError = true;
    const p = await resolveReservePolicy();
    expect(p).toEqual(DEFAULT_RESERVE_POLICY);
  });

  it("resolveReservePolicy clamps out-of-range values", async () => {
    systemConfigBlob = {
      autopilot_reserve_bps: 99_999,
      autopilot_reserve_release_days: -5,
    };
    const p = await resolveReservePolicy();
    expect(p.bps).toBe(10_000);
    expect(p.releaseDays).toBe(0);
  });
});

describe("payment-caps", () => {
  it("resolvePaymentCaps reads system_config", async () => {
    systemConfigBlob = {
      autopilot_daily_cap_minor: 500_000,
      autopilot_daily_count_cap: 25,
    };
    const caps = await resolvePaymentCaps();
    expect(caps).toEqual({ dailyCapMinor: 500_000, dailyCountCap: 25 });
  });

  it("resolvePaymentCaps fail-closes to hard-low defaults on a read error", async () => {
    systemConfigError = true;
    const caps = await resolvePaymentCaps();
    expect(caps).toEqual(DEFAULT_PAYMENT_CAPS);
  });

  it("loadTodayUsage returns {0,0} with no rollup row", async () => {
    dailyUsageRow = null;
    const u = await loadTodayUsage("t1");
    expect(u).toEqual({ collected_minor: 0, count: 0 });
  });

  it("loadTodayUsage returns the rollup row", async () => {
    dailyUsageRow = { collected_minor: 1234, count: 3 };
    const u = await loadTodayUsage("t1");
    expect(u).toEqual({ collected_minor: 1234, count: 3 });
  });

  it("assertWithinCaps passes under the caps", async () => {
    systemConfigBlob = { autopilot_daily_cap_minor: 200_000, autopilot_daily_count_cap: 50 };
    dailyUsageRow = { collected_minor: 1000, count: 1 };
    await expect(assertWithinCaps({ tenant_id: "t1", amount_minor: 1000 })).resolves.toBeUndefined();
  });

  it("assertWithinCaps throws payment_cap_exceeded over the AMOUNT cap", async () => {
    systemConfigBlob = { autopilot_daily_cap_minor: 200_000, autopilot_daily_count_cap: 50 };
    dailyUsageRow = { collected_minor: 199_999, count: 1 };
    try {
      await assertWithinCaps({ tenant_id: "t1", amount_minor: 2 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExpectedToolError);
      expect((e as ExpectedToolError).code).toBe("payment_cap_exceeded");
      expect((e as ExpectedToolError).meta?.reason).toBe("amount");
    }
  });

  it("assertWithinCaps throws payment_cap_exceeded over the COUNT cap", async () => {
    systemConfigBlob = { autopilot_daily_cap_minor: 200_000, autopilot_daily_count_cap: 2 };
    dailyUsageRow = { collected_minor: 10, count: 2 };
    try {
      await assertWithinCaps({ tenant_id: "t1", amount_minor: 1 });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ExpectedToolError).code).toBe("payment_cap_exceeded");
      expect((e as ExpectedToolError).meta?.reason).toBe("count");
    }
  });

  it("assertWithinCaps fail-closes (throws) when usage read fails", async () => {
    dailyUsageError = true;
    await expect(
      assertWithinCaps({ tenant_id: "t1", amount_minor: 1 }),
    ).rejects.toThrow(/usage read boom/);
  });

  it("recordUsage bumps the rollup via the ATOMIC increment RPC", async () => {
    await recordUsage("t1", 250);
    expect(lastRpc.fn).toBe("autopilot_record_payment_usage");
    expect(lastRpc.args).toMatchObject({ p_tenant_id: "t1", p_amount_minor: 250 });
    expect(typeof lastRpc.args?.p_day).toBe("string");
  });
});

describe("resolveConnectedAccountPayoutsEnabled", () => {
  it("false when the tenant has no connected account", async () => {
    const ok = await resolveConnectedAccountPayoutsEnabled("t1", {
      resolveAcctId: async () => null,
      retrieve: async () => ({ payouts_enabled: true }),
    });
    expect(ok).toBe(false);
  });

  it("true when the account has payouts enabled", async () => {
    const ok = await resolveConnectedAccountPayoutsEnabled("t1", {
      resolveAcctId: async () => "acct_1",
      retrieve: async () => ({ payouts_enabled: true }),
    });
    expect(ok).toBe(true);
  });

  it("false when payouts are not enabled", async () => {
    const ok = await resolveConnectedAccountPayoutsEnabled("t1", {
      resolveAcctId: async () => "acct_1",
      retrieve: async () => ({ payouts_enabled: false }),
    });
    expect(ok).toBe(false);
  });

  it("false when the rail is gated off (gate error → not an error)", async () => {
    const ok = await resolveConnectedAccountPayoutsEnabled("t1", {
      resolveAcctId: async () => "acct_1",
      retrieve: async () => {
        throw new ExpectedToolError("stripe_provisioning_disabled", "rail off");
      },
    });
    expect(ok).toBe(false);
  });

  it("propagates a non-gate Stripe error", async () => {
    await expect(
      resolveConnectedAccountPayoutsEnabled("t1", {
        resolveAcctId: async () => "acct_1",
        retrieve: async () => {
          throw new ExpectedToolError("stripe_rate_limit", "slow down");
        },
      }),
    ).rejects.toThrow(/slow down/);
  });
});
