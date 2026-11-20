import { beforeEach, describe, expect, it, vi } from "vitest";
const get = vi.fn();
vi.mock("../http", () => ({ linkedinAdsGet: (...args: unknown[]) => get(...args) }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tenant-token" }));
import { listLinkedInAdAccounts, listLinkedInCampaigns, readLinkedInAdAnalytics } from "../client";
const opts = { pivot: "CAMPAIGN" as const, start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 10, day: 7 } };
beforeEach(() => get.mockReset());
describe("LinkedIn evidence boundary", () => {
  it("marks omitted and suppressed metrics unknown but retains measured zero", async () => {
    get.mockResolvedValue({ elements: [{ pivotValues: ["urn:li:sponsoredCampaign:1"], impressions: 0, clicks: 2, costInLocalCurrency: "12.50" }] });
    const [r] = await readLinkedInAdAnalytics("tenant", "123", opts);
    expect(r).toMatchObject({ impressions: 0, clicks: 2, spend: 12.5, missing_metrics: ["conversions", "leads"] });
    expect(get.mock.calls[0][2]).toMatchObject({ timeGranularity: "ALL", accounts: ["urn:li:sponsoredAccount:123"] });
  });
  it("does not treat invalid local-currency spend as a measured amount", async () => {
    get.mockResolvedValue({ elements: [{ costInLocalCurrency: "invalid" }] });
    expect((await readLinkedInAdAnalytics("tenant", "123", opts))[0].missing_metrics).toContain("spend");
  });
  it.each([null, {}, { elements: null }])("refuses malformed responses rather than returning an empty success: %j", async (body) => {
    get.mockResolvedValue(body);
    await expect(readLinkedInAdAnalytics("tenant", "123", opts)).rejects.toThrow();
    await expect(listLinkedInAdAccounts("tenant")).rejects.toThrow();
    await expect(listLinkedInCampaigns("tenant", "123")).rejects.toThrow();
  });
  it("allows a genuinely empty response", async () => {
    get.mockResolvedValue({ elements: [] });
    expect(await readLinkedInAdAnalytics("tenant", "123", opts)).toEqual([]);
  });
});
describe("LinkedIn campaign and account paging", () => {
  const campaign = (id: number) => ({ id, name: `c${id}`, status: "ACTIVE" });
  it("follows nextPageToken so campaigns past the first 100 still reach the dashboard", async () => {
    get
      .mockResolvedValueOnce({ elements: Array.from({ length: 100 }, (_, i) => campaign(i)), metadata: { nextPageToken: "p2" } })
      .mockResolvedValueOnce({ elements: Array.from({ length: 40 }, (_, i) => campaign(100 + i)), metadata: {} });
    const rows = await listLinkedInCampaigns("tenant", "123", 200);
    expect(rows).toHaveLength(140);
    expect(rows.at(-1)!.id).toBe("139");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][2]).toMatchObject({ pageToken: "p2", q: "search" });
    expect(get.mock.calls[0][2]).not.toHaveProperty("pageToken");
  });
  it("stops at the caller's limit and never loops forever on a repeating token", async () => {
    get.mockResolvedValue({ elements: Array.from({ length: 100 }, (_, i) => campaign(i)), metadata: { nextPageToken: "same" } });
    expect(await listLinkedInCampaigns("tenant", "123", 250)).toHaveLength(250);
    expect(get).toHaveBeenCalledTimes(3);
    get.mockReset();
    get.mockResolvedValue({ elements: [campaign(1)], metadata: { nextPageToken: "again" } });
    await listLinkedInCampaigns("tenant", "123", 5000);
    expect(get.mock.calls.length).toBeLessThanOrEqual(10);
  });
  it("lists advertiser accounts past the first page", async () => {
    get
      .mockResolvedValueOnce({ elements: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `a${i}` })), metadata: { nextPageToken: "n" } })
      .mockResolvedValueOnce({ elements: [{ id: 100, name: "last", currency: "USD" }] });
    const accounts = await listLinkedInAdAccounts("tenant");
    expect(accounts).toHaveLength(101);
    expect(accounts.at(-1)).toMatchObject({ id: "100", currency: "USD" });
  });
});
