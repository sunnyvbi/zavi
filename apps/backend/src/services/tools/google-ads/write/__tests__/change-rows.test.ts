
import { describe, it, expect } from "vitest";
import { gadsChangeRows } from "../_change-rows";

const EVIDENCE = { decision_evidence: { reason_text: "x", stats: [{ value: "$1", caption: "c" }] } };

describe("gadsChangeRows", () => {
  it("budget: before/after are the body's expected-current and new daily budget", () => {
    const c = gadsChangeRows("google_ads.update_campaign_budget_review", {
      campaign_id: "111",
      daily_budget_usd: 250,
      expected_current_daily_budget_usd: 180,
      rationale: "hits cap 26 of 30 days",
      over_cap: true,
      name: "Emergency Plumbing",
      ...EVIDENCE,
    });
    expect(c).not.toBeNull();
    expect(c!.rows).toEqual([{ item: "“Emergency Plumbing” (campaign 111) daily budget", before: "$180/day", after: "$250/day" }]);
    expect(c!.title).toBe("Raise “Emergency Plumbing” (campaign 111) from $180 to $250 a day");
    expect(c!.change_sentence).toContain("from $180 to $250");
    expect(c!.campaign_id).toBe("111");
  });

  it("status: a pause row reads Enabled → Paused at the level in the body", () => {
    const c = gadsChangeRows("google_ads.set_status_review", {
      campaign_id: "111",
      level: "ad_group",
      ad_group_id: "222",
      status: "PAUSED",
      over_cap: false,
    });
    expect(c!.rows).toEqual([{ item: "Ad group 222", before: "Enabled", after: "Paused" }]);
    expect(c!.title).toBe("Pause ad group 222");
  });

  it("status: an enable row reads Paused → Enabled", () => {
    const c = gadsChangeRows("google_ads.set_status", { campaign_id: "111", status: "ENABLED", over_cap: false, name: "Brand" });
    expect(c!.rows).toEqual([{ item: "“Brand” (campaign 111)", before: "Paused", after: "Enabled" }]);
  });

  it("keywords: one row per keyword in the body, negatives read Blocked", () => {
    const keywords = [
      { text: "plumber jobs", match_type: "PHRASE" },
      { text: "diy drain", match_type: "BROAD" },
    ];
    const c = gadsChangeRows("google_ads.add_keywords", {
      level: "campaign",
      campaign_id: "111",
      negative: true,
      keywords,
      name: "Drain Cleaning",
    });
    expect(c!.rows).toEqual([
      { item: "plumber jobs (phrase)", before: "Your ads can show", after: "Your ads stop showing" },
      { item: "diy drain (broad)", before: "Your ads can show", after: "Your ads stop showing" },
    ]);
    expect(c!.rows).toHaveLength(keywords.length);
    expect(c!.title).toBe("Block 2 search terms in “Drain Cleaning”");
  });

  it("removal: says it cannot be undone", () => {
    const c = gadsChangeRows("google_ads.remove_resource", {
      level: "keyword",
      scope: "ad_group",
      parent_id: "222",
      criterion_id: "333",
    });
    expect(c!.rows).toEqual([{ item: "Keyword 333", before: "In your account", after: "Removed for good" }]);
    expect(c!.change_sentence).toMatch(/cannot be undone/);
  });

  it("an update never invents a before value", () => {
    const c = gadsChangeRows("google_ads.update_campaign", { campaign_id: "111", target_cpa_usd: 45 });
    expect(c!.rows).toEqual([{ item: "Target cost per conversion", before: "Current setting", after: "$45" }]);
  });

  it("unparseable bodies return null, so no card is shown", () => {
    expect(gadsChangeRows("google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: 250, over_cap: false })).toBeNull();
    expect(gadsChangeRows("google_ads.set_status", { campaign_id: "1", status: "REMOVED", over_cap: false })).toBeNull();
    expect(gadsChangeRows("google_ads.add_keywords", { level: "campaign", campaign_id: "1", negative: false, keywords: [{ text: "a", match_type: "EXACT" }] })).toBeNull();
    expect(gadsChangeRows("google_ads.set_status", null)).toBeNull();
    expect(gadsChangeRows("channel.recipe_step", { step: {} })).toBeNull();
    expect(gadsChangeRows("google_ads.unknown_class", {})).toBeNull();
  });
});

describe("gadsChangeRows: a Demand Gen video create states what it builds", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const SHA = "c".repeat(64);
  const body = {
    name: "YT launch",
    channel_type: "DEMAND_GEN",
    daily_budget_usd: 30,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
    demand_gen_ad_group: {
      name: "YT launch – video",
      ad: {
        final_urls: ["https://example.com"],
        youtube_video_ids: ["dQw4w9WgXcQ", "9bZkp7q19f0"],
        headlines: ["Book a car"],
        long_headlines: ["Book a car near you"],
        descriptions: ["Cars from local hosts"],
        business_name: "Upcar",
        logo: { storage_path: `${T}/logos/${SHA}.png`, sha256: SHA, mime: "image/png", width: 512, height: 512 },
      },
    },
    rationale: "r",
    ...EVIDENCE,
  };

  it("rows: type and surfaces, first ad group, the paused video ad and the logo", () => {
    const c = gadsChangeRows("google_ads.create_campaign", body)!;
    expect(c.rows).toEqual([
      { item: "Campaign", before: "None", after: "YT launch" },
      { item: "Daily budget", before: "None", after: "$30/day" },
      { item: "Bidding", before: "None", after: "Maximize conversions" },
      { item: "Status", before: "None", after: "Created paused" },
      { item: "Type", before: "None", after: "Demand Gen (YouTube, Discover, Gmail; not Display)" },
      { item: "First ad group", before: "None", after: "YT launch – video" },
      { item: "Video ad", before: "None", after: "2 videos, ready under the paused campaign" },
      { item: "Logo", before: "None", after: "square 512x512" },
    ]);
    expect(c.change_sentence).toBe("Zavi creates “YT launch” paused with a $30 daily budget. Nothing spends until one approved change turns the campaign on.");
    expect(c.title).toBe("Create the YouTube campaign “YT launch”");
  });

  it("never claims an approval rule it does not have", () => {
    const c = gadsChangeRows("google_ads.create_campaign", body)!;
    expect(JSON.stringify(c)).not.toMatch(/operator-approved|always/i);
  });

  it("a Demand Gen body without its group yields no card", () => {
    const { demand_gen_ad_group: _g, ...bare } = body;
    expect(gadsChangeRows("google_ads.create_campaign", bare)).toBeNull();
  });
});
