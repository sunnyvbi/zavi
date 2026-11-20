
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tz: "Asia/Jerusalem",
  unchanged: false,
  lastAt: "2026-10-23T05:00:00.000Z" as string | null,
  enqueue: vi.fn(async () => ({ enqueued: true as const, run_id: "r-1" })),
  skips: [] as Array<[string, string, string]>,
}));

vi.mock("@/services/analytics/tenant-timezone", () => ({ resolveReportingTimezone: async () => ({ tz: h.tz, source: "stored" }) }));
vi.mock("../cgo-ads", async (orig) => ({ ...(await orig<typeof import("../cgo-ads")>()), cgoAdBudget: async () => ({ id: "b1" }) }));
vi.mock("../budget-review-signature", () => ({
  currentBudgetSignature: async () => "sig",
  readLastReview: async () => ({ status: "success", signature: "sig", enqueued_at: h.lastAt }),
  nothingChangedSince: () => h.unchanged,
}));
vi.mock("../goal-owner", async (orig) => ({ ...(await orig<typeof import("../goal-owner")>()), enqueueGoalOwnerRun: h.enqueue }));
vi.mock("../cgo-wake-skips", () => ({ recordWakeSkip: async (t: string, r: string, w: string) => void h.skips.push([t, r, w]) }));

import { defaultControllerDeps } from "../ad-spend-controller";

const T = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.tz = "Asia/Jerusalem";
  h.unchanged = false;
  h.lastAt = "2026-10-23T05:00:00.000Z";
  h.enqueue.mockClear();
  h.skips = [];
});

describe("defaultControllerDeps.wakeCgo goes through the budget-review admission", () => {
  it("must-catch: an open gap at 04:41 tenant time wakes nothing (a founder got a review email at 04:55 local)", async () => {
    const r = await defaultControllerDeps.wakeCgo(T, new Date("2026-10-23T01:41:00Z"));
    expect(r).toEqual({ woke: false, why: "not_a_wake_hour" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("must-catch: at a wake hour, an unchanged signature wakes nothing and records the skip", async () => {
    h.unchanged = true;
    const r = await defaultControllerDeps.wakeCgo(T, new Date("2026-10-23T07:41:00Z"));
    expect(r).toEqual({ woke: false, why: "nothing_changed" });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.skips).toEqual([[T, "ad_budget_review", "nothing_changed"]]);
  });

  it("must-catch: unchanged, but cgo has not reviewed in 24h: the gap wake runs once (an ad that stopped delivering)", async () => {
    h.unchanged = true;
    h.lastAt = "2026-10-22T06:00:00.000Z";
    const r = await defaultControllerDeps.wakeCgo(T, new Date("2026-10-23T07:41:00Z"));
    expect(r).toEqual({ woke: true });
    expect(h.skips).toEqual([]);
  });

  it("must-not-touch: at a wake hour with something changed, the review still starts", async () => {
    const r = await defaultControllerDeps.wakeCgo(T, new Date("2026-10-23T07:41:00Z"));
    expect(r).toEqual({ woke: true });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, reason: "ad_budget_review" }));
  });
});
