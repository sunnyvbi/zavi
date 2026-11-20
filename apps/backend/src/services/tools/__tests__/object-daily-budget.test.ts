import { describe, it, expect, vi, beforeEach } from "vitest";

const meta = vi.hoisted(() => ({ get: vi.fn(), currency: vi.fn() }));
const google = vi.hoisted(() => ({ budget: vi.fn(), exclusive: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: meta.get, getAdAccountCurrency: meta.currency }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsGetCampaignBudget: google.budget }));
vi.mock("@/services/tools/google-ads/write/_stake-budget", () => ({ readExclusiveCampaignDailyBudgetUsd: google.exclusive }));

import { googleCampaignDailyBudget, metaObjectDailyBudget } from "../_object-daily-budget";

const LIVE = { campaign_status: "PAUSED", amount_micros: 15_000_000, budget_resource: "customers/1/campaignBudgets/7" };

beforeEach(() => {
  meta.get.mockReset();
  meta.currency.mockReset().mockResolvedValue("USD");
  google.budget.mockReset().mockResolvedValue(LIVE);
  google.exclusive.mockReset();
});

describe("Meta: budget and status read together", () => {
  it("an ad set's budget in major units with its status and currency", async () => {
    meta.get.mockResolvedValue({ status: "PAUSED", daily_budget: "6000" });
    expect(await metaObjectDailyBudget("t", "900")).toEqual({ object_daily_budget: 60, object_status: "PAUSED", currency: "USD" });
    expect(meta.get).toHaveBeenCalledWith("t", "900", { fields: "status,daily_budget" });
  });

  it("no status, an ad set under a campaign budget, or a failed read stamps nothing", async () => {
    meta.get.mockResolvedValue({ daily_budget: "6000" });
    expect(await metaObjectDailyBudget("t", "900")).toEqual({});
    meta.get.mockResolvedValue({ status: "ACTIVE" });
    expect(await metaObjectDailyBudget("t", "900")).toEqual({});
    meta.get.mockRejectedValue(new Error("rate limited"));
    expect(await metaObjectDailyBudget("t", "900")).toEqual({});
  });
});

describe("Google: only a budget the campaign holds by itself", () => {
  it("an exclusive budget with the campaign status, from one budget read", async () => {
    google.exclusive.mockImplementation(async (_t: string, _c: string, deps: { getBudget: () => Promise<unknown> }) => {
      expect(await deps.getBudget()).toBe(LIVE);
      return 15;
    });
    expect(await googleCampaignDailyBudget("t", "1")).toEqual({ object_daily_budget: 15, object_status: "PAUSED" });
    expect(google.budget).toHaveBeenCalledTimes(1);
  });

  it("F1: a shared budget (exclusivity not proven) stamps no amount", async () => {
    google.exclusive.mockResolvedValue(null);
    expect(await googleCampaignDailyBudget("t", "1")).toEqual({});
  });

  it("an unreadable status or a failed read stamps nothing", async () => {
    google.budget.mockResolvedValue({ ...LIVE, campaign_status: "" });
    google.exclusive.mockResolvedValue(15);
    expect(await googleCampaignDailyBudget("t", "1")).toEqual({});
    google.budget.mockRejectedValue(new Error("down"));
    expect(await googleCampaignDailyBudget("t", "1")).toEqual({});
  });
});
