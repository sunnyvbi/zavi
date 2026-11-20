import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedComposioAccount } from "../composio/api";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("../composio/api", () => ({ composioProxy: proxy }));
vi.mock("../composio/account", () => ({ resolveOwnedComposioAccount: vi.fn() }));

import { campaignReport, listAdvertiserIds, listAdvertisers, listCampaigns } from "./composio-read";

const account = { tenant_id: "tenant", toolkit: "tiktok_ads", connected_account_id: "account", auth_config_id: "config" } as OwnedComposioAccount;
const respond = (json: unknown) => proxy.mockResolvedValue({ ok: true, status: 200, json });

beforeEach(() => { proxy.mockReset(); });

describe("TikTok report response validation", () => {
  it.each([
    null, [], {}, { code: null }, { code: "0" }, { code: "invalid" }, { code: 0.5 },
    { code: 0 }, { code: 0, data: null }, { code: 0, data: [] },
    { code: 0, data: {} }, { code: 0, data: { list: null } },
    { code: 0, data: { list: [null] } },
  ])("rejects a malformed successful transport: %j", async (json) => {
    respond(json);
    await expect(listAdvertiserIds(account)).rejects.toMatchObject({ code: "tiktok_ads_bad_response" });
    await expect(campaignReport(account, "123", "2026-09-01", "2026-09-30")).rejects.toMatchObject({ code: "tiktok_ads_bad_response" });
  });

  it("accepts an explicitly successful empty report", async () => {
    respond({ code: 0, data: { list: [] } });
    expect(await listAdvertiserIds(account)).toEqual([]);
    expect(await campaignReport(account, "123", "2026-09-01", "2026-09-30")).toEqual(new Map());
  });

  it.each([40100, 40133])("treats %i as a rate limit, not revoked access", async (code) => {
    respond({ code, message: "too frequent" });
    await expect(listCampaigns(account, "123")).rejects.toMatchObject({ code: "tiktok_ads_rate_limited" });
  });

  it.each([40102, 40105])("still requests reconnection for token code %i", async (code) => {
    respond({ code, message: "invalid token" });
    await expect(listCampaigns(account, "123")).rejects.toMatchObject({ code: "tiktok_ads_token_revoked" });
  });

  it("does not ask for reconnection on an invalid parameter", async () => {
    respond({ code: 40001, message: "invalid parameter" });
    await expect(listCampaigns(account, "123")).rejects.toMatchObject({ code: "tiktok_ads_error" });
  });

  it("propagates transport failures", async () => {
    proxy.mockResolvedValue({ ok: false, status: 503, json: {} });
    await expect(listAdvertiserIds(account)).rejects.toMatchObject({ code: "tiktok_ads_read_failed" });
  });
});

describe("listAdvertisers", () => {
  it("never borrows another advertiser's metadata when TikTok omits one", async () => {
    respond({ code: 0, data: { list: [{ advertiser_id: "2", name: "Two", currency: "INR" }] } });
    const rows = await listAdvertisers(account, ["1", "2"]);
    expect(rows[0]).toMatchObject({ advertiser_id: "1", name: "1", currency: null });
    expect(rows[1]).toMatchObject({ advertiser_id: "2", name: "Two", currency: "INR" });
  });
});

describe("complete campaign reporting", () => {
  it("rejects a full first page without metadata rather than guessing it is complete", async () => {
    respond({ code: 0, data: { list: Array.from({ length: 1000 }, (_, i) => ({ campaign_id: String(i) })) } });
    await expect(listCampaigns(account, "123")).rejects.toMatchObject({ code: "tiktok_ads_bad_response" });
  });
  it("retains the first page's count when a later page omits pagination metadata", async () => {
    proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      const page = new URL(endpoint, "https://example.test").searchParams.get("page");
      return { ok: true, status: 200, json: { code: 0, data: { list: [{ campaign_id: page }], ...(page === "1" ? { page_info: { total_page: 3 } } : {}) } } };
    });
    expect((await listCampaigns(account, "123")).map(c => c.campaign_id)).toEqual(["1", "2", "3"]);
  });
  it("reads subsequent campaign pages", async () => {
    proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      const page = new URL(endpoint, "https://example.test").searchParams.get("page") ?? "1";
      return { ok: true, status: 200, json: { code: 0, data: { list: [{ campaign_id: page, campaign_name: `Campaign ${page}`, operation_status: "ENABLE" }], page_info: { total_page: 2 } } } };
    });
    expect((await listCampaigns(account, "123")).map(c => c.campaign_id)).toEqual(["1", "2"]);
  });

  it("includes spend from subsequent report pages", async () => {
    proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      const page = new URL(endpoint, "https://example.test").searchParams.get("page") ?? "1";
      return { ok: true, status: 200, json: { code: 0, data: { list: [{ dimensions: { campaign_id: page }, metrics: { spend: "25", impressions: "100", clicks: "5", conversion: "0", total_complete_payment_rate: "0" } }], page_info: { total_page: 2 } } } };
    });
    const report = await campaignReport(account, "123", "2026-09-01", "2026-09-30");
    expect([...report.values()].reduce((sum, row) => sum + row.spend, 0)).toBe(50);
  });

  it.each([null, "", "not available", undefined])("does not report unknown spend %j as zero", async (spend) => {
    respond({ code: 0, data: { list: [{ dimensions: { campaign_id: "1" }, metrics: { spend, impressions: "100", clicks: "5", conversion: "0", total_complete_payment_rate: "0" } }] } });
    await expect(campaignReport(account, "123", "2026-09-01", "2026-09-30")).rejects.toMatchObject({ code: "tiktok_ads_bad_response" });
  });

  it("refuses a report beyond the page cap instead of returning partial totals", async () => {
    respond({ code: 0, data: { list: [], page_info: { total_page: 21 } } });
    await expect(campaignReport(account, "123", "2026-09-01", "2026-09-30")).rejects.toMatchObject({ code: "tiktok_ads_read_failed" });
    expect(proxy).toHaveBeenCalledTimes(1);
  });

  it("does not return first-page totals when a later page fails", async () => {
    proxy.mockResolvedValueOnce({ ok: true, status: 200, json: { code: 0, data: { list: [], page_info: { total_page: 2 } } } });
    proxy.mockResolvedValueOnce({ ok: false, status: 503, json: {} });
    await expect(campaignReport(account, "123", "2026-09-01", "2026-09-30")).rejects.toMatchObject({ code: "tiktok_ads_read_failed" });
  });
});
