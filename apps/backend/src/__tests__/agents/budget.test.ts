import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  overrideMaybeSingle: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.overrideMaybeSingle }),
      }),
    }),
  }),
}));

vi.mock("@/services/settings", () => ({
  getAppSetting: vi.fn(async () => undefined),
}));

import {
  estimateRunCost,
  resolveDailyCapUsd,
  resolveEnvDailyCapUsd,
  shouldAbortForBudget,
  utcDay,
  consumeBudgetOrReject,
} from "@/services/agents/budget";
import { estimateCostUsd } from "@/services/anthropic";

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.overrideMaybeSingle.mockReset();
  mocks.overrideMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("estimateRunCost", () => {
  it("maps cost_class to an estimate; expensive > standard > cheap", () => {
    expect(estimateRunCost("cheap")).toBeLessThan(estimateRunCost("standard"));
    expect(estimateRunCost("standard")).toBeLessThan(estimateRunCost("expensive"));
  });
});

describe("resolveEnvDailyCapUsd (env floor, sync)", () => {
  const prev = process.env.PRAXIS_DAILY_BUDGET_USD;
  afterEach(() => {
    if (prev === undefined) delete process.env.PRAXIS_DAILY_BUDGET_USD;
    else process.env.PRAXIS_DAILY_BUDGET_USD = prev;
  });
  it("0 when unset (no cap)", () => {
    delete process.env.PRAXIS_DAILY_BUDGET_USD;
    expect(resolveEnvDailyCapUsd()).toBe(0);
  });
  it("parses a positive number", () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "25";
    expect(resolveEnvDailyCapUsd()).toBe(25);
  });
  it("treats junk / non-positive as no cap", () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "abc";
    expect(resolveEnvDailyCapUsd()).toBe(0);
    process.env.PRAXIS_DAILY_BUDGET_USD = "-5";
    expect(resolveEnvDailyCapUsd()).toBe(0);
  });
});

describe("resolveDailyCapUsd (per-tenant override, async)", () => {
  const prev = process.env.PRAXIS_DAILY_BUDGET_USD;
  afterEach(() => {
    if (prev === undefined) delete process.env.PRAXIS_DAILY_BUDGET_USD;
    else process.env.PRAXIS_DAILY_BUDGET_USD = prev;
  });

  it("returns the env default when no tenant is given", async () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "100";
    await expect(resolveDailyCapUsd()).resolves.toBe(100);
    expect(mocks.overrideMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns the env default when the tenant has no override row", async () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "100";
    mocks.overrideMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(resolveDailyCapUsd("tnt-1")).resolves.toBe(100);
  });

  it("returns the tenant override when set (tier cap wins over env default)", async () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "100";
    mocks.overrideMaybeSingle.mockResolvedValueOnce({
      data: { daily_cap_usd: 20 },
      error: null,
    });
    await expect(resolveDailyCapUsd("tnt-solo")).resolves.toBe(20);
  });

  it("ignores a junk/negative override and keeps the env floor", async () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "100";
    mocks.overrideMaybeSingle.mockResolvedValueOnce({
      data: { daily_cap_usd: -5 },
      error: null,
    });
    await expect(resolveDailyCapUsd("tnt-junk")).resolves.toBe(100);
  });

  it("fails OPEN to env default on lookup error (does not strip the cap)", async () => {
    process.env.PRAXIS_DAILY_BUDGET_USD = "100";
    mocks.overrideMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "db blip" },
    });
    await expect(resolveDailyCapUsd("tnt-err")).resolves.toBe(100);
  });
});

describe("utcDay", () => {
  it("returns YYYY-MM-DD", () => {
    expect(utcDay(new Date("2026-05-20T23:59:59Z"))).toBe("2026-05-20");
  });
});

describe("shouldAbortForBudget (mid-stream gate, part c)", () => {
  it("uncapped (headroom Infinity) → never aborts", () => {
    expect(shouldAbortForBudget(9999, Number.POSITIVE_INFINITY, 0.5)).toBe(false);
  });

  it("below the margin boundary → does not abort ($9.40 of $10, margin $0.5)", () => {
    expect(shouldAbortForBudget(9.4, 10, 0.5)).toBe(false);
  });

  it("at the margin boundary → aborts ($9.50 of $10, margin $0.5)", () => {
    expect(shouldAbortForBudget(9.5, 10, 0.5)).toBe(true);
  });

  it("past the margin boundary → aborts ($9.80 of $10)", () => {
    expect(shouldAbortForBudget(9.8, 10, 0.5)).toBe(true);
  });

  it("run accepted right at the cap still gets its full reservation before aborting", () => {
    const headroom = 0.2;
    const margin = 0.5;
    const reservation = 0.1;
    expect(shouldAbortForBudget(0.05, headroom, margin, reservation)).toBe(false);
    expect(shouldAbortForBudget(0.1, headroom, margin, reservation)).toBe(true);
  });

  it("with ample headroom the margin gate dominates the reservation floor", () => {
    expect(shouldAbortForBudget(0.5, 100, 0.5, 0.1)).toBe(false);
    expect(shouldAbortForBudget(99.5, 100, 0.5, 0.1)).toBe(true);
  });

  it("simulated tool-loop: accruing per-turn Opus usage halts within margin", () => {
    const headroom = 2.0;
    const margin = 0.5;
    let accrued = 0;
    let abortedAt = -1;
    for (let turn = 1; turn <= 50; turn++) {
      accrued += estimateCostUsd("claude-opus-4-7", {
        input_tokens: 10_000,
        output_tokens: 2_000,
      });
      if (shouldAbortForBudget(accrued, headroom, margin)) {
        abortedAt = turn;
        break;
      }
    }
    expect(abortedAt).toBeGreaterThan(0);
    expect(accrued).toBeGreaterThanOrEqual(headroom - margin);
    expect(accrued).toBeLessThan(headroom + 0.2);
  });
});

describe("consumeBudgetOrReject", () => {
  it("passes params through and returns true when charged", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    const ok = await consumeBudgetOrReject({
      tenant_id: "tnt-1",
      estimate: 0.8,
      dailyCap: 25,
      day: "2026-05-20",
    });
    expect(ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("consume_budget_or_reject", {
      p_tenant_id: "tnt-1",
      p_day: "2026-05-20",
      p_estimate: 0.8,
      p_daily_cap: 25,
    });
  });

  it("returns false when the cap rejects the charge", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    const ok = await consumeBudgetOrReject({
      tenant_id: "tnt-1",
      estimate: 0.8,
      dailyCap: 1,
    });
    expect(ok).toBe(false);
  });

  it("throws on RPC error (fail-closed handled by caller)", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(
      consumeBudgetOrReject({ tenant_id: "tnt-1", estimate: 0.1, dailyCap: 0 }),
    ).rejects.toThrow(/consume_budget_or_reject failed: boom/);
  });
});
