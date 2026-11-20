import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: vi.fn() }));
vi.mock("@/services/channels/exec-emit", () => ({ cgoChannelRailEmit: vi.fn(), resolveChannelExecEmit: vi.fn() }));
vi.mock("@/services/connectors/reddit-ads/composio-read", () => ({ redditCampaignsUrl: () => "https://ads.reddit.com" }));
vi.mock("@/services/connectors/reddit-ads/adapter", () => ({ ownedAccount: vi.fn(async () => { throw new Error("reddit down"); }), getObject: vi.fn() }));
describe("the card copy for an edit, a replacement and a switch-on says what changes and what does not", () => {
  it("names the destination, the targeting, the paused replacement and the budget hold", async () => {
    const { describeRedditAction } = await import("./_exec-action");
    const common = { ad_account_id: "account", name: "Spring test", rationale: "why" };
    const destination = describeRedditAction("reddit_ads.update_ad", { ...common, ad_id: "ad", expected_modified_at: "s", destination_url: "https://shop.example.com/new" });
    expect(destination.title).toContain("tracking link of the Reddit ad");
    expect(destination.sentence).toContain("same page as the ad's image post");
    expect(destination.rows).toEqual([{ item: expect.stringContaining("click link"), before: "not read", after: "https://shop.example.com/new" }]);
    const targeting = describeRedditAction("reddit_ads.update_targeting", { ...common, ad_group_id: "group", expected_modified_at: "s", targeting: { geolocations: ["US", "CA"], communities: ["travel"] } });
    expect(targeting.rows).toEqual(expect.arrayContaining([{ item: "Countries or regions", before: "not read", after: "US, CA" }, { item: "Communities", before: "not read", after: "travel" }, { item: "Excluded countries or regions", before: "not read", after: "none" }]));
    const replacement = describeRedditAction("reddit_ads.replace_creative", { ...common, ad_group_id: "group", profile_id: "profile", operation_key: "replacement_123", creative: { name: "Ad two", headline: "New words", destination_url: "https://shop.example.com", image_url: "https://cdn.example.com/a.jpg" } });
    expect(replacement.title).toContain("paused replacement ad");
    expect(replacement.sentence).toContain("existing ad is unchanged");
    expect(replacement.rows).toEqual(expect.arrayContaining([{ item: "Headline", before: "none", after: "New words" }, { item: "Status", before: "none", after: "Paused" }]));
    const resume = describeRedditAction("reddit_ads.set_object_status", { ...common, level: "ad_group", object_id: "group", status: "ACTIVE", expected_modified_at: "s" });
    expect(resume.title).toBe('Turn on the Reddit ad group "Spring test"');
    expect(resume.sentence).toContain("If a Zavi ad budget is active when this runs");
    expect(resume.sentence).toContain("with no ad budget, Zavi holds nothing");
    expect(resume.rows).toEqual([{ item: 'ad group "Spring test"', before: "not read", after: "Active" }]);
    const pause = describeRedditAction("reddit_ads.set_object_status", { ...common, level: "ad", object_id: "ad", status: "PAUSED", expected_modified_at: "s" });
    expect(pause.title).toBe('Pause the Reddit ad "Spring test"');
  });

  it("shows a creative's tracking click link only when it differs from the destination", async () => {
    const { describeRedditAction } = await import("./_exec-action");
    const common = { ad_account_id: "account", name: "Spring test", rationale: "why" };
    const creative = { name: "Ad two", headline: "New words", destination_url: "https://shop.example.com/cars", image_url: "https://cdn.example.com/a.jpg" };
    const replace = (c: Record<string, unknown>) => describeRedditAction("reddit_ads.replace_creative", { ...common, ad_group_id: "group", profile_id: "profile", operation_key: "replacement_123", creative: c }).rows;
    expect(replace({ ...creative, click_url: "https://shop.example.com/cars?utm_source=reddit" })).toContainEqual({ item: "Click link (tracking)", before: "none", after: "https://shop.example.com/cars?utm_source=reddit" });
    expect(replace(creative).map((r) => r.item)).not.toContain("Click link (tracking)");
    expect(replace({ ...creative, click_url: creative.destination_url }).map((r) => r.item)).not.toContain("Click link (tracking)");
    const plan = { ...common, profile_id: "profile", pixel_id: "pixel", operation_key: "operation_123", objective: "CLICKS", daily_budget_usd: 10, lifetime_cap_usd: 100, start_time: "2099-01-01T09:00:00-08:00", targeting: { geolocations: ["US"] } };
    const prepared = describeRedditAction("reddit_ads.prepare_campaign", { ...plan, creatives: [creative, { ...creative, name: "Ad three", click_url: "https://shop.example.com/cars?utm_campaign=spring" }] }).rows;
    expect(prepared).toContainEqual({ item: 'Ad 2 "Ad three" click link (tracking)', before: "none", after: "https://shop.example.com/cars?utm_campaign=spring" });
    expect(prepared.filter((r) => r.item.includes("click link"))).toHaveLength(1);
  });

  it("names the live object and shows its real before-values", async () => {
    const { describeRedditAction } = await import("./_exec-action");
    const common = { ad_account_id: "account", name: "Change the targeting for the test", rationale: "why" };
    const group = { id: "g1", name: "Spring group [prax:op_key_123:group]", configured_status: "ACTIVE", targeting: { geolocations: ["US"], communities: [], interests: [], locations: ["FEED"] } };
    const targeting = describeRedditAction("reddit_ads.update_targeting", { ...common, ad_group_id: "g1", expected_modified_at: "s", targeting: { geolocations: ["CA"] } }, group);
    expect(targeting.title).toBe('Change who sees the Reddit ad group "Spring group"');
    expect(targeting.rows).toEqual(expect.arrayContaining([{ item: "Countries or regions", before: "US", after: "CA" }, { item: "Communities", before: "all", after: "all" }]));
    const ad = describeRedditAction("reddit_ads.update_ad", { ...common, ad_id: "ad1", expected_modified_at: "s", destination_url: "https://shop.example.com/new" }, { id: "ad1", name: "Spring ad", click_url: "https://shop.example.com/old" });
    expect(ad.rows).toEqual([{ item: 'Ad "Spring ad" (ad1) click link', before: "https://shop.example.com/old", after: "https://shop.example.com/new" }]);
    const pause = describeRedditAction("reddit_ads.set_object_status", { ...common, level: "ad_group", object_id: "g1", status: "PAUSED", expected_modified_at: "s" }, { ...group, configured_status: "PAUSED" });
    expect(pause.rows).toEqual([{ item: 'ad group "Spring group" (g1)', before: "Paused", after: "Paused" }]);
  });

  it("says what a rename, an archive and a delete do, and that the last two are final", async () => {
    const { describeRedditAction } = await import("./_exec-action");
    const common = { ad_account_id: "account", name: "Rename it", rationale: "why" };
    const campaign = { id: "c1", name: "Old name [prax:op_key_123:campaign]", configured_status: "PAUSED" };
    const rename = describeRedditAction("reddit_ads.rename_object", { ...common, level: "campaign", object_id: "c1", expected_modified_at: "s", new_name: "Spring traffic" }, campaign);
    expect(rename.title).toBe('Rename the Reddit campaign "Old name" to "Spring traffic"');
    expect(rename.rows).toEqual([{ item: "campaign name (c1)", before: "Old name", after: "Spring traffic" }]);
    const archive = describeRedditAction("reddit_ads.remove_object", { ...common, level: "campaign", object_id: "c1", expected_modified_at: "s", mode: "archive" }, campaign);
    expect(archive.title).toBe('Archive the Reddit campaign "Old name"');
    expect(archive.sentence).toContain("cannot be undone");
    expect(archive.rows).toEqual([{ item: 'campaign "Old name" (c1)', before: "Paused", after: "Archived" }]);
    const remove = describeRedditAction("reddit_ads.remove_object", { ...common, level: "ad", object_id: "a1", expected_modified_at: "s", mode: "delete" });
    expect(remove.title).toBe('Delete the Reddit ad "Rename it"');
    expect(remove.rows).toEqual([{ item: 'ad "Rename it"', before: "not read", after: "Deleted" }]);
  });

  it("files no rename, archive or delete card when the object cannot be read from Reddit", async () => {
    const { resolveChannelExecEmit } = await import("@/services/channels/exec-emit");
    const { recordChannelExecAction } = await import("@/services/channels/exec-actions");
    vi.mocked(resolveChannelExecEmit).mockImplementation((async (_channels: unknown, _ctx: unknown, fn: unknown) => fn) as never);
    const { resolveRedditAdsEmit } = await import("./_exec-action");
    const emit = (await resolveRedditAdsEmit({ emit_decision: vi.fn() } as never)) as unknown as (action: unknown) => Promise<string>;
    const body = { ad_account_id: "account", name: "Old test", rationale: "why", level: "campaign", object_id: "c2", expected_modified_at: "s", mode: "delete" };
    await expect(emit({ tenant_id: "t1", run_id: "r1", channel_slug: "reddit_ads", decision_class: "reddit_ads.remove_object", body } as never)).rejects.toMatchObject({ code: "reddit_ads_object_unreadable" });
    await expect(emit({ tenant_id: "t1", run_id: "r1", channel_slug: "reddit_ads", decision_class: "reddit_ads.rename_object", body: { ad_account_id: "account", name: "Old test", rationale: "why", level: "campaign", object_id: "c2", expected_modified_at: "s", new_name: "New name" } } as never)).rejects.toMatchObject({ code: "reddit_ads_object_unreadable" });
    expect(recordChannelExecAction).not.toHaveBeenCalled();
    await expect(emit({ tenant_id: "t1", run_id: "r1", channel_slug: "reddit_ads", decision_class: "reddit_ads.remove_object", body } as never)).rejects.toThrow("in a minute");
  });

  it("names a permanent read refusal honestly instead of asking to try again", async () => {
    const { resolveChannelExecEmit } = await import("@/services/channels/exec-emit");
    const { ownedAccount, getObject } = await import("@/services/connectors/reddit-ads/adapter");
    const { ExpectedToolError } = await import("@/services/tools/types");
    vi.mocked(resolveChannelExecEmit).mockImplementation((async (_channels: unknown, _ctx: unknown, fn: unknown) => fn) as never);
    vi.mocked(ownedAccount).mockResolvedValue({ account: {}, details: {} } as never);
    const { resolveRedditAdsEmit } = await import("./_exec-action");
    const emit = (await resolveRedditAdsEmit({ emit_decision: vi.fn() } as never)) as unknown as (action: unknown) => Promise<string>;
    const body = { ad_account_id: "account", name: "Old test", rationale: "why", level: "campaign", object_id: "c2", expected_modified_at: "s", mode: "archive" };
    const run = () => emit({ tenant_id: "t1", run_id: "r1", channel_slug: "reddit_ads", decision_class: "reddit_ads.remove_object", body } as never);
    vi.mocked(getObject).mockRejectedValueOnce(new ExpectedToolError("reddit_ads_object_not_owned", "Reddit object does not belong to the selected ad account."));
    const notOwned = await run().catch((e: Error) => e.message);
    expect(notOwned).toContain("not in the selected Reddit ad account");
    expect(notOwned).not.toContain("in a minute");
    vi.mocked(getObject).mockRejectedValueOnce(new ExpectedToolError("reddit_ads_permission_denied", "403", { status: 403 }));
    expect(await run().catch((e: Error) => e.message)).toContain("refused Zavi permission");
    vi.mocked(getObject).mockRejectedValueOnce(new ExpectedToolError("reddit_ads_request_failed", "gone", { status: 404 }));
    expect(await run().catch((e: Error) => e.message)).toContain("no such object");
    vi.mocked(getObject).mockRejectedValueOnce(new ExpectedToolError("reddit_ads_rate_limited", "slow down", { status: 429 }));
    expect(await run().catch((e: Error) => e.message)).toContain("in a minute");
  });
});
