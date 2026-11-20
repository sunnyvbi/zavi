vi.mock("@/services/ads-wallet/fx", () => ({
  adsFx: async (currency: string) => ({
    currency,
    units_per_usd: currency === "EUR" ? 0.8 : 1,
    as_of: "2026-10-13T00:00:00Z",
    source: "ExchangeRate-API",
  }),
}));
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  tree: {} as any,
  treeError: null as any,
  funding: null as any,
  wallet: vi.fn(),
  updateCampaign: vi.fn(),
  updateGroup: vi.fn(),
  updateAd: vi.fn(),
  readCampaign: vi.fn(),
  log: vi.fn(),
  calls: [] as string[],
}));
vi.mock("../workspace", () => ({
  readCampaignTree: async (_t: string, id: string) => {
    if (m.treeError) throw m.treeError;
    return { ...structuredClone(m.tree), _id: id };
  },
  readCampaign: m.readCampaign,
  updateCampaign: m.updateCampaign,
  updateGroupStatus: m.updateGroup,
  updateAdStatus: m.updateAd,
}));
vi.mock("@/services/channels/chatgpt-ads/wallet", () => ({
  readWallet: m.wallet,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: m.funding, error: null }),
      };
      return q;
    },
  }),
}));
import { ExpectedToolError } from "@/services/tools/types";
import { launchCampaign, launchSnapshot, launchTiming, readLaunchSummary } from "../launch";

let clock = 0;
beforeEach(() => {
  clock = Date.now();
  launchTiming.now = () => clock;
  launchTiming.sleep = async (ms: number) => { clock += ms; };
});

const action = "c1";
it("does not display non-USD customer budgets as dollars or request wallet funds", async () => {
  m.tree.binding = { funding_source: "provider" };
  m.tree.providerCurrency = "EUR";
  expect(await readLaunchSummary("t", action)).toMatchObject({
    currency: "EUR",
    fx: { units_per_usd: 0.8 },
    wallet: null,
  });
  expect(m.wallet).not.toHaveBeenCalled();
});
it("shows provider billing without requesting shared-wallet coverage", async () => {
  m.tree.binding = { funding_source: "provider" };
  m.tree.providerCurrency = "USD";
  m.tree.providerAccountId = "own";
  expect(await readLaunchSummary("t", action)).toMatchObject({
    wallet: null,
    shortfall_cents: 0,
    funding_source: "provider",
    provider_account_id: "own",
  });
  expect(m.wallet).not.toHaveBeenCalled();
});
it("shows daily-schedule coverage rather than a zero shortfall", async () => {
  const start = Math.floor(Date.now() / 1000);
  m.tree.campaign.budget = { daily_spend_limit_micros: 25_000_000 };
  m.tree.campaign.start_time = start;
  m.tree.campaign.end_time = start + 2 * 86400;
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(17_500);
});
it("checks coverage for an active parent with children still paused", async () => {
  m.tree.campaign.status = "active";
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(7_500);
});
it("retains the larger historical daily coverage", async () => {
  const start = Math.floor(Date.now() / 1000);
  m.tree.campaign.budget = { daily_spend_limit_micros: 25_000_000 };
  m.tree.campaign.start_time = start;
  m.tree.campaign.end_time = start + 86400;
  m.funding = {
    spent_cents: 0,
    reserved_cents: 0,
    daily_max_micros: 50_000_000,
    coverage_start: start,
    coverage_end: start + 2 * 86400,
  };
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(37_500);
});
it("does not hide a negative free balance behind this campaign's reservation", async () => {
  m.funding = { spent_cents: 0, reserved_cents: 10_000 };
  m.wallet.mockResolvedValue({
    currency: "USD",
    available_cents: -500,
    funding_enabled: true,
    in_app_enabled: true,
  });
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(500);
});
const go = () => ({
  expected_updated_at: 10,
  snapshot: launchSnapshot(m.tree),
});
beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.funding = null;
  m.treeError = null;
  m.tree = {
    campaign: {
      id: "c1",
      name: "zv-Launch test",
      status: "paused",
      updated_at: 10,
      bidding_type: "clicks",
      budget: { lifetime_spend_limit_micros: 100_000_000 },
      targeting: { locations: { countries: ["US"] } },
    },
    groups: [
      {
        id: "g1",
        name: "Buyer intent",
        status: "paused",
        bidding_config: { max_bid_micros: 2_000_000 },
      },
    ],
    ads: [
      {
        id: "a1",
        ad_group_id: "g1",
        name: "Card one",
        status: "paused",
        review_status: "approved",
        creative: {
          title: "A useful product",
          body: "Browse",
          target_url: "https://client.example",
        },
      },
      {
        id: "a2",
        ad_group_id: "g1",
        name: "Card two",
        status: "paused",
        review_status: "pending",
        creative: {
          title: "Choose a product",
          body: "Explore",
          target_url: "https://client.example",
        },
      },
    ],
  };
  m.updateCampaign.mockImplementation(async () => {
    m.calls.push("campaign");
    return {};
  });
  m.updateGroup.mockImplementation(
    async (_t: string, _c: string, g: string) => {
      m.calls.push(`group:${g}`);
      return {};
    },
  );
  m.updateAd.mockImplementation(
    async (_t: string, _c: string, _g: string, a: string) => {
      m.calls.push(`ad:${a}`);
      return {};
    },
  );
  m.readCampaign.mockResolvedValue({ updated_at: 11, status: "active" });
  m.wallet.mockResolvedValue({
    currency: "USD",
    available_cents: 2_500,
    funding_enabled: true,
    in_app_enabled: true,
  });
});

it("a campaign outside this workspace is not found, before any read of money or any write", async () => {
  m.treeError = new ExpectedToolError(
    "chatgpt_ads_not_found",
    "Campaign not found in this workspace.",
  );
  await expect(launchCampaign("t", "theirs", go())).rejects.toMatchObject({
    code: "chatgpt_ads_not_found",
  });
  await expect(readLaunchSummary("t", "theirs")).rejects.toMatchObject({
    code: "chatgpt_ads_not_found",
  });
  expect(m.updateCampaign).not.toHaveBeenCalled();
  expect(m.wallet).not.toHaveBeenCalled();
});
it("turns on the campaign, then its group, then its ads, with one confirm", async () => {
  const r = await launchCampaign("t", action, go());
  expect(r.ok).toBe(true);
  expect(m.calls).toEqual(["campaign", "group:g1", "ad:a1", "ad:a2"]);
  expect(m.updateCampaign).toHaveBeenCalledWith("t", "c1", {
    status: "active",
    expected_updated_at: 10,
  });
  expect(m.updateGroup).toHaveBeenCalledWith("t", "c1", "g1", "active", 11);
  expect(m.updateAd).toHaveBeenCalledWith("t", "c1", "g1", "a1", "active", 11);
});
it("refuses when the campaign changed after the founder read the summary", async () => {
  await expect(
    launchCampaign("t", action, { ...go(), expected_updated_at: 9 }),
  ).rejects.toThrow(/changed since you opened it/);
  expect(m.updateCampaign).not.toHaveBeenCalled();
});
it("refuses an archived campaign", async () => {
  m.tree.campaign.status = "archived";
  await expect(launchCampaign("t", action, go())).rejects.toThrow(/archived/);
});
it("skips what is already on and never activates anything twice (a re-run is safe)", async () => {
  m.tree.campaign.status = "active";
  m.tree.groups[0].status = "active";
  m.tree.ads[0].status = "active";
  const r = await launchCampaign("t", action, go());
  expect(m.calls).toEqual(["ad:a2"]);
  expect(r.items.map((i) => i.status)).toEqual([
    "already_active",
    "already_active",
    "already_active",
    "activated",
  ]);
  expect(m.updateAd).toHaveBeenCalledWith("t", "c1", "g1", "a2", "active", 10);
});
it("leaves an ad that failed the platform's review off", async () => {
  m.tree.ads[1].review_status = "rejected";
  const r = await launchCampaign("t", action, go());
  expect(m.calls).toEqual(["campaign", "group:g1", "ad:a1"]);
  expect(r.items.at(-1)).toMatchObject({ id: "a2", status: "skipped" });
});
it("a short balance stops before anything turns on, with the platform's reason", async () => {
  m.updateCampaign.mockRejectedValue(
    new ExpectedToolError("ads_balance_insufficient", "Add balance."),
  );
  const r = await launchCampaign("t", action, go());
  expect(r).toMatchObject({
    ok: false,
    code: "ads_balance_insufficient",
    message: "Add balance.",
  });
  expect(m.updateGroup).not.toHaveBeenCalled();
});
it("stops at the first failure, reports each item, and logs a partial launch as an error", async () => {
  m.updateAd
    .mockImplementationOnce(async () => {
      m.calls.push("ad:a1");
      return {};
    })
    .mockRejectedValueOnce(new Error("timeout"));
  const r = await launchCampaign("t", action, go());
  expect(r.ok).toBe(false);
  expect(r.items.map((i) => [i.id, i.status])).toEqual([
    ["c1", "activated"],
    ["g1", "activated"],
    ["a1", "activated"],
    ["a2", "failed"],
  ]);
  expect(r.message).toMatch(/Nothing ran twice/);
  expect(m.log).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "error",
      code: "chatgpt_ads.launch_partial",
    }),
  );
});
it("rejects a launch request without the confirmed version", async () => {
  await expect(launchCampaign("t", action, {})).rejects.toThrow();
  await expect(
    launchCampaign("t", action, { ...go(), campaign_id: "other" }),
  ).rejects.toThrow();
  expect(m.updateCampaign).not.toHaveBeenCalled();
});

it("summarises cap, bid, countries, ads and the balance still needed", async () => {
  m.funding = { reserved_cents: 0, spent_cents: 0 };
  const s = await readLaunchSummary("t", action);
  expect(s).toMatchObject({
    state: "ready",
    campaign: {
      id: "c1",
      lifetime_budget_micros: 100_000_000,
      countries: ["US"],
      updated_at: 10,
    },
    groups: [{ id: "g1", max_bid_micros: 2_000_000 }],
    wallet: { available_cents: 2_500 },
    shortfall_cents: 7_500,
  });
  expect(s.ads.map((a) => a.title)).toEqual([
    "A useful product",
    "Choose a product",
  ]);
});
it("keeps included places and exclusions in the launch review when the provider normalizes country targeting", async () => {
  const targeting = {
    locations: { include: [{ id: "geo-us", name: "United States" }] },
    excluded_locations: { countries: ["CA"], include: [{ id: "geo-city", name: "Austin" }] },
  };
  m.tree.campaign.targeting = targeting;
  const result = await readLaunchSummary("t", action);
  expect(result.campaign).toMatchObject({ countries: [], targeting });
  expect(result.snapshot).toBe(launchSnapshot(m.tree));
  expect(m.updateCampaign).not.toHaveBeenCalled();
  expect(m.updateGroup).not.toHaveBeenCalled();
  expect(m.updateAd).not.toHaveBeenCalled();
});
it("counts what this campaign already holds against the shortfall", async () => {
  m.funding = { reserved_cents: 10_000, spent_cents: 0 };
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(0);
});
it("an empty active campaign is not a launched ad", async () => {
  m.tree.campaign.status = "active";
  m.tree.groups = [];
  m.tree.ads = [];
  expect((await readLaunchSummary("t", action)).state).toBe("ready");
  await expect(launchCampaign("t", action, go())).rejects.toThrow(/no ads/);
  expect(m.updateCampaign).not.toHaveBeenCalled();
});
it("does not activate a parent when all its ads were rejected", async () => {
  m.tree.ads.forEach((a: any) => {
    a.review_status = "rejected";
  });
  await expect(launchCampaign("t", action, go())).rejects.toThrow(/no ads/);
  expect(m.updateCampaign).not.toHaveBeenCalled();
});
it("reads as launched once everything that can serve is on", async () => {
  m.tree.campaign.status = "active";
  m.tree.groups[0].status = "active";
  m.tree.ads[0].status = "active";
  m.tree.ads[1].review_status = "rejected";
  expect((await readLaunchSummary("t", action)).state).toBe("launched");
});
it("a past end time reads as ended even when everything is configured active (GS12)", async () => {
  m.tree.campaign.status = "active";
  m.tree.groups[0].status = "active";
  m.tree.ads[0].status = "active";
  m.tree.ads[1].status = "active";
  m.tree.campaign.end_time = Math.floor(Date.now() / 1000) - 3600;
  const s = await readLaunchSummary("t", action);
  expect(s.state).toBe("ended");
  expect(s.campaign.end_time).toBe(m.tree.campaign.end_time);
});
it("a past end time reads as ended for a paused campaign too, and launch refuses it", async () => {
  m.tree.campaign.end_time = Math.floor(Date.now() / 1000) - 60;
  expect((await readLaunchSummary("t", action)).state).toBe("ended");
  await expect(launchCampaign("t", action, go())).rejects.toThrow(
    /schedule already ended/,
  );
  expect(m.updateCampaign).not.toHaveBeenCalled();
});
it("a future end time does not mask launched, and a future start alone stays ready", async () => {
  m.tree.campaign.status = "active";
  m.tree.groups[0].status = "active";
  m.tree.ads[0].status = "active";
  m.tree.ads[1].status = "active";
  m.tree.campaign.end_time = Math.floor(Date.now() / 1000) + 86_400;
  expect((await readLaunchSummary("t", action)).state).toBe("launched");
  m.tree.campaign.status = "paused";
  m.tree.campaign.start_time = Math.floor(Date.now() / 1000) + 86_400;
  const s = await readLaunchSummary("t", action);
  expect(s.state).toBe("ready");
  expect(s.campaign.start_time).toBe(m.tree.campaign.start_time);
});
it("still shows the summary when the wallet cannot be read", async () => {
  m.wallet.mockRejectedValue(new Error("down"));
  expect(await readLaunchSummary("t", action)).toMatchObject({
    wallet: null,
    shortfall_cents: null,
    state: "ready",
  });
});

it("spend to date lowers what a relaunch needs (cap less spent less held)", async () => {
  m.funding = { reserved_cents: 8_000, spent_cents: 2_000 };
  m.wallet.mockResolvedValue({
    currency: "USD",
    available_cents: 0,
    funding_enabled: true,
    in_app_enabled: true,
  });
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(0);
  m.funding = { reserved_cents: 0, spent_cents: 3_000 };
  m.wallet.mockResolvedValue({
    currency: "USD",
    available_cents: 5_000,
    funding_enabled: true,
    in_app_enabled: true,
  });
  expect((await readLaunchSummary("t", action)).shortfall_cents).toBe(2_000);
});
it("the summary's fingerprint is what Launch checks", async () => {
  expect((await readLaunchSummary("t", action)).snapshot).toBe(
    launchSnapshot(m.tree),
  );
});
it.each([
  [
    "an ad's copy",
    (t: any) => {
      t.ads[0].creative.title = "Different words";
    },
  ],
  [
    "an ad's link",
    (t: any) => {
      t.ads[0].creative.target_url = "https://elsewhere.example";
    },
  ],
  [
    "an ad's image",
    (t: any) => {
      t.ads[0].creative.file_id = "file-new";
    },
  ],
  [
    "a group's bid",
    (t: any) => {
      t.groups[0].bidding_config.max_bid_micros = 10_000_000;
    },
  ],
  [
    "a new ad",
    (t: any) => {
      t.ads.push({ ...t.ads[0], id: "a3" });
    },
  ],
  [
    "the countries",
    (t: any) => {
      t.campaign.targeting.locations.countries = ["US", "GB"];
    },
  ],
  [
    "the conversion event",
    (t: any) => {
      t.campaign.conversion_event_setting_ids = ["new-event"];
    },
  ],
  [
    "the product feed",
    (t: any) => {
      t.campaign.product_feed_id = "new-feed";
    },
  ],
  [
    "campaign tracking",
    (t: any) => {
      t.campaign.landing_page_configuration = {
        query_string_template: "utm_campaign=changed",
      };
    },
  ],
  [
    "group tracking",
    (t: any) => {
      t.groups[0].landing_page_configuration = {
        query_string_template: "utm_campaign=changed",
      };
    },
  ],
  [
    "ad tracking",
    (t: any) => {
      t.ads[0].landing_page_configuration = {
        query_string_template: "utm_campaign=changed",
      };
    },
  ],
])(
  "refuses when %s changed after the founder read the summary (no campaign version change)",
  async (_what, change) => {
    const confirmed = go();
    change(m.tree);
    await expect(launchCampaign("t", action, confirmed)).rejects.toThrow(
      /changed since you opened it/,
    );
    expect(m.updateCampaign).not.toHaveBeenCalled();
  },
);
it("pending turning into approved does not block a launch", async () => {
  const confirmed = go();
  m.tree.ads[1].review_status = "approved";
  await expect(launchCampaign("t", action, confirmed)).resolves.toMatchObject({
    ok: true,
  });
});
it("an ad shown as staying off that the platform approves meanwhile needs a fresh confirm", async () => {
  m.tree.ads[1].review_status = "rejected";
  const confirmed = go();
  m.tree.ads[1].review_status = "approved";
  await expect(launchCampaign("t", action, confirmed)).rejects.toThrow(
    /changed since you opened it/,
  );
  expect(m.updateCampaign).not.toHaveBeenCalled();
});
it("keeps the receipt when the campaign turned on but could not be read back", async () => {
  m.readCampaign.mockRejectedValue(new Error("timeout"));
  const r = await launchCampaign("t", action, go());
  expect(r).toMatchObject({
    ok: false,
    message: expect.stringMatching(/campaign is on/),
  });
  expect(r.items).toEqual([
    { kind: "campaign", id: "c1", name: "zv-Launch test", status: "activated" },
  ]);
  expect(m.updateGroup).not.toHaveBeenCalled();
  expect(m.log).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "error",
      code: "chatgpt_ads.launch_partial",
    }),
  );
});
it("does not activate children when a readback still shows the parent paused", async () => {
  m.readCampaign.mockResolvedValue({ updated_at: 11, status: "paused" });
  expect(await launchCampaign("t", action, go())).toMatchObject({
    ok: false,
    code: "chatgpt_ads_bad_response",
  });
  expect(m.updateGroup).not.toHaveBeenCalled();
  expect(m.updateAd).not.toHaveBeenCalled();
});
