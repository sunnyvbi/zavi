import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  view: vi.fn(),
  release: vi.fn(),
  token: vi.fn(),
  access: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<object>()),
  tenantClient: mocks.db,
}));
vi.mock("@/services/decisions/ad-budget", () => ({
  readAdBudgetMonthView: mocks.view,
  releaseAdSpendForObject: mocks.release,
}));
vi.mock("./client", () => ({
  xAdsTenantToken: mocks.token,
  getXCampaign: mocks.get,
  updateXCampaign: mocks.update,
}));
vi.mock("./resources", () => ({ assertXWriteAccess: mocks.access }));
vi.mock("@/services/growth/cgo-blockers", () => ({
  alertFounderSafely: mocks.alert,
}));
import { enforceXBudget, xBudgetStopReason } from "./budget-stop";

const now = new Date("2026-10-09T02:00:00Z");
let otherRows: Array<Record<string, unknown>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  otherRows = [];
  mocks.db.mockReturnValue({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        not: () => q,
        limit: async () => ({
          data:
            table === "ad_budget_reservations"
              ? [{ object_id: "c1" }]
              : [
                  {
                    platform: "x",
                    account_id: "a1",
                    object_id: "c1",
                    status: "ACTIVE",
                    budget_kind: "daily",
                    budget_usd: 10,
                    as_of: now.toISOString(),
                  },
                  ...otherRows,
                ],
          error: null,
        }),
        maybeSingle: async () => ({ data: { account_id: "a1" }, error: null }),
      };
      return q;
    },
  });
  mocks.view.mockResolvedValue({
    id: "b1",
    status: "active",
    month_cap_usd: 500,
    spent_usd: 0,
    creator_held_usd: 0,
    creator_spent_usd: 0,
    daily_limit_usd: 15,
    days_left: 10,
    actual_read_at: now.toISOString(),
  });
  mocks.token.mockResolvedValue({ key: "key", secret: "secret" });
  mocks.get.mockReset();
  mocks.get
    .mockResolvedValueOnce({ status: "ACTIVE" })
    .mockResolvedValue({ status: "PAUSED" });
});

const safe = {
  active: true,
  fresh: true,
  complete: true,
  remaining: 300,
  dailyCapacity: 10,
  dailyLimit: 15,
  daysLeft: 30,
};
describe("X Ads shared budget stop", () => {
  it("permits capacity that fits both shared caps", () =>
    expect(xBudgetStopReason(safe)).toBeNull());
  it("stops at monthly exhaustion or unsafe monthly projection", () => {
    expect(xBudgetStopReason({ ...safe, remaining: 0 })).toMatch(/monthly/);
    expect(xBudgetStopReason({ ...safe, dailyCapacity: 11 })).toMatch(
      /monthly/,
    );
  });
  it("enforces a tighter daily cap", () =>
    expect(xBudgetStopReason({ ...safe, dailyLimit: 9 })).toMatch(/daily/));
  it.each([{ active: false }, { fresh: false }, { complete: false }])(
    "stops on disabled or unreadable shared budget state %j",
    (change) =>
      expect(xBudgetStopReason({ ...safe, ...change })).not.toBeNull(),
  );
  it("pauses managed campaigns after a shared daily breach and releases only after read-back", async () => {
    await enforceXBudget("tenant", now);
    expect(mocks.update).toHaveBeenCalledWith(
      { key: "key", secret: "secret" },
      "a1",
      "c1",
      { entity_status: "PAUSED" },
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledWith("tenant", "x", "c1");
    expect(mocks.release.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.get.mock.invocationCallOrder[1],
    );
    expect(mocks.alert).toHaveBeenCalledWith("tenant", "X Ads budget stop", [
      expect.objectContaining({ at_risk_now: false }),
    ]);
  });
  it("retains spending holds and alerts when a pause cannot be confirmed", async () => {
    mocks.get.mockReset().mockResolvedValue({ status: "ACTIVE" });
    await expect(enforceXBudget("tenant", now)).rejects.toThrow(
      /could not confirm/,
    );
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith("tenant", "X Ads budget stop", [
      expect.objectContaining({ at_risk_now: true }),
    ]);
  });
  it("a Meta campaign budget (CBO) is counted, not a reason to stop X", async () => {
    mocks.view.mockResolvedValue({ id: "b1", status: "active", month_cap_usd: 5000, spent_usd: 0, creator_held_usd: 0, creator_spent_usd: 0, daily_limit_usd: 100, days_left: 10, actual_read_at: now.toISOString() });
    const cbo = { platform: "meta", account_id: "m1", campaign_id: "mc1", status: "ACTIVE", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 30, as_of: now.toISOString() };
    otherRows = [{ ...cbo, object_id: "as1" }, { ...cbo, object_id: "as2" }];
    await enforceXBudget("tenant", now);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
    mocks.view.mockResolvedValue({ id: "b1", status: "active", month_cap_usd: 5000, spent_usd: 0, creator_held_usd: 0, creator_spent_usd: 0, daily_limit_usd: 45, days_left: 10, actual_read_at: now.toISOString() });
    await enforceXBudget("tenant", now);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it.each([
    { platform: "google", budget_kind: "shared", budget_usd: null, campaign_budget_usd: null },
    { platform: "meta", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: null },
  ])("an unreadable budget elsewhere still stops X (fail closed): %j", async (shape) => {
    mocks.view.mockResolvedValue({ id: "b1", status: "active", month_cap_usd: 5000, spent_usd: 0, creator_held_usd: 0, creator_spent_usd: 0, daily_limit_usd: 100, days_left: 10, actual_read_at: now.toISOString() });
    otherRows = [{ account_id: "o1", object_id: "o1", campaign_id: "oc1", status: "ACTIVE", as_of: now.toISOString(), ...shape }];
    await enforceXBudget("tenant", now);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
