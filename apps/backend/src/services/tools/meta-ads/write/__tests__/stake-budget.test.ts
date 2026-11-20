
import { describe, it, expect, vi } from "vitest";
import {
  metaBudgetAtStake,
  readLiveDailyBudgetUsd,
  readMetaCardMoneyAtStake,
} from "../_stake-budget";

const usd = async () => "USD";

function pause(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { object_id: "23851", level: "adset", status: "PAUSED", rationale: "", over_cap: false, ...over };
}

describe("metaBudgetAtStake — the pure gate both ends ask", () => {
  it("prices a pause and a resume at the object they name", () => {
    expect(metaBudgetAtStake("meta_ads.set_status", pause())).toEqual({
      object_id: "23851",
      scope: "adset",
    });
    expect(
      metaBudgetAtStake("meta_ads.set_status_review", pause({ level: "campaign", status: "ACTIVE" })),
    ).toEqual({ object_id: "23851", scope: "campaign" });
  });

  it("prices nothing else — a budget change carries its own dollars, a create starts paused", () => {
    expect(metaBudgetAtStake("meta_ads.update_ad_set_budget", { ad_set_id: "1" })).toBeNull();
    expect(metaBudgetAtStake("meta_ads.create_ad_set", { daily_budget_usd: 400 })).toBeNull();
    expect(metaBudgetAtStake("google_ads.set_status", pause())).toBeNull();
  });

  it("refuses a body that names no object or an unknown level", () => {
    expect(metaBudgetAtStake("meta_ads.set_status", pause({ object_id: "  " }))).toBeNull();
    expect(metaBudgetAtStake("meta_ads.set_status", pause({ level: "ad" }))).toBeNull();
  });
});

describe("readLiveDailyBudgetUsd — the one read, and everything it refuses", () => {
  it("reads a campaign's own daily budget under Advantage campaign budget", async () => {
    const get = vi.fn(async () => ({ daily_budget: "4000" }));
    expect(await readLiveDailyBudgetUsd("t-1", "9001", "campaign", { get, currency: usd })).toBe(40);
  });

  it("reads an ad set's own daily budget when the campaign is not holding one", async () => {
    const get = vi.fn(async () => ({
      daily_budget: "2435",
      campaign: { daily_budget: null, lifetime_budget: null },
    }));
    expect(await readLiveDailyBudgetUsd("t-1", "23851", "adset", { get, currency: usd })).toBe(24.35);
  });

  it("stores NOTHING for an ad set under CBO: the campaign keeps spending the same amount", async () => {
    const get = vi.fn(async () => ({
      daily_budget: "2435",
      campaign: { daily_budget: "10000" },
    }));
    expect(await readLiveDailyBudgetUsd("t-1", "23851", "adset", { get, currency: usd })).toBeNull();
  });

  it("stores NOTHING for a campaign whose budget lives on its ad sets", async () => {
    const get = vi.fn(async () => ({ daily_budget: null }));
    expect(await readLiveDailyBudgetUsd("t-1", "9001", "campaign", { get, currency: usd })).toBeNull();
  });

  it("stores NOTHING for a lifetime budget: it is not a daily amount", async () => {
    const get = vi.fn(async () => ({ daily_budget: null, lifetime_budget: "500000", campaign: null }));
    expect(await readLiveDailyBudgetUsd("t-1", "23851", "adset", { get, currency: usd })).toBeNull();
  });

  it("stores NOTHING on a non-USD account, and does not even make the read", async () => {
    const get = vi.fn(async () => ({ daily_budget: "4000" }));
    expect(
      await readLiveDailyBudgetUsd("t-1", "9001", "campaign", { get, currency: async () => "EUR" }),
    ).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("never throws: a failed read is no number, not a failed proposal", async () => {
    const get = vi.fn(async () => {
      throw new Error("token expired");
    });
    expect(await readLiveDailyBudgetUsd("t-1", "9001", "campaign", { get, currency: usd })).toBeNull();
  });

  it("treats a zero or unparseable budget as no answer", async () => {
    const zero = vi.fn(async () => ({ daily_budget: "0" }));
    expect(await readLiveDailyBudgetUsd("t-1", "9001", "campaign", { get: zero, currency: usd })).toBeNull();
    const junk = vi.fn(async () => ({ daily_budget: "not-a-number" }));
    expect(await readLiveDailyBudgetUsd("t-1", "9001", "campaign", { get: junk, currency: usd })).toBeNull();
  });
});

describe("readMetaCardMoneyAtStake — the block attached to the card", () => {
  it("names the object AND the level it was read at", async () => {
    const get = vi.fn(async () => ({ daily_budget: "2435", campaign: null }));
    expect(
      await readMetaCardMoneyAtStake("t-1", "meta_ads.set_status", pause(), { get, currency: usd }),
    ).toEqual({
      daily_budget_usd: 24.35,
      scope: "adset",
      object_id: "23851",
      source: "meta_ads.daily_budget",
    });
  });

  it("spends no read at all on a change the gate refuses", async () => {
    const get = vi.fn(async () => ({ daily_budget: "2435" }));
    expect(
      await readMetaCardMoneyAtStake("t-1", "meta_ads.update_ad_set_budget", { ad_set_id: "1" }, {
        get,
        currency: usd,
      }),
    ).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
