import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/tenant-client", () => ({ globalClient: () => ({}) }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: vi.fn(async () => false), isChannelLockedStrict: vi.fn(async () => false) }));
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({ isGoogleAdsWriteEnabled: vi.fn(async () => false) }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: vi.fn(async () => false) }));

import { platformWriteEnabled } from "../exec-kill-switch";

afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

describe("LinkedIn Ads server write switch", () => {
  it("off: an approved pause still goes through on both rails, because it only stops spend", async () => {
    delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
    expect(await platformWriteEnabled("linkedin_ads.set_status")).toBe(true);
    process.env.LINKEDIN_ADS_WRITE_ENABLED = "0";
    expect(await platformWriteEnabled("linkedin_ads.set_status")).toBe(true);
  });

  it("off: every change that can start or raise spend is still refused", async () => {
    delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
    for (const cls of [
      "linkedin_ads.launch_campaign",
      "linkedin_ads.create_campaign_bundle",
      "linkedin_ads.create_campaign",
      "linkedin_ads.update_campaign",
      "linkedin_ads.update_campaign_budget",
      "linkedin_ads.resume_campaign",
      "linkedin_ads.update_targeting",
      "linkedin_ads.set_status_v2",
      "linkedin_ads",
    ]) {
      expect(await platformWriteEnabled(cls), cls).toBe(false);
    }
  });

  it("on: launch and pause both pass", async () => {
    process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
    expect(await platformWriteEnabled("linkedin_ads.launch_campaign")).toBe(true);
    expect(await platformWriteEnabled("linkedin_ads.set_status")).toBe(true);
  });

  it("the pause exemption is LinkedIn's alone: another platform's status change still answers to its own switch", async () => {
    expect(await platformWriteEnabled("meta_ads.set_status")).toBe(false);
    expect(await platformWriteEnabled("google_ads.set_status")).toBe(false);
  });
});
