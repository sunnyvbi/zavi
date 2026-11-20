
import { FREE_DAILY_CREDITS_SQL_FALLBACK } from "../credits";
import { describe, it, expect, vi } from "vitest";
import {
  assertBuildCreditsAvailable,
  estimateBuildReserveCredits,
  requiredBuildCredits,
  makeBalanceReader,
  InsufficientCreditsForBuild,
} from "@/services/agents/build-credit-preflight";
import { reserveEstimateFor } from "@/services/agents/credits";

const TENANT = "11111111-2222-3333-4444-555555555555";

function wallet(over: Partial<{ remaining: number; enforced: boolean; unlimited: boolean; free_plan: boolean }> = {}) {
  return {
    readBalance: vi.fn().mockResolvedValue({
      remaining: 100_000,
      enforced: true,
      unlimited: false,
      ...over,
    }),
  };
}

describe("estimateBuildReserveCredits", () => {
  it("sums the dispatching stages: spec + scaffold + build (qa is no longer dispatched)", () => {
    const expected =
      reserveEstimateFor("pm") +
      reserveEstimateFor("engineer") * 2;
    expect(estimateBuildReserveCredits({ includeRepoAnalysis: false })).toBe(expected);
  });

  it("the summed stage reserves are exactly 4,160 (the FLOOR is applied separately)", () => {
    expect(estimateBuildReserveCredits({ includeRepoAnalysis: false })).toBe(4160);
  });

  it("excludes the qa reserve even though STAGE_AGENT still maps qa", () => {
    expect(estimateBuildReserveCredits({ includeRepoAnalysis: false })).toBe(
      reserveEstimateFor("pm") + reserveEstimateFor("engineer") * 2,
    );
    expect(requiredBuildCredits({ includeRepoAnalysis: false })).toBe(6500);
  });

  it("EXCLUDES gate stages — provision/preview/deploy never dispatch", () => {
    const withGates = estimateBuildReserveCredits({ includeRepoAnalysis: false });
    expect(withGates).toBeLessThan(4160 + 160);
  });

  it("adds repo_analysis ONLY when that stage is enabled", () => {
    const off = estimateBuildReserveCredits({ includeRepoAnalysis: false });
    const on = estimateBuildReserveCredits({ includeRepoAnalysis: true });
    expect(on - off).toBe(reserveEstimateFor("engineer"));
    expect(on).toBeGreaterThan(off);
  });
});

describe("assertBuildCreditsAvailable — refuses before anything is provisioned", () => {
  it("throws when the wallet cannot cover the build", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: 100 })),
    ).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
  });

  it("the error carries both numbers so the operator knows the gap", async () => {
    let err!: InsufficientCreditsForBuild;
    try {
      await assertBuildCreditsAvailable(TENANT, wallet({ remaining: 100 }));
      throw new Error("expected InsufficientCreditsForBuild");
    } catch (e) {
      err = e as InsufficientCreditsForBuild;
    }
    expect(err.required_credits).toBe(requiredBuildCredits());
    expect(err.remaining_credits).toBe(100);
    expect(err.message).toContain("Nothing was created");
  });

  it("passes when the wallet covers it", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: requiredBuildCredits() })),
    ).resolves.toBeUndefined();
  });

  it("boundary: exactly enough passes, one short refuses", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: requiredBuildCredits() })),
    ).resolves.toBeUndefined();
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: requiredBuildCredits() - 1 })),
    ).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
  });

  it("a free tenant on the daily grant alone is still refused", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: FREE_DAILY_CREDITS_SQL_FALLBACK })),
    ).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
  });

  it("marks the refusal free_plan only when the wallet read says free", async () => {
    const refusal = (free_plan: boolean) =>
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: 1_000, free_plan })).then(
        () => {
          throw new Error("expected InsufficientCreditsForBuild");
        },
        (e: unknown) => e as InsufficientCreditsForBuild,
      );
    const free = await refusal(true);
    const paid = await refusal(false);
    expect(free.free_plan).toBe(true);
    expect(paid.free_plan).toBe(false);
  });
});

describe("assertBuildCreditsAvailable — mirrors enforcement, never invents a refusal", () => {
  it("a tenant credits are NOT enforced for is never refused, even at zero", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: 0, enforced: false })),
    ).resolves.toBeUndefined();
  });

  it("credits_unlimited is never refused, even at zero", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, wallet({ remaining: 0, unlimited: true })),
    ).resolves.toBeUndefined();
  });

  it("an unreadable balance SKIPS the check — a blip must not block a build", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, { readBalance: vi.fn().mockResolvedValue(null) }),
    ).resolves.toBeUndefined();
  });

  it("a throwing balance read SKIPS the check rather than failing the build", async () => {
    await expect(
      assertBuildCreditsAvailable(TENANT, {
        readBalance: vi.fn().mockRejectedValue(new Error("db down")),
      }),
    ).resolves.toBeUndefined();
  });

  it("reads the balance for the tenant it was asked about", async () => {
    const d = wallet();
    await assertBuildCreditsAvailable(TENANT, d);
    expect(d.readBalance).toHaveBeenCalledWith(TENANT);
  });
});

describe("makeBalanceReader — the client is injected, never imported", () => {
  function fakeClient(rows: Record<string, unknown>) {
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              const v = rows[table];
              if (v instanceof Error) return { data: null, error: v };
              return { data: v ?? null, error: null };
            },
          }),
        }),
      }),
    };
  }
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = "2000-01-01T00:00:00.000Z";

  it("computes remaining = allowance - used + purchased - reserved", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 40_000,
          included_used: 5_000,
          purchased_balance: 1_000,
          reserved: 2_000,
          period_end: future,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    const s = await read(TENANT);
    expect(s).toEqual({ remaining: 34_000, enforced: true, unlimited: false, free_plan: false });
  });

  it("does not label a tenant free when the subscription row is unreadable", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 48_000,
          included_used: 42_000,
          purchased_balance: 0,
          reserved: 0,
          period_end: future,
        },
        tenant_subscriptions: new Error("subscription read failed"),
      }) as never,
    );
    const s = await read(TENANT);
    expect(s?.free_plan).toBe(false);
    await expect(assertBuildCreditsAvailable(TENANT, { readBalance: async () => s })).rejects.toMatchObject({
      free_plan: false,
    });
  });

  it("an unreadable subscription row never blocks an unlimited tenant's build", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: true },
        tenant_credit_balances: {
          included_allowance: 1_000,
          included_used: 1_000,
          purchased_balance: 0,
          reserved: 0,
          period_end: future,
        },
        tenant_subscriptions: new Error("subscription read failed"),
      }) as never,
    );
    await expect(assertBuildCreditsAvailable(TENANT, { readBalance: read })).resolves.toBeUndefined();
  });

  it("a STALE-month row resets used/reserved instead of reading as 0 left", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 40_000,
          included_used: 40_000,
          purchased_balance: 0,
          reserved: 0,
          period_end: past,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    const s = await read(TENANT);
    expect(s!.remaining).toBe(FREE_DAILY_CREDITS_SQL_FALLBACK);
    expect(s!.remaining).not.toBe(40_000);
  });

  it("YESTERDAY's daily row is STALE — this is the 2026-09-18 incident", async () => {
    const yesterdayEnd = new Date().toISOString().slice(0, 10);
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true, free_daily_credits: 1_000 } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 5_000,
          included_used: 132,
          purchased_balance: 0,
          reserved: 0,
          period_end: yesterdayEnd,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    const s = await read(TENANT);
    expect(s!.remaining).toBe(1_000);
    expect(s!.remaining).not.toBe(4_868);
    await expect(
      assertBuildCreditsAvailable(TENANT, { readBalance: async () => s }),
    ).rejects.toBeInstanceOf(InsufficientCreditsForBuild);
  });

  it("TODAY's daily row is current — a fresh row is not thrown away", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true, free_daily_credits: 1_000 } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 1_000,
          included_used: 372,
          purchased_balance: 0,
          reserved: 0,
          period_end: tomorrow,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    expect((await read(TENANT))!.remaining).toBe(628);
  });

  it("a PAID monthly row stays current until its own month ends", async () => {
    const nextMonth = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true, free_daily_credits: 1_000 } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 48_000,
          included_used: 8_000,
          purchased_balance: 0,
          reserved: 0,
          period_end: nextMonth,
        },
        tenant_subscriptions: { plan: "growth", status: "active" },
      }) as never,
    );
    expect((await read(TENANT))!.remaining).toBe(40_000);
  });

  it("a stale free row falls back to the LIVE daily grant, not the hardcoded constant", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true, free_daily_credits: 1_000 } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 5_000,
          included_used: 5_000,
          purchased_balance: 0,
          reserved: 0,
          period_end: past,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    const s = await read(TENANT);
    expect(s!.remaining).toBe(1_000);
    expect(s!.remaining).not.toBe(FREE_DAILY_CREDITS_SQL_FALLBACK);
  });

  it("falls back to the SQL constant when the config cannot be read", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 5_000,
          included_used: 5_000,
          purchased_balance: 0,
          reserved: 0,
          period_end: past,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    expect((await read(TENANT))!.remaining).toBe(FREE_DAILY_CREDITS_SQL_FALLBACK);
  });

  it("purchased credits survive the daily roll", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true, free_daily_credits: 1_000 } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 5_000,
          included_used: 5_000,
          purchased_balance: 20_000,
          reserved: 0,
          period_end: past,
        },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    );
    expect((await read(TENANT))!.remaining).toBe(21_000);
  });

  it("a CANCELLED tenant on an old paid plan row is read as free, not team", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 80_000,
          included_used: 0,
          purchased_balance: 0,
          reserved: 0,
          period_end: past,
        },
        tenant_subscriptions: { plan: "team", status: "canceled" },
      }) as never,
    );
    const s = await read(TENANT);
    expect(s!.remaining).toBe(FREE_DAILY_CREDITS_SQL_FALLBACK);
    expect(s!.remaining).not.toBe(80_000);
  });

  it("a CANCELLED tenant with a CURRENT paid row still reads as free", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: {
          included_allowance: 80_000,
          included_used: 0,
          purchased_balance: 0,
          reserved: 0,
          period_end: future,
        },
        tenant_subscriptions: { plan: "team", status: "canceled" },
      }) as never,
    );
    const s = await read(TENANT);
    expect(s!.remaining).toBe(FREE_DAILY_CREDITS_SQL_FALLBACK);
    expect(s!.remaining).not.toBe(80_000);
  });

  it("free_plan follows the plan the SQL path grants, not the stored plan column", async () => {
    const balance = {
      included_allowance: 1_000,
      included_used: 0,
      purchased_balance: 0,
      reserved: 0,
      period_end: future,
    };
    const readFor = (sub: Record<string, unknown>) =>
      makeBalanceReader(
        fakeClient({
          system_config: { blob: { credits_enforced: true } },
          tenants: { credits_unlimited: false },
          tenant_credit_balances: balance,
          tenant_subscriptions: sub,
        }) as never,
      )(TENANT);
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect((await readFor({ plan: "free" }))!.free_plan).toBe(true);
    expect((await readFor({ plan: "team", status: "active" }))!.free_plan).toBe(false);
    expect((await readFor({ plan: "team", status: "canceled" }))!.free_plan).toBe(true);
    expect((await readFor({ plan: "free", tier: "starter", comp_expires_at: later }))!.free_plan).toBe(false);
    expect((await readFor({ plan: "free", tier: "starter", comp_expires_at: past }))!.free_plan).toBe(true);
    expect((await readFor({}))!.free_plan).toBe(true);
    expect((await readFor({ plan: "free", tier: "growth", status: "active" }))!.free_plan).toBe(false);
    expect((await readFor({ plan: "free", tier: "pro", status: "past_due" }))!.free_plan).toBe(false);
    expect((await readFor({ plan: "free", tier: "starter", status: "incomplete" }))!.free_plan).toBe(true);
    expect(
      (await readFor({ plan: "free", tier: "starter", status: "active", comp_expires_at: past }))!.free_plan,
    ).toBe(true);
    const toppedUp = await makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: true } },
        tenants: { credits_unlimited: false },
        tenant_credit_balances: { ...balance, purchased_balance: 2_000 },
        tenant_subscriptions: { plan: "free" },
      }) as never,
    )(TENANT);
    expect(toppedUp!.free_plan).toBe(false);
  });

  it("a balance read error returns null, which the guard treats as skip", async () => {
    const read = makeBalanceReader(
      fakeClient({ tenant_credit_balances: new Error("db down") }) as never,
    );
    expect(await read(TENANT)).toBeNull();
  });

  it("reports enforced:false when the global flag is off and the tenant is not allowlisted", async () => {
    const read = makeBalanceReader(
      fakeClient({
        system_config: { blob: { credits_enforced: false } },
        tenant_credit_balances: {
          included_allowance: 0, included_used: 0, purchased_balance: 0, reserved: 0, period_end: future,
        },
      }) as never,
    );
    expect((await read(TENANT))!.enforced).toBe(false);
  });
});

describe("assertBuildCreditsAvailable — no reader wired", () => {
  it("skips rather than refusing, so a mis-wire can never block a build", async () => {
    await expect(assertBuildCreditsAvailable(TENANT, {})).resolves.toBeUndefined();
  });
});
