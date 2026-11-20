
import { describe, it, expect } from "vitest";
import {
  DAILY_AGGREGATE_UNREADABLE,
  simulateBudgetWrite,
  simulateCreateWrite,
} from "../_simulate";
import type { Cap } from "../_cap-evaluator";

const cap: Cap = {
  enabled: true,
  max_daily_budget_usd: 1000,
  max_pct_change_per_run: null,
  max_daily_total_change_usd: 100,
};

describe("a dry run on an unreadable day reports the aggregate as unavailable", () => {
  it("budget: today_aggregate_after_usd is null, not a fabricated total", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 55,
      today_total_change_usd: DAILY_AGGREGATE_UNREADABLE,
      cap,
    });
    expect(s.today_aggregate_after_usd).toBeNull();
    expect(s.within).toBe(false);
    expect(s.reason).toBe("over_daily_aggregate");
  });

  it("create: same, on the from-zero path", () => {
    const s = simulateCreateWrite({
      campaign_id: "c-1",
      name: "Test ad set",
      daily_budget_usd: 25,
      today_total_change_usd: DAILY_AGGREGATE_UNREADABLE,
      cap,
    });
    expect(s.today_aggregate_after_usd).toBeNull();
    expect(s.within).toBe(false);
  });

  it("nothing in the serialised simulation carries the sentinel", () => {
    const json = JSON.stringify(
      simulateBudgetWrite({
        current_daily_budget_usd: 40,
        proposed_daily_budget_usd: 55,
        today_total_change_usd: DAILY_AGGREGATE_UNREADABLE,
        cap,
      }),
    );
    expect(json).not.toContain(String(DAILY_AGGREGATE_UNREADABLE));
    expect(json).not.toMatch(/900719925474\d{4}/);
  });

  it("a day that WAS read is still reported as a number", () => {
    const s = simulateBudgetWrite({
      current_daily_budget_usd: 40,
      proposed_daily_budget_usd: 55,
      today_total_change_usd: 10,
      cap,
    });
    expect(s.today_aggregate_after_usd).toBe(25);
    expect(s.within).toBe(true);
  });
});
