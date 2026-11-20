import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolvePayoutAccountState,
  type ResolvePayoutAccountDeps,
  type MoneyModel,
} from "../payout-account";
import {
  retrieveAccountStatus,
  _resetAccountStatusCache,
  type RetrieveAccountStatusDeps,
} from "../account-status";
import { ExpectedToolError } from "@/services/tools/types";

function deps(over: Partial<ResolvePayoutAccountDeps> = {}): ResolvePayoutAccountDeps {
  return {
    railEnabled: () => true,
    loadMoneyModel: async () => null,
    loadConnectedAccountId: async () => null,
    retrieveStatus: async () => null,
    ...over,
  };
}

describe("resolvePayoutAccountState", () => {
  it("rail_disabled: gate off → never touches Stripe, reports prior money_model", async () => {
    const retrieveStatus = vi.fn();
    const s = await resolvePayoutAccountState(
      "t1",
      deps({
        railEnabled: () => false,
        loadMoneyModel: async () => "path_b" as MoneyModel,
        loadConnectedAccountId: async () => "acct_x",
        retrieveStatus,
      }),
    );
    expect(s.state).toBe("rail_disabled");
    expect(s.rail_enabled).toBe(false);
    expect(s.money_model).toBe("path_b");
    expect(s.account?.id).toBe("acct_x");
    expect(retrieveStatus).not.toHaveBeenCalled();
  });

  it("no_account: rail on, no acct → no_account, money_model still reported", async () => {
    const s = await resolvePayoutAccountState(
      "t1",
      deps({ loadMoneyModel: async () => "path_a", loadConnectedAccountId: async () => null }),
    );
    expect(s.state).toBe("no_account");
    expect(s.account).toBeNull();
    expect(s.money_model).toBe("path_a");
  });

  it("pending: acct exists but charges/payouts not both enabled", async () => {
    const s = await resolvePayoutAccountState(
      "t1",
      deps({
        loadConnectedAccountId: async () => "acct_p",
        retrieveStatus: async () => ({
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
        }),
      }),
    );
    expect(s.state).toBe("pending");
    expect(s.account).toEqual({
      id: "acct_p",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
    });
  });

  it("active: acct with both charges_enabled AND payouts_enabled", async () => {
    const s = await resolvePayoutAccountState(
      "t1",
      deps({
        loadConnectedAccountId: async () => "acct_a",
        retrieveStatus: async () => ({
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        }),
      }),
    );
    expect(s.state).toBe("active");
    expect(s.account?.charges_enabled).toBe(true);
    expect(s.account?.payouts_enabled).toBe(true);
  });

  it("pending fallback: status unknown (null) on a known acct → not active", async () => {
    const s = await resolvePayoutAccountState(
      "t1",
      deps({ loadConnectedAccountId: async () => "acct_u", retrieveStatus: async () => null }),
    );
    expect(s.state).toBe("pending");
    expect(s.account).toEqual({
      id: "acct_u",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
    });
  });

  it("money_model null when unchosen", async () => {
    const s = await resolvePayoutAccountState("t1", deps({ loadMoneyModel: async () => null }));
    expect(s.money_model).toBeNull();
  });
});

describe("retrieveAccountStatus", () => {
  beforeEach(() => _resetAccountStatusCache());

  function statusDeps(over: Partial<RetrieveAccountStatusDeps> = {}): RetrieveAccountStatusDeps {
    return {
      retrieve: async () => ({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      }),
      now: () => 1_000,
      ...over,
    };
  }

  it("maps Stripe flags, defaulting undefined to false", async () => {
    const v = await retrieveAccountStatus(
      "acct_1",
      statusDeps({ retrieve: async () => ({ charges_enabled: true }) }),
    );
    expect(v).toEqual({
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: false,
    });
  });

  it("caches within TTL: second call does not re-hit Stripe", async () => {
    const retrieve = vi.fn(async () => ({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    }));
    const d = statusDeps({ retrieve, now: () => 1_000 });
    await retrieveAccountStatus("acct_c", d);
    await retrieveAccountStatus("acct_c", d);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expiry", async () => {
    const retrieve = vi.fn(async () => ({
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    }));
    let t = 1_000;
    const d = statusDeps({ retrieve, now: () => t });
    await retrieveAccountStatus("acct_e", d);
    t = 1_000 + 60_001;
    await retrieveAccountStatus("acct_e", d);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("rail gated off → returns null (not a throw)", async () => {
    const v = await retrieveAccountStatus(
      "acct_g",
      statusDeps({
        retrieve: async () => {
          throw new ExpectedToolError("stripe_provisioning_disabled", "rail off");
        },
      }),
    );
    expect(v).toBeNull();
  });

  it("non-gate Stripe error propagates", async () => {
    await expect(
      retrieveAccountStatus(
        "acct_x",
        statusDeps({
          retrieve: async () => {
            throw new ExpectedToolError("stripe_rate_limit", "slow down");
          },
        }),
      ),
    ).rejects.toThrow("slow down");
  });
});
