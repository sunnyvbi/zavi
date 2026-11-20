import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  accounts: vi.fn(),
  token: vi.fn(),
  campaigns: vi.fn(),
  funding: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("@/services/connectors/x-ads/client", async (orig) => ({
  ...(await orig<object>()),
  listXAdAccounts: mocks.accounts,
  xAdsTenantToken: mocks.token,
  listXCampaignRows: mocks.campaigns,
  listXFundingInstruments: mocks.funding,
  xCampaignStats: mocks.stats,
}));
import { readXAdsEvidence } from "./x-ad-evidence";
import { receiptKind, createdOf, activationTarget } from "./cgo-tests";
const now = new Date("2026-10-09T12:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.mockResolvedValue([{ id: "a1" }]);
  mocks.token.mockResolvedValue({ key: "key", secret: "secret" });
  mocks.campaigns.mockResolvedValue([
    { campaign_id: "c1", name: "Spring", status: "ACTIVE", currency: "USD" },
  ]);
  mocks.funding.mockResolvedValue([]);
  mocks.stats.mockResolvedValue(
    Object.assign(
      new Map([
        ["c1", { spend: 7, impressions: 100, clicks: 5, conversions: 0 }],
      ]),
      { conversionsRead: false, missing: new Map() },
    ),
  );
});
describe("X Ads CGO evidence", () => {
  it("uses seven complete UTC days and keeps unreported conversions unknown", async () => {
    const result = await readXAdsEvidence("tenant", now);
    expect(mocks.stats).toHaveBeenCalledWith(
      { key: "key", secret: "secret" },
      "a1",
      ["c1"],
      "2026-10-02",
      "2026-10-08",
    );
    expect(result).toMatchObject({
      status: "read",
      channel_slug: "x_ads",
      source: "X Ads campaign analytics",
    });
    expect(result.campaigns?.[0].reported?.metrics).toMatch(/spend 7/);
    expect(result.campaigns?.[0].reported?.metrics).not.toMatch(/conversions/);
    expect(result.reason).toMatch(/health unverified/);
  });
  it("does not pick an arbitrary advertiser from multiple accounts", async () => {
    mocks.accounts.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    expect(await readXAdsEvidence("tenant", now)).toMatchObject({
      status: "could not read",
      reason: expect.stringMatching(/Multiple/),
    });
    expect(mocks.stats).not.toHaveBeenCalled();
  });
  it("missing billing is not reported as zero spend", async () => {
    mocks.stats.mockResolvedValue(
      Object.assign(
        new Map([
          ["c1", { spend: 0, impressions: 100, clicks: 5, conversions: 0 }],
        ]),
        {
          conversionsRead: true,
          missing: new Map([["c1", new Set(["spend", "conversions"])]]),
        },
      ),
    );
    const result = await readXAdsEvidence("tenant", now);
    expect(result.campaigns?.[0].reported?.metrics).not.toMatch(
      /spend|conversions/,
    );
  });
  it("a paused creation is prepared evidence and deletion never establishes a live experiment", () => {
    expect(
      createdOf({
        exec_result: {
          created: {
            platform: "x",
            object_type: "campaign",
            id: "c1",
            status: "PAUSED",
          },
        },
      }),
    ).toMatchObject({ platform: "x", id: "c1" });
    expect(
      activationTarget({
        exec_class: "x_ads.set_status",
        exec_payload: { campaign_id: "c1", status: "ACTIVE" },
      }),
    ).toEqual({ platform: "x", object_type: "campaign", id: "c1" });
    expect(
      receiptKind({
        exec_class: "x_ads.create_campaign",
        exec_payload: { launch: "PAUSED" },
      }),
    ).toBe("prepared");
    expect(
      receiptKind({
        exec_class: "x_ads.create_campaign",
        exec_payload: { launch: "ACTIVE" },
      }),
    ).toBe("live");
    expect(
      receiptKind({
        exec_class: "x_ads.manage_objects",
        exec_payload: { request: { operation: "delete_campaign" } },
      }),
    ).toBe("reduction");
  });
});
