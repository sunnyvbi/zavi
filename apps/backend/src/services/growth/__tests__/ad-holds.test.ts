
import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "73db45ff-0000-4000-8000-000000000001";
const upserts: Array<{ row: Record<string, unknown>; opts: unknown }> = [];
let upsertError: { message: string } | null = null;

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>, opts: unknown) => {
        upserts.push({ row, opts });
        return { error: upsertError };
      },
    }),
  }),
}));

const withdrawHeldObjectQuestion = vi.fn(async () => true);
vi.mock("../settled-questions", () => ({ withdrawHeldObjectQuestion: (...a: unknown[]) => withdrawHeldObjectQuestion(...(a as [])) }));

import { isQuietHold, quietHoldWords, tellQuietHold } from "../ad-holds";

const NOW = new Date("2026-10-23T15:41:00Z");
const hostAreas = { ad_set_id: "120260590327570059", name: "Host Recommended Areas", daily_budget_usd: 168, expected_current_daily_budget_usd: 140 };

describe("isQuietHold / quietHoldWords", () => {
  it("quiet only when EVERY reason is the founder's own budget or a running test", () => {
    expect(isQuietHold(["founder_set_budget|outside|2026-10-12|meta|up"])).toBe(true);
    expect(isQuietHold(["budget_test_running|2026-10-28"])).toBe(true);
    expect(isQuietHold(["founder_set_budget", "budget_test_running|2026-10-28"])).toBe(true);
    expect(isQuietHold(["founder_set_budget|outside|2026-10-12|meta|up", "results_not_goal"])).toBe(false);
    expect(isQuietHold(["budget_owner_unknown"])).toBe(false);
    expect(isQuietHold(["budget_test_unknown"])).toBe(false);
    expect(isQuietHold([])).toBe(false);
  });

  it("Zavi's own 24h raise spacing is quiet alone or with other quiet reasons; with any other reason it still asks (2026-10-29)", () => {
    expect(isQuietHold(["raised_in_last_day"])).toBe(true);
    expect(isQuietHold(["raised_in_last_day", "founder_set_budget|outside|2026-10-12|meta|up"])).toBe(true);
    expect(isQuietHold(["raise_history_unknown"])).toBe(false);
    expect(isQuietHold(["raised_in_last_day", "tracking_broken"])).toBe(false);
    expect(quietHoldWords(["raised_in_last_day"])).toEqual({ words: "Zavi started a raise on it in the last 24 hours", until_on: null });
    expect(quietHoldWords(["raised_in_last_day", "founder_set_budget|outside|2026-10-12|meta|up"]).words).toBe("you set it Oct 12");
  });

  it("says it in the founder's words with the reason's own date", () => {
    expect(quietHoldWords(["founder_set_budget|outside|2026-10-12|meta|up"])).toEqual({ words: "you set it Oct 12", until_on: null });
    expect(quietHoldWords(["budget_test_running|2026-10-28"])).toEqual({ words: "test until Oct 28", until_on: "2026-10-28" });
    expect(quietHoldWords(["founder_set_budget"]).words).toBe("you set it yourself");
  });
});

describe("tellQuietHold", () => {
  beforeEach(() => {
    upserts.length = 0;
    upsertError = null;
    withdrawHeldObjectQuestion.mockClear();
  });

  it("#9: writes the line with name and both amounts, then withdraws the open question about that ad set", async () => {
    const ok = await tellQuietHold(T, "meta_ads.update_ad_set_budget", hostAreas, ["founder_set_budget|outside|2026-10-12|meta|up"], NOW);
    expect(ok).toBe(true);
    expect(upserts[0].row).toMatchObject({
      tenant_id: T,
      object_key: "meta:120260590327570059",
      name: "Host Recommended Areas",
      from_usd: 140,
      to_usd: 168,
      reason: "you set it Oct 12",
      updated_at: NOW.toISOString(),
    });
    expect(upserts[0].opts).toEqual({ onConflict: "tenant_id,object_key" });
    expect(withdrawHeldObjectQuestion).toHaveBeenCalledWith(T, "held:meta-ads:120260590327570059", NOW);
  });

  it("Gig Atlanta 2026-10-29: a controller raise held only by Zavi's own spacing is a Growth-page line, and its open question is withdrawn", async () => {
    const gig = { ad_set_id: "120261012970200059", name: "Zavi · Gig Rentals Purchase - Atlanta 25mi", daily_budget_usd: 103.68, expected_current_daily_budget_usd: 86.4 };
    expect(await tellQuietHold(T, "meta_ads.update_ad_set_budget", gig, ["raised_in_last_day"], NOW)).toBe(true);
    expect(upserts[0].row).toMatchObject({ object_key: "meta:120261012970200059", name: "Gig Rentals Purchase - Atlanta 25mi", from_usd: 86.4, to_usd: 103.68, reason: "Zavi started a raise on it in the last 24 hours" });
    expect(withdrawHeldObjectQuestion).toHaveBeenCalledWith(T, "held:meta-ads:120261012970200059", NOW);
  });

  it("must-not: a failed write returns false and withdraws nothing, so the caller asks as before", async () => {
    upsertError = { message: "down" };
    expect(await tellQuietHold(T, "meta_ads.update_ad_set_budget", hostAreas, ["budget_test_running|2026-10-28"], NOW)).toBe(false);
    expect(withdrawHeldObjectQuestion).not.toHaveBeenCalled();
  });

  it("must-not: a held CUT is never quiet (it is still asked; the line only says raise)", async () => {
    const cut = { ...hostAreas, daily_budget_usd: 140, expected_current_daily_budget_usd: 168 };
    expect(await tellQuietHold(T, "meta_ads.update_ad_set_budget", cut, ["founder_set_budget|outside|2026-10-12|meta|down"], NOW)).toBe(false);
    const noFrom = { ad_set_id: "1", daily_budget_usd: 168 };
    expect(await tellQuietHold(T, "meta_ads.update_ad_set_budget", noFrom, ["founder_set_budget"], NOW)).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("must-not: a hold that is not quiet writes nothing", async () => {
    expect(await tellQuietHold(T, "meta_ads.update_ad_set_budget", hostAreas, ["founder_paused_it"], NOW)).toBe(false);
    expect(upserts).toHaveLength(0);
  });
});
