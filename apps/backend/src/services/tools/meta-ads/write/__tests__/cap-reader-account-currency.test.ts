
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  currency: "INR",
  rate: 80,
  cap: { enabled: true, max_daily_budget_usd: 50, max_pct_change_per_run: 0.5, max_daily_total_change_usd: 100 } as unknown,
  executed: [] as Array<{ run_id: string; exec_class: string; exec_payload: Record<string, unknown> }>,
}));

vi.mock("../../_client", () => ({ getAdAccountCurrency: async () => state.currency }));
vi.mock("../_fx-rate", () => ({
  unitsPerUsd: async (c: string) => (c.toUpperCase() === "USD" ? 1 : state.rate),
}));

function chain(result: { data: unknown; error: null }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "neq", "or"]) q[m] = () => q;
  q.maybeSingle = async () => result;
  q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return q;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) =>
      table === "tenant_ads_write_caps"
        ? chain({ data: state.cap, error: null })
        : table === "channel_actions"
          ? chain({ data: state.executed, error: null })
          : chain({ data: [], error: null }),
  }),
}));

import { readTenantCapAndToday } from "../cap-reader";

beforeEach(() => {
  state.currency = "INR";
  state.rate = 80;
  state.executed = [];
});

describe("readTenantCapAndToday on an INR account", () => {
  it("returns the $50 / $100 caps as ₹4,000 / ₹8,000 and says what unit it answered in", async () => {
    const out = await readTenantCapAndToday("t1");
    expect(out.currency).toBe("INR");
    expect(out.units_per_usd).toBe(80);
    expect(out.cap).toMatchObject({ max_daily_budget_usd: 4000, max_daily_total_change_usd: 8000, max_pct_change_per_run: 0.5 });
  });

  it("puts an INR raise and a pre-INR (USD) raise from the same day in rupees", async () => {
    state.executed = [
      { run_id: "r1", exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "1", daily_budget_usd: 3000, expected_current_daily_budget_usd: 2000, currency: "INR" } },
      { run_id: "r2", exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ad_set_id: "2", daily_budget_usd: 30, expected_current_daily_budget_usd: 20 } },
    ];
    const out = await readTenantCapAndToday("t1");
    expect(out.today_total_change_usd).toBe(1800);
  });

  it("is unchanged for a USD account", async () => {
    state.currency = "USD";
    const out = await readTenantCapAndToday("t1");
    expect(out.units_per_usd).toBe(1);
    expect(out.cap).toMatchObject({ max_daily_budget_usd: 50, max_daily_total_change_usd: 100 });
  });

  it("refuses an account whose currency cannot be written, rather than compare across units", async () => {
    state.currency = "JPY";
    await expect(readTenantCapAndToday("t1")).rejects.toMatchObject({ code: "meta_ads_unsupported_currency" });
  });
});
