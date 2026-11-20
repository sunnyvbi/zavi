import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), record: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async () => true, linkedinAccountStoppable: async () => true }));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async () => "tok",
  forceRefreshConnector: vi.fn(),
  markConnectorTokenRevoked: vi.fn(),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding, getAccountBinding: vi.fn() }));

import { linkedinAdsGet, resetLinkedInAdsReadCache, LINKEDIN_ADS_DAILY_LIMIT } from "@/services/connectors/linkedin-ads/http";
import { linkedinAdsProposePauseCampaignTool } from "../propose_pause_campaign";

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const dayLimit = () => ({
  ok: false,
  status: 429,
  headers: new Headers(),
  json: async () => ({ message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." }),
  text: async () => JSON.stringify({ message: "Resource level throttle APPLICATION DAY limit for calls to this resource is reached." }),
});
const campaign = { id: 22, name: "Spring", status: "ACTIVE", account: "urn:li:sponsoredAccount:11" };

beforeEach(() => {
  resetLinkedInAdsReadCache();
  m.fetch.mockReset();
  m.findBinding.mockReset().mockResolvedValue(null);
  m.record.mockReset().mockResolvedValue("card-1");
  vi.stubGlobal("fetch", m.fetch);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("files the pause card while LinkedIn's daily limit blocks every other read of that campaign", async () => {
  m.fetch.mockResolvedValueOnce(dayLimit()).mockImplementation(async () => ok(campaign));
  await expect(linkedinAdsGet("tok", "adAccounts/11/adCampaigns/22")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  await expect(linkedinAdsGet("tok", "adAccounts/11/adCampaigns/22")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(m.fetch).toHaveBeenCalledTimes(1);

  const out = await linkedinAdsProposePauseCampaignTool.execute(
    { tenant_id: "t1", log: () => {}, emit_decision: m.record } as never,
    { campaign_id: "22", account_id: "11", rationale: "$40 over 30 days, 0 conversions" },
  );

  expect(out).toMatchObject({ action_id: "card-1", status: "waiting_for_founder", campaign: { id: "22", name: "Spring" } });
  expect(String(m.fetch.mock.calls[1][0])).toContain("adAccounts/11/adCampaigns/22");
  expect(String(m.fetch.mock.calls[2][0])).toContain("adAnalytics");
  expect(m.fetch).toHaveBeenCalledTimes(3);
  expect(m.record).toHaveBeenCalledWith("linkedin_ads.set_status", expect.objectContaining({ campaign_id: "22", account_id: "11", status: "PAUSED", rationale: expect.stringContaining("could not re-read") }));
  await expect(linkedinAdsGet("tok", "adAccounts/11/adCampaigns/22")).rejects.toThrow(LINKEDIN_ADS_DAILY_LIMIT);
  expect(m.fetch).toHaveBeenCalledTimes(3);
});

it("reads LinkedIn live for the pause card instead of a cached ACTIVE status the founder already changed", async () => {
  m.fetch.mockResolvedValueOnce(ok(campaign)).mockResolvedValueOnce(ok({ ...campaign, status: "PAUSED" }));
  await linkedinAdsGet("tok", "adAccounts/11/adCampaigns/22");
  await expect(
    linkedinAdsProposePauseCampaignTool.execute(
      { tenant_id: "t1", log: () => {}, emit_decision: m.record } as never,
      { campaign_id: "22", account_id: "11", rationale: "$40 over 30 days, 0 conversions" },
    ),
  ).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_active" });
  expect(m.record).not.toHaveBeenCalled();
});
