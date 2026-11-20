import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  campaigns: vi.fn(),
  funding: vi.fn(),
  get: vi.fn(),
  token: vi.fn(),
  db: vi.fn(),
}));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<object>()),
  tenantClient: mocks.db,
}));
vi.mock("./client", async (orig) => ({
  ...(await orig<object>()),
  listXAdAccountsRaw: mocks.accounts,
  listXCampaignRows: mocks.campaigns,
  listXFundingInstruments: mocks.funding,
  xAdsGet: mocks.get,
  xAdsTenantToken: mocks.token,
}));
import { readXAccountsForBudget } from "./budget-ledger";
const now = new Date("2026-10-09T02:15:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { slug: "x_ads" }, error: null }),
        }),
      }),
    }),
  });
  mocks.token.mockResolvedValue({ key: "key", secret: "secret" });
  mocks.accounts.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
  mocks.campaigns.mockResolvedValue([
    {
      campaign_id: "c1",
      name: "Test",
      daily_budget: 5,
      total_budget: 25,
      status: "ACTIVE",
      currency: "USD",
    },
  ]);
  mocks.funding.mockResolvedValue([{ currency: "USD" }]);
  mocks.get.mockImplementation(
    async (_token: unknown, path: string, params: Record<string, string>) => {
      const hours =
        (Date.parse(params.end_time) - Date.parse(params.start_time)) / 3600000;
      return {
        data: [
          {
            id: path.split("/").at(-1),
            id_data: [
              {
                metrics: {
                  billed_charge_local_micro: Array.from(
                    { length: hours },
                    () => 1000000,
                  ),
                },
              },
            ],
          },
        ],
      };
    },
  );
});
describe("complete X Ads spend ledger", () => {
  it("reads all advertisers and all documented placements, using complete UTC hours", async () => {
    const reads = await readXAccountsForBudget(
      "tenant",
      new Date("2026-10-09T00:00:00Z"),
      now,
    );
    expect(reads).toHaveLength(2);
    expect(reads[0].spend).toEqual([
      {
        object_id: "account_a1",
        spend_date: "2026-10-09",
        amount_usd: 6,
        provisional: true,
      },
    ]);
    expect(mocks.get.mock.calls.map((call) => call[2].placement)).toEqual([
      "ALL_ON_TWITTER",
      "SPOTLIGHT",
      "TREND",
      "ALL_ON_TWITTER",
      "SPOTLIGHT",
      "TREND",
    ]);
    expect(mocks.get.mock.calls[0][2]).toMatchObject({
      entity: "ACCOUNT",
      granularity: "HOUR",
      start_time: "2026-10-09T00:00:00Z",
      end_time: "2026-10-09T02:00:00.000Z",
    });
  });
  it("refuses incomplete billed data instead of lowering the shared actual", async () => {
    mocks.get.mockResolvedValue({
      data: [
        {
          id: "a1",
          id_data: [{ metrics: { billed_charge_local_micro: [null, 0] } }],
        },
      ],
    });
    await expect(
      readXAccountsForBudget("tenant", new Date("2026-10-09T00:00:00Z"), now),
    ).rejects.toThrow(/incomplete/);
  });
  it("does not count another currency as dollars", async () => {
    mocks.funding.mockResolvedValue([{ currency: "INR" }]);
    await expect(readXAccountsForBudget("tenant", now, now)).rejects.toThrow(
      /USD/,
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("must catch: no billing (null or every hour null) while nothing could serve (a draft, a campaign paused before the window) reads $0", async () => {
    mocks.campaigns.mockResolvedValue([
      { campaign_id: "c1", name: "Spring", daily_budget: 5, total_budget: null, status: "PAUSED", currency: "USD", updated_at: "2026-09-01T00:00:00Z" },
      { campaign_id: "c2", name: "Draft", daily_budget: 5, total_budget: null, status: "DRAFT", currency: "USD" },
    ]);
    mocks.get.mockResolvedValue({ data: [{ id: "a1", id_data: [{ metrics: { billed_charge_local_micro: [null, null] } }] }] });
    const reads = await readXAccountsForBudget("tenant", new Date("2026-10-09T00:00:00Z"), now);
    expect(reads).toHaveLength(2);
    expect(reads[0].spend).toEqual([]);
  });
  it("must not catch: a campaign paused inside the window may have spent: no billing stays unknown", async () => {
    mocks.campaigns.mockResolvedValue([{ campaign_id: "c1", name: "Spring", daily_budget: 5, total_budget: null, status: "PAUSED", currency: "USD", updated_at: "2026-10-09T01:00:00Z" }]);
    mocks.get.mockResolvedValue({ data: [{ id: "a1", id_data: [{ metrics: { billed_charge_local_micro: null } }] }] });
    await expect(readXAccountsForBudget("tenant", new Date("2026-10-09T00:00:00Z"), now)).rejects.toThrow(/incomplete|missing/);
  });
  it("must not catch: a running campaign with no billing stays unknown", async () => {
    mocks.get.mockResolvedValue({ data: [{ id: "a1", id_data: [{ metrics: { billed_charge_local_micro: null } }] }] });
    await expect(readXAccountsForBudget("tenant", new Date("2026-10-09T00:00:00Z"), now)).rejects.toThrow(/incomplete|missing/);
  });
  it("must not catch: one placement billed and another silent is incomplete, never a short total", async () => {
    mocks.campaigns.mockResolvedValue([{ campaign_id: "c2", name: "Draft", daily_budget: 5, total_budget: null, status: "DRAFT", currency: "USD" }]);
    let k = 0;
    mocks.get.mockImplementation(async () => ({ data: [{ id: "a1", id_data: [{ metrics: { billed_charge_local_micro: k++ === 0 ? [1000000, 0] : [null, null] } }] }] }));
    await expect(readXAccountsForBudget("tenant", new Date("2026-10-09T00:00:00Z"), now)).rejects.toThrow(/incomplete|missing/);
  });
});
