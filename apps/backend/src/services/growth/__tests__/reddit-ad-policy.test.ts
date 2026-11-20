import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ limits: null as unknown, runGoal: "11111111-1111-4111-8111-111111111111", goalStatus: "active", objects: new Map<string, Record<string, unknown>>() }));
vi.mock("@/services/connectors/reddit-ads/adapter", async (original) => ({ ...await original<typeof import("@/services/connectors/reddit-ads/adapter")>(), ownedAccount: async () => ({ account: { tenant_id: "tenant" }, details: { currency: "USD" } }), getObject: async (_a: unknown, _id: string, _level: string, id: string) => { const o = db.objects.get(id); if (!o) throw new Error(`Missing ${id}`); return o; } }));
vi.mock("@/services/connectors/reddit-ads/readiness-gates", () => ({ assertReady: async () => ({ account: { tenant_id: "tenant" } }) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({ from: (table: string) => {
  const query = { select: () => query, eq: () => query, limit: async () => ({ error: null, data: table === "reddit_ad_operations" ? [{ step: "group" }] : [] }), maybeSingle: async () => ({ error: null, data: table === "reddit_ad_authority" ? { limits: db.limits } : table === "agent_runs" ? { payload: { goal_id: db.runGoal } } : { id: "11111111-1111-4111-8111-111111111111", status: db.goalStatus } }) };
  return query;
} }) }));
import { assertRedditAuthority, evaluateRedditAd, loadRedditAdFacts, redditDirection } from "../reddit-ad-policy";
import type { UnattendedAction, UnattendedFacts } from "../unattended-policy";
const launch = { ad_account_id: "account", operation_key: "operation_123", name: "Traffic test", rationale: "Qualified visits" };
const prepare = { ...launch, profile_id: "profile", pixel_id: "pixel", objective: "CLICKS", daily_budget_usd: 10, lifetime_cap_usd: 100, start_time: "2099-01-01T09:00:00-08:00", targeting: { geolocations: ["US"] }, creatives: [{ name: "First image", headline: "Plan your next trip", image_url: "https://example.com/image.jpg", destination_url: "https://example.com/trips" }] };
const budget = { ad_account_id: "account", ad_group_id: "group", name: "Traffic test", rationale: "Qualified visits", expected_current_daily_budget_usd: 10, daily_budget_usd: 11 };
const action = (cls: string, payload: unknown): Extract<UnattendedAction, { kind: "ad" }> => ({ kind: "ad", exec_class: cls, payload, source: { table: "channel_actions", id: "action", run_id: "run" } });
const facts: UnattendedFacts = { channelAutorun: true, spendUpUnderBudget: true, openAdvice: "clear", refsResolved: true, goal: { present: true, numberTrusted: true }, reddit: { ready: true, managed: true, unchanged: true } };
beforeEach(() => { db.goalStatus = "active"; db.runGoal = "11111111-1111-4111-8111-111111111111"; db.limits = { ad_account_id: "account", name: "Approved limits", rationale: "Qualified traffic", goal_id: db.runGoal, expires_at: "2099-01-01T00:00:00Z", daily_limit_usd: 20, campaign_lifetime_limit_usd: 200, geolocations: ["US"], objectives: ["CLICKS"] }; });
describe("Reddit CGO policy", () => {
  it("permits a ready paused preparation and an unchanged launch under approved limits", () => {
    expect(evaluateRedditAd(action("reddit_ads.prepare_campaign", prepare), facts)).toEqual({ verdict: "allow", reasons: [] });
    expect(evaluateRedditAd(action("reddit_ads.launch_campaign", launch), facts)).toEqual({ verdict: "allow", reasons: [] });
  });
  it.each([
    ["channel disabled", { ...facts, channelAutorun: false }, "channel_asks_first"],
    ["Autopilot off", { ...facts, spendUpUnderBudget: false }, "no_ad_budget"],
    ["conflicting founder advice", { ...facts, openAdvice: "conflict" as const }, "open_advice_conflict"],
    ["untrusted goal number", { ...facts, goal: { present: true, numberTrusted: false } }, "goal_number_untrusted"],
    ["founder edit after preparation", { ...facts, reddit: { ...facts.reddit!, unchanged: false } }, "founder_paused_it"],
    ["an object Zavi did not prepare", { ...facts, reddit: { ...facts.reddit!, managed: false } }, "pause_owner_unknown"],
    ["unverified readiness", { ...facts, reddit: { ...facts.reddit!, ready: false } }, "reddit_readiness_unverified"],
  ])("holds a launch for the founder on %s", (_label, f, reason) => { expect(evaluateRedditAd(action("reddit_ads.launch_campaign", launch), f)).toMatchObject({ verdict: "ask_founder", reasons: expect.arrayContaining([reason]) }); });
  it("permits a paused replacement ad in a managed group and holds it for an unmanaged one", () => {
    const replacement = { ad_account_id: "account", ad_group_id: "group", profile_id: "profile", operation_key: "replacement_123", name: "Traffic test", rationale: "Creative test", creative: prepare.creatives[0] };
    expect(evaluateRedditAd(action("reddit_ads.replace_creative", replacement), facts)).toEqual({ verdict: "allow", reasons: [] });
    expect(evaluateRedditAd(action("reddit_ads.replace_creative", replacement), { ...facts, reddit: { ...facts.reddit!, managed: false } }).reasons).toContain("pause_owner_unknown");
    expect(redditDirection("reddit_ads.replace_creative", replacement)).toBe("create");
  });
  it("leaves edits of live objects and every resume to the founder", () => {
    const snapshot = { ad_account_id: "account", name: "Edit", rationale: "Founder asked", expected_modified_at: "snapshot" };
    expect(evaluateRedditAd(action("reddit_ads.update_ad", { ...snapshot, ad_id: "ad", destination_url: "https://example.com/new" }), facts)).toEqual({ verdict: "ask_founder", reasons: ["reddit_edit_needs_founder"] });
    expect(evaluateRedditAd(action("reddit_ads.update_targeting", { ...snapshot, ad_group_id: "group", targeting: { geolocations: ["US"] } }), facts)).toEqual({ verdict: "ask_founder", reasons: ["reddit_edit_needs_founder"] });
    const resume = { ...snapshot, level: "ad_group", object_id: "group", status: "ACTIVE" };
    expect(evaluateRedditAd(action("reddit_ads.set_object_status", resume), facts)).toEqual({ verdict: "ask_founder", reasons: ["reddit_resume_needs_founder"] });
    expect(redditDirection("reddit_ads.set_object_status", resume)).toBe("up");
    expect(redditDirection("reddit_ads.set_object_status", { ...resume, status: "PAUSED" })).toBe("down");
  });
  it("leaves founder-requested changes, budget changes, pauses and unknown classes to the founder", () => {
    expect(evaluateRedditAd(action("reddit_ads.launch_campaign", { ...launch, origin: "user_initiated_chat" }), facts).reasons).toContain("founder_staged_change");
    expect(evaluateRedditAd(action("reddit_ads.update_budget", budget), facts).reasons).toContain("reddit_budget_change_needs_founder");
    expect(evaluateRedditAd(action("reddit_ads.update_budget", { ...budget, daily_budget_usd: 9 }), facts).reasons).toContain("reddit_budget_change_needs_founder");
    expect(evaluateRedditAd(action("reddit_ads.set_object_status", { ad_account_id: "account", name: "Pause campaign", rationale: "Performance", level: "campaign", object_id: "campaign", status: "PAUSED", expected_modified_at: "snapshot" }), facts).reasons).toContain("pause_needs_founder");
    expect(evaluateRedditAd(action("reddit_ads.authorize_account", {}), facts).verdict).toBe("deny");
    expect(evaluateRedditAd(action("reddit_ads.arbitrary_proxy", {}), facts).verdict).toBe("ask_founder");
  });
});
describe("founder-approved Reddit operating limits", () => {
  it("accepts the approved goal and rejects daily, lifetime, geography and objective escalation", async () => {
    await expect(assertRedditAuthority("tenant", "account", { daily_budget_usd: 10, lifetime_cap_usd: 100, objective: "CLICKS", targeting: { geolocations: ["US"] } })).resolves.toMatchObject({ daily_limit_usd: 20 });
    await expect(assertRedditAuthority("tenant", "account", { daily_budget_usd: 21 })).rejects.toThrow("Daily budget");
    await expect(assertRedditAuthority("tenant", "account", { lifetime_cap_usd: 201 })).rejects.toThrow("Campaign cap");
    await expect(assertRedditAuthority("tenant", "account", { targeting: { geolocations: ["IN"] } })).rejects.toThrow("Geographic targeting");
    await expect(assertRedditAuthority("tenant", "account", { objective: "CONVERSIONS" })).rejects.toThrow("Campaign objective");
  });
  it("refuses an ended approved goal", async () => {
    db.goalStatus = "completed";
    await expect(assertRedditAuthority("tenant", "account", {})).rejects.toThrow("no longer active");
  });
  it("refuses a specialist run for a different business goal", async () => {
    db.runGoal = "22222222-2222-4222-8222-222222222222";
    await expect(loadRedditAdFacts("tenant", action("reddit_ads.prepare_campaign", prepare))).rejects.toThrow("outside the founder-approved Reddit goal");
  });
  it("refuses a run without a bound goal", async () => {
    await expect(loadRedditAdFacts("tenant", { ...action("reddit_ads.prepare_campaign", prepare), source: { table: "channel_actions", id: "action", run_id: null } })).rejects.toThrow("run bound");
  });
  it("reads the live campaign and ad group before a CGO replacement and refuses when any limit input is unreadable", async () => {
    const replacement = { ad_account_id: "account", ad_group_id: "group", profile_id: "profile", operation_key: "replacement_123", name: "Second image", rationale: "Fresh creative", creative: prepare.creatives[0] };
    const group = { id: "group", campaign_id: "campaign", targeting: { geolocations: ["US"] }, goal_type: "DAILY_SPEND", goal_value: 10000000, conversion_pixel_id: "pixel" };
    const campaign = { id: "campaign", objective: "CLICKS", spend_cap: 100000000 };
    const facts = async (g: Record<string, unknown>, c: Record<string, unknown>) => { db.objects.set("group", g); db.objects.set("campaign", c); return loadRedditAdFacts("tenant", action("reddit_ads.replace_creative", replacement)); };
    await expect(facts(group, campaign)).resolves.toEqual({ ready: true, managed: true, unchanged: true });
    await expect(facts(group, { ...campaign, objective: undefined })).rejects.toThrow("objective could not be read");
    await expect(facts({ ...group, targeting: {} }, campaign)).rejects.toThrow("targeting could not be read");
    await expect(facts({ ...group, goal_type: "LIFETIME_SPEND" }, campaign)).rejects.toThrow("daily budget could not be read");
    await expect(facts(group, { ...campaign, spend_cap: null })).rejects.toThrow("lifetime cap could not be read");
    await expect(facts({ ...group, targeting: { geolocations: ["IN"] } }, campaign)).rejects.toThrow("Geographic targeting");
    await expect(facts(group, { ...campaign, objective: "CONVERSIONS" })).rejects.toThrow("Campaign objective");
  });
  it("never treats a budget change or pause as CGO-ready", async () => {
    expect(await loadRedditAdFacts("tenant", action("reddit_ads.update_budget", budget))).toEqual({ ready: false, managed: false, unchanged: false });
  });
});
