
import { describe, it, expect } from "vitest";
import {
  adShape,
  adDirection,
  bodyRaisesObject,
  normEvent,
  withConversionFiring,
  evaluateUnattended,
  isExecutableAdClass,
  NO_CONVERSION_FLOOR_USD,
  type AdObjectFacts,
  type UnattendedAction,
  type UnattendedFacts,
} from "../unattended-policy";

const src = { table: "channel_actions" as const, id: "act-1", run_id: "run-1" };
const ad = (exec_class: string, payload: unknown): UnattendedAction => ({ kind: "ad", exec_class, payload, source: src });

const metaBudget = (to: number, from: number) => ({ ad_set_id: "123456789012345", daily_budget_usd: to, expected_current_daily_budget_usd: from, over_cap: false, rationale: "" });
const googleBudget = (to: number, from: number) => ({ campaign_id: "1234567890", daily_budget_usd: to, expected_current_daily_budget_usd: from, over_cap: false, rationale: "" });
const metaStatus = (status: "ACTIVE" | "PAUSED", level: "adset" | "campaign" = "adset") => ({ object_id: "123456789012345", level, status, over_cap: false, rationale: "" });
const googleStatus = (status: "ENABLED" | "PAUSED") => ({ campaign_id: "1234567890", level: "campaign", status, over_cap: false, rationale: "" });

function obj(over: Partial<AdObjectFacts> = {}): AdObjectFacts {
  return {
    id: "123456789012345",
    conversionObjective: true,
    objective: "OFFSITE_CONVERSIONS",
    learning: false,
    daysSinceEdit: 30,
    lockDays: 7,
    spend7dUsd: 400,
    conversions7d: 5,
    targetCpaUsd: null,
    conversionEvent: "PURCHASE",
    conversionEventFiring: true,
    ...over,
  };
}

function ok(over: Partial<UnattendedFacts> = {}): UnattendedFacts {
  return {
    refsResolved: true,
    openAdvice: "clear",
    goal: { present: true, numberTrusted: true },
    objects: [obj()],
    trackingOk: true,
    pausedByFounder: false,
    channelAutorun: true,
    ...over,
  };
}

const searchCampaign = { name: "Brand", channel_type: "SEARCH", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPC" } };

describe("ask first: the founder's per-channel switch holds Meta/Google spend-ups and creates", () => {
  const raise = ad("meta_ads.update_ad_set_budget", metaBudget(44, 40));
  it("a raise on a channel set to ask first goes to the founder", () => {
    const v = evaluateUnattended(raise, ok({ spendUpUnderBudget: true, channelAutorun: false }));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("channel_asks_first");
  });
  it("an unreadable switch is the founder's call", () => {
    const v = evaluateUnattended(raise, ok({ spendUpUnderBudget: true, channelAutorun: null }));
    expect(v.reasons).toContain("autorun_unreadable");
  });
  it("a cut is still cgo's to make on an ask-first channel", () => {
    const cut = ad("meta_ads.update_ad_set_budget", metaBudget(30, 40));
    expect(evaluateUnattended(cut, ok({ spendUpUnderBudget: true, channelAutorun: false })).reasons).not.toContain("channel_asks_first");
  });
});

describe("GS09: the CGO may approve a create only when its places are Meta keys", () => {
  it("a resolved city counts as a location; a name-only city does not", () => {
    expect(adShape("meta_ads.create_ad_set", { targeting: { geo_locations: { cities: [{ key: "2421836" }] } } })).toMatchObject({ missingLocation: false });
    expect(adShape("meta_ads.create_ad_set", { targeting: { geo_locations: { cities: [{ name: "Austin" }] } } })).toMatchObject({ missingLocation: true });
  });
});

describe("the allowlist", () => {
  const cases: Array<[string, string, unknown, "allow" | "ask_founder" | "deny", string?]> = [
    ["in-cap Meta budget raise", "meta_ads.update_ad_set_budget", metaBudget(60, 40), "allow"],
    ["in-cap Google budget raise", "google_ads.update_campaign_budget", googleBudget(60, 40), "allow"],
    ["$55 -> $110 via the review class (over the tenant cap)", "meta_ads.update_ad_set_budget_review", metaBudget(110, 55), "allow"],
    ["$55 -> $110 via the plain class (the controller's order)", "meta_ads.update_ad_set_budget", metaBudget(110, 55), "allow"],
    ["Google review-class raise within the step", "google_ads.update_campaign_budget_review", googleBudget(80, 40), "allow"],
    ["a raise past +100% (review class) is the founder's", "meta_ads.update_ad_set_budget_review", metaBudget(600, 40), "ask_founder", "raise_over_cgo_step"],
    ["a raise past +100% (plain class) is the founder's too", "google_ads.update_campaign_budget", googleBudget(600, 40), "ask_founder", "raise_over_cgo_step"],
    ["a raise from a zero budget is the founder's", "meta_ads.update_ad_set_budget", metaBudget(50, 0), "ask_founder", "raise_over_cgo_step"],
    ["exactly 2x in odd cents is within the step", "meta_ads.update_ad_set_budget_review", metaBudget(66.66, 33.33), "allow"],
    ["half a cent past 2x rounds past the bound and is the founder's", "meta_ads.update_ad_set_budget_review", metaBudget(80.005, 40), "ask_founder", "raise_over_cgo_step"],
    ["a budget edit the founder staged in the Ledger stays theirs", "meta_ads.update_ad_set_budget_review", { ...metaBudget(110, 55), origin: "user_initiated_ledger" }, "deny", "founder_staged_change"],
    ["a budget the founder typed in chat stays theirs", "google_ads.update_campaign_budget_review", { ...googleBudget(80, 40), origin: "user_initiated_chat" }, "deny", "founder_staged_change"],
    ["a cut via the review class keeps every rule (no step bound)", "meta_ads.update_ad_set_budget_review", metaBudget(10, 40), "allow"],
    ["Meta create", "meta_ads.create_ad_set", { campaign_id: "1234567890", targeting: { geo_locations: { countries: ["US"] } } }, "allow"],
    ["Google create campaign with a location", "google_ads.create_campaign", { ...searchCampaign, location_ids: [2840] }, "allow"],
    ["Google create campaign with no location (serves everywhere)", "google_ads.create_campaign", searchCampaign, "ask_founder", "no_location_target"],
    ["Google create campaign body that does not parse", "google_ads.create_campaign", { name: "Spring video" }, "ask_founder", "no_location_target"],
    ["Google create ad group", "google_ads.create_ad_group", { campaign_id: "1234567890" }, "allow"],
    ["Google create ad", "google_ads.create_ad", { ad_group_id: "1234567890" }, "allow"],
    ["Google add keywords", "google_ads.add_keywords", { campaign_id: "1234567890" }, "allow"],
    ["Meta resume via the review class (R4)", "meta_ads.set_status_review", metaStatus("ACTIVE"), "allow"],
    ["Google resume via the review class (R4)", "google_ads.set_status_review", googleStatus("ENABLED"), "allow"],
    ["Meta pause, auto class (R1)", "meta_ads.set_status", metaStatus("PAUSED"), "ask_founder", "pause_needs_founder"],
    ["Meta pause, review class (R1)", "meta_ads.set_status_review", metaStatus("PAUSED"), "ask_founder", "pause_needs_founder"],
    ["Google pause (R1)", "google_ads.set_status", googleStatus("PAUSED"), "ask_founder", "pause_needs_founder"],
    ["Google remove_resource (permanent delete)", "google_ads.remove_resource", { level: "campaign", campaign_id: "1234567890" }, "deny", "delete_never_unattended"],
    ["Google update_campaign (not on the list)", "google_ads.update_campaign", { campaign_id: "1234567890", target_cpa_usd: 5 }, "deny", "class_not_on_unattended_list"],
    ["Google update_ad_group (not on the list)", "google_ads.update_ad_group", { ad_group_id: "1234567890", cpc_bid_usd: 1 }, "deny", "class_not_on_unattended_list"],
    ["an unknown Meta class", "meta_ads.something_new", {}, "deny", "class_not_on_unattended_list"],
    ["a status body that does not parse", "meta_ads.set_status", { object_id: "1" }, "deny", "body_unreadable"],
    ["a budget body that does not parse", "google_ads.update_campaign_budget", {}, "deny", "body_unreadable"],
  ];
  it.each(cases)("%s -> %s", (_label, cls, payload, verdict, reason) => {
    const v = evaluateUnattended(ad(cls, payload), ok());
    expect(v.verdict).toBe(verdict);
    if (reason) expect(v.reasons).toContain(reason);
  });

  it("isExecutableAdClass is routing only: it matches classes the gate denies", () => {
    expect(isExecutableAdClass("google_ads.remove_resource")).toBe(true);
    expect(evaluateUnattended(ad("google_ads.remove_resource", {}), ok()).verdict).toBe("deny");
    expect(isExecutableAdClass("cgo.dispatch-specialist")).toBe(false);
  });

  it("reads budget direction from the dispatch schema", () => {
    expect(adShape("meta_ads.update_ad_set_budget", metaBudget(20, 40))).toMatchObject({ cls: "budget", direction: "down" });
    expect(adShape("google_ads.update_campaign_budget", googleBudget(80, 40))).toMatchObject({ cls: "budget", direction: "up" });
  });

  it("a Meta campaign budget (CBO) is a budget change on the campaign; a founder-staged one stays the founder's", () => {
    const body = { campaign_id: "120200", daily_budget_usd: 80, expected_current_daily_budget_usd: 50, over_cap: false, rationale: "" };
    expect(adShape("meta_ads.update_campaign_budget", body)).toMatchObject({ cls: "budget", platform: "meta", objectId: "120200", level: "campaign", direction: "up" });
    expect(adShape("meta_ads.update_ad_set_budget", metaBudget(80, 50))).toMatchObject({ level: "adset" });
    expect(adShape("meta_ads.update_campaign_budget_review", { ...body, origin: "user_initiated_ledger" })).toEqual({ cls: "never", why: "founder_staged_change" });
    expect(adShape("meta_ads.update_campaign_budget", metaBudget(80, 50))).toEqual({ cls: "never", why: "body_unreadable" });
  });

  it("Meta campaigns: a create is a create, a change is a setting, a delete is never cgo's", () => {
    const create = { name: "Leads Q4", objective: "OUTCOME_LEADS", special_ad_categories: [], rationale: "" };
    expect(adShape("meta_ads.create_campaign", create)).toEqual({ cls: "create", platform: "meta", missingLocation: false });
    expect(evaluateUnattended(ad("meta_ads.create_campaign", create), ok()).verdict).toBe("allow");

    const rename = { campaign_id: "120200000001", new_name: "New", rationale: "" };
    expect(adShape("meta_ads.update_campaign", rename)).toMatchObject({ cls: "settings", spendUp: false, asks: [] });
    expect(evaluateUnattended(ad("meta_ads.update_campaign", rename), ok({ objects: null })).verdict).toBe("allow");

    const uncap = { campaign_id: "120200000001", spend_cap_usd: null, expected_current_spend_cap_usd: 300, rationale: "" };
    expect(adShape("meta_ads.update_campaign", uncap)).toMatchObject({ spendUp: true });
    expect(adDirection("meta_ads.update_campaign", uncap)).toBe("up");
    const liBudget = { campaign_id: "22", account_id: "11", name: "Spring", kind: "daily", expected_current: { amount: "40.00", currency: "USD" }, proposed: { amount: "52.00", currency: "USD" }, rationale: "r" };
    expect(adDirection("linkedin_ads.resume_campaign", {})).toBe("up");
    expect(adDirection("linkedin_ads.update_campaign_budget", liBudget)).toBe("up");
    expect(adDirection("linkedin_ads.update_campaign_budget", { ...liBudget, proposed: { amount: "30.00", currency: "USD" } })).toBe("down");
    expect(adDirection("linkedin_ads.update_campaign_budget", { nope: true })).toBe("other");
    expect(adShape("meta_ads.update_campaign", { ...uncap, spend_cap_usd: 500, expected_current_spend_cap_usd: null })).toMatchObject({ spendUp: false });

    const legal = { campaign_id: "120200000001", special_ad_categories: ["HOUSING"], special_ad_category_country: ["US"], rationale: "" };
    const v = evaluateUnattended(ad("meta_ads.update_campaign", legal), ok());
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("special_ad_category_needs_founder");

    expect(adShape("meta_ads.update_campaign", { ...rename, origin: "user_initiated_chat" })).toEqual({ cls: "never", why: "founder_staged_change" });

    const del = evaluateUnattended(ad("meta_ads.delete_campaign", { campaign_id: "120200000001", rationale: "" }), ok());
    expect(del.verdict).toBe("deny");
    expect(del.reasons).toContain("delete_never_unattended");
  });

  it("Meta ad set / ad edits: a later end date or higher bid is spend up; an ad's on/off is the founder's", () => {
    const base = { ad_set_id: "238000000001", rationale: "" };
    const later = { ...base, end_time: "2026-12-31T00:00:00Z", expected_current_end_time: "2026-12-01T00:00:00Z" };
    expect(adShape("meta_ads.update_ad_set", later)).toMatchObject({ cls: "settings", objectId: "238000000001", spendUp: true });
    const earlier = { ...base, end_time: "2026-11-15T00:00:00Z", expected_current_end_time: "2026-12-01T00:00:00Z" };
    expect(adShape("meta_ads.update_ad_set", earlier)).toMatchObject({ spendUp: false });
    expect(adShape("meta_ads.update_ad_set", { ...base, bid_amount_usd: 3, expected_current_bid_amount_usd: 2 })).toMatchObject({ spendUp: true });
    const targeting = { ...base, targeting_patch: { age_min: 30 }, expected_targeting_fingerprint: "a".repeat(64) };
    expect(adShape("meta_ads.update_ad_set", targeting)).toMatchObject({ spendUp: true });
    expect(adShape("meta_ads.update_ad_set", { ...base, bid_strategy: "LOWEST_COST_WITHOUT_CAP", expected_current_bid_strategy: "COST_CAP" })).toMatchObject({ spendUp: true });
    expect(adDirection("meta_ads.update_campaign", { campaign_id: "120200000001", bid_strategy: "LOWEST_COST_WITHOUT_CAP", expected_current_bid_strategy: "COST_CAP", rationale: "" })).toBe("up");
    expect(evaluateUnattended(ad("meta_ads.update_ad_set", targeting), ok({ objects: null })).verdict).toBe("allow");

    const pause = evaluateUnattended(ad("meta_ads.update_ad", { ad_id: "238000000777", status: "PAUSED", rationale: "" }), ok());
    expect(pause.verdict).toBe("ask_founder");
    expect(pause.reasons).toContain("ad_status_needs_founder");
    const swap = { ad_id: "238000000777", creative_id: "222222", expected_current_creative_id: "111111", rationale: "" };
    expect(evaluateUnattended(ad("meta_ads.update_ad", swap), ok()).verdict).toBe("allow");

    expect(adShape("meta_ads.duplicate_ad", { source_ad_id: "238000000777", ad_set_id: "238000000001", rationale: "" })).toMatchObject({ cls: "create" });
  });

  it("Meta creatives and uploads spend nothing: creates, and a rename is a setting", () => {
    const creative = { name: "Autumn", primary_text: "x", headline: "y", link_url: "https://example.com", image_url: "https://example.com/a.png", rationale: "" };
    expect(evaluateUnattended(ad("meta_ads.create_creative", creative), ok()).verdict).toBe("allow");
    expect(evaluateUnattended(ad("meta_ads.upload_asset", { kind: "image", url: "https://example.com/a.png", name: "Hero", rationale: "" }), ok()).verdict).toBe("allow");
    expect(adShape("meta_ads.update_creative", { creative_id: "777000", new_name: "v2", rationale: "" })).toMatchObject({ cls: "settings", spendUp: false, asks: [] });
  });

  it("GS05 spacing sees a Meta campaign raise on the campaign it names", () => {
    const body = { campaign_id: "120200", daily_budget_usd: 80, expected_current_daily_budget_usd: 50 };
    expect(bodyRaisesObject(body, "meta", "120200")).toBe(true);
    expect(bodyRaisesObject(body, "meta", "999")).toBe(false);
    expect(bodyRaisesObject({ ...body, daily_budget_usd: 40 }, "meta", "120200")).toBe(false);
  });
});

describe("GS05 spacing: one Zavi raise per object per 24 hours", () => {
  const raise = ad("meta_ads.update_ad_set_budget_review", metaBudget(200, 100));
  it("a second raise within 24 hours of Zavi's last one goes to the founder, even under the budget", () => {
    const v = evaluateUnattended(raise, ok({ zaviRaisedRecently: true, spendUpUnderBudget: true }));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("raised_in_last_day");
  });
  it("no raise in the last 24 hours: a raise within 2x is the CGO's", () => {
    expect(evaluateUnattended(raise, ok({ zaviRaisedRecently: false })).verdict).toBe("allow");
  });
  it("history that could not be read goes to the founder", () => {
    const v = evaluateUnattended(raise, ok({ zaviRaisedRecently: null, spendUpUnderBudget: true }));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("raise_history_unknown");
  });
  it("a cut is never held by it", () => {
    expect(evaluateUnattended(ad("meta_ads.update_ad_set_budget", metaBudget(40, 100)), ok({ zaviRaisedRecently: true })).verdict).toBe("allow");
  });
});

describe("the rules", () => {
  const cut = ad("meta_ads.update_ad_set_budget", metaBudget(10, 40));
  const raise = ad("meta_ads.update_ad_set_budget", metaBudget(60, 40));
  const resume = ad("meta_ads.set_status_review", metaStatus("ACTIVE"));
  const create = ad("meta_ads.create_ad_set", { campaign_id: "1234567890", targeting: { geo_locations: { countries: ["US"] } } });
  const launchBody = (special_ad_categories: string[]) => ({
    campaign: { name: "Spring signups", objective: "OUTCOME_LEADS", special_ad_categories, special_ad_category_country: special_ad_categories.length ? ["US"] : undefined, daily_budget_usd: 20, bid_strategy: "LOWEST_COST_WITHOUT_CAP" },
    ad_set: { optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["US"] } } },
    ad: { primary_text: "Try it", headline: "Spring", link_url: "https://example.com", image_url: "https://example.com/a.png", source: "zavi_generated" },
    currency: "USD",
  });

  it("a one-card launch with places is the CGO's under the create rules", () => {
    expect(evaluateUnattended(ad("meta_ads.launch_campaign", launchBody([])), ok()).verdict).toBe("allow");
  });
  it("a one-card launch that declares a special ad category is the founder's", () => {
    const v = evaluateUnattended(ad("meta_ads.launch_campaign", launchBody(["CREDIT"])), ok());
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("special_ad_category_needs_founder");
  });

  const cases: Array<[string, UnattendedAction, Partial<UnattendedFacts>, "allow" | "ask_founder" | "deny", string?]> = [
    ["(a) open card about the same object", raise, { openAdvice: "conflict" }, "ask_founder", "open_advice_conflict"],
    ["(a) open cards unreadable", raise, { openAdvice: "error" }, "ask_founder", "open_advice_unreadable"],
    ["(a) open-advice fact missing", create, { openAdvice: null }, "ask_founder", "open_advice_unreadable"],
    ["(a) the action's own object cannot be named", create, { refsResolved: false }, "ask_founder", "object_unresolved"],
    ["(a) a pause with an open card names both reasons", ad("meta_ads.set_status", metaStatus("PAUSED")), { openAdvice: "conflict" }, "ask_founder", "open_advice_conflict"],
    ["(b) awareness cut for zero conversions", cut, { objects: [obj({ conversionObjective: false, objective: "REACH", conversions7d: 0, spend7dUsd: 500 })] }, "ask_founder", "objective_metric_mismatch"],
    ["(b) awareness cut WITH conversions is not a no-conversions cut", cut, { objects: [obj({ conversionObjective: false, conversions7d: 3 })] }, "allow"],
    ["(b) unknown objective on a zero-conversion cut", cut, { objects: [obj({ conversionObjective: null, conversions7d: 0, spend7dUsd: 500 })] }, "ask_founder", "objective_unknown"],
    ["(c) Meta ad set in learning", raise, { objects: [obj({ learning: true })] }, "ask_founder", "learning_lock"],
    ["(c) Meta edited 3 days ago", raise, { objects: [obj({ daysSinceEdit: 3 })] }, "ask_founder", "learning_lock"],
    ["(c) Meta edited 7 days ago is out of the lock", raise, { objects: [obj({ daysSinceEdit: 7 })] }, "allow"],
    ["(c) Meta last edit unknown", raise, { objects: [obj({ daysSinceEdit: null })] }, "ask_founder", "learning_state_unknown"],
    ["(c) PMax edited 10 days ago", ad("google_ads.update_campaign_budget", googleBudget(60, 40)), { objects: [obj({ lockDays: 14, learning: null, daysSinceEdit: 10 })] }, "ask_founder", "learning_lock"],
    ["(c) PMax edited 14 days ago", ad("google_ads.update_campaign_budget", googleBudget(60, 40)), { objects: [obj({ lockDays: 14, learning: null, daysSinceEdit: 14 })] }, "allow"],
    ["(c) Google Search has no lock", ad("google_ads.update_campaign_budget", googleBudget(60, 40)), { objects: [obj({ lockDays: 0, learning: null, daysSinceEdit: null })] }, "allow"],
    ["(c) a resume in the lock", resume, { objects: [obj({ daysSinceEdit: 2 })] }, "ask_founder", "learning_lock"],
    ["(c) one ad set of a campaign in learning", ad("meta_ads.set_status_review", metaStatus("ACTIVE", "campaign")), { objects: [obj(), obj({ id: "2", learning: true })] }, "ask_founder", "learning_lock"],
    ["(c) platform facts unreadable", raise, { objects: null }, "ask_founder", "ad_facts_unreadable"],
    ["(d) zero conversions on $30 spend, no target: under $50", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 30 })] }, "ask_founder", "spend_below_floor"],
    ["(d) zero conversions on $60 spend, no target: judged", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 60 })] }, "allow"],
    [`(d) floor is ${NO_CONVERSION_FLOOR_USD} exactly`, cut, { objects: [obj({ conversions7d: 0, spend7dUsd: NO_CONVERSION_FLOOR_USD })] }, "allow"],
    ["(d) target CPA $40: $70 is under 2x", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 70, targetCpaUsd: 40 })] }, "ask_founder", "spend_below_floor"],
    ["(d) target CPA $40: $80 is 2x", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 80, targetCpaUsd: 40 })] }, "allow"],
    ["(d) performance unreadable on a cut", cut, { objects: [obj({ conversions7d: null })] }, "ask_founder", "performance_unreadable"],
    ["M1 halving a brand search campaign on 0 conversions", ad("google_ads.update_campaign_budget", googleBudget(25, 50)), { objects: [obj({ lockDays: 0, learning: null, daysSinceEdit: null, conversions7d: 0, spend7dUsd: 168, brand: true })] }, "ask_founder", "brand_campaign"],
    ["a brand cut WITH conversions is still the founder's", ad("google_ads.update_campaign_budget", googleBudget(25, 50)), { objects: [obj({ lockDays: 0, learning: null, daysSinceEdit: null, conversions7d: 12, brand: true })] }, "ask_founder", "brand_campaign"],
    ["a cut on sign-ups under a purchase goal", cut, { objects: [obj({ conversions7d: 30, spend7dUsd: 900, resultsMatchGoal: false })] }, "ask_founder", "results_not_goal"],
    ["a raise is never held by brand or goal match", raise, { objects: [obj({ brand: true, resultsMatchGoal: false })] }, "allow"],
    ["a cut on results that ARE the goal still passes", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 60, resultsMatchGoal: true, brand: false })] }, "allow"],
    ["codex F2: brand read failed, the cut is held", ad("google_ads.update_campaign_budget", googleBudget(25, 50)), { objects: [obj({ lockDays: 0, learning: null, daysSinceEdit: null, conversions7d: 0, spend7dUsd: 168, brand: null })] }, "ask_founder", "brand_unknown"],
    ["codex F3: purchase read failed under a purchase goal, the cut is held", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 500, resultsMatchGoal: null })] }, "ask_founder", "results_unverified"],
    ["no goal opinion (sign-up goal): a zero-conversion cut is judged as before", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 60, brand: false })] }, "allow"],
    ["(e) tracking broken on a raise", raise, { trackingOk: false }, "ask_founder", "tracking_broken"],
    ["(e) tracking unknown on a cut", cut, { trackingOk: null }, "ask_founder", "tracking_unknown"],
    ["(e) tracking is not needed for a create", create, { trackingOk: false }, "allow"],
    ["(e) zero-conversion cut while its event is not firing (pixel still 'healthy')", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 500, conversionEventFiring: false })] }, "ask_founder", "conversion_event_not_firing"],
    ["(e) zero-conversion cut with its event unverifiable", cut, { objects: [obj({ conversions7d: 0, spend7dUsd: 500, conversionEventFiring: null })] }, "ask_founder", "conversion_event_unverified"],
    ["(f) untrusted goal number behind a raise", raise, { goal: { present: true, numberTrusted: false } }, "ask_founder", "goal_number_untrusted"],
    ["(f) untrusted goal number behind a create", create, { goal: { present: true, numberTrusted: false } }, "ask_founder", "goal_number_untrusted"],
    ["(f) goal unreadable", create, { goal: null }, "ask_founder", "goal_unreadable"],
    ["(f) a channel's own run rests on no goal", create, { goal: { present: false } }, "allow"],
    ["R4 resume of cgo's own pause", resume, { pausedByFounder: false }, "allow"],
    ["R4 resume of the founder's pause", resume, { pausedByFounder: true }, "ask_founder", "founder_paused_it"],
    ["R4 resume, who paused it unknown (outside Zavi)", resume, { pausedByFounder: null }, "ask_founder", "pause_owner_unknown"],
    ["S7 a raise on a budget the founder set outside Zavi", raise, { founderSetBudget: true }, "ask_founder", "founder_set_budget"],
    ["S7 a cut, who set the budget unreadable", cut, { founderSetBudget: null }, "ask_founder", "budget_owner_unknown"],
    ["S7 a raise, no outside budget change", raise, { founderSetBudget: false }, "allow"],
  ];
  it.each(cases)("%s -> %s", (_label, action, over, verdict, reason) => {
    const v = evaluateUnattended(action, ok(over));
    expect(v.verdict).toBe(verdict);
    if (reason) expect(v.reasons).toContain(reason);
  });

  it("the healthy cases pass every rule", () => {
    for (const a of [cut, raise, resume, create]) expect(evaluateUnattended(a, ok()).verdict).toBe("allow");
  });

  it("no fact at all never allows a money action", () => {
    for (const a of [cut, raise, resume, create]) expect(evaluateUnattended(a, {}).verdict).not.toBe("allow");
  });
});

describe("non-money actions", () => {
  const cases: Array<[string, UnattendedAction, UnattendedFacts, "allow" | "ask_founder" | "deny", string?]> = [
    ["R6: silence past an announced 'I'll pause it' pauses a non-ad channel", { kind: "channel_pause", channel_slug: "reddit_organic", trigger: "question_expiry", defaultStated: true }, { paidChannel: false, founderActedSince: false }, "allow"],
    ["R6: the founder acted on the channel's cards since: not silence", { kind: "channel_pause", channel_slug: "reddit_organic", trigger: "question_expiry", defaultStated: true }, { paidChannel: false, founderActedSince: true }, "deny", "founder_not_silent"],
    ["R6: activity since unreadable: nothing paused", { kind: "channel_pause", channel_slug: "reddit_organic", trigger: "question_expiry", defaultStated: true }, { paidChannel: false, founderActedSince: null }, "deny", "silence_unverified"],
    ["(g) silence that was never announced pauses nothing", { kind: "channel_pause", channel_slug: "reddit_organic", trigger: "question_expiry" }, { paidChannel: false }, "deny", "never_pause_on_unannounced_silence"],
    ["(g)+R1 silence never pauses an ad channel", { kind: "channel_pause", channel_slug: "meta_ads", trigger: "question_expiry", defaultStated: true }, { paidChannel: true }, "deny", "never_pause_paid_on_silence"],
    ["(g) silence with the channel kind unknown pauses nothing", { kind: "channel_pause", channel_slug: "x", trigger: "question_expiry", defaultStated: true }, {}, "deny", "never_pause_paid_on_silence"],
    ["(h) a review pause of a tried organic channel with its own per-item numbers", { kind: "channel_pause", channel_slug: "reddit", trigger: "review" }, { channelNeverApproved: false, paidChannel: false, channelEvidence: "per_item" }, "allow"],
    ["(h) a tried organic channel with insufficient evidence", { kind: "channel_pause", channel_slug: "blog", trigger: "review" }, { channelNeverApproved: false, paidChannel: false, channelEvidence: "insufficient" }, "ask_founder", "insufficient_evidence"],
    ["(h) evidence unreadable", { kind: "channel_pause", channel_slug: "x_organic", trigger: "review" }, { channelNeverApproved: false, paidChannel: false, channelEvidence: "could not read" }, "ask_founder", "evidence_unreadable"],
    ["(h) no evidence carried at all", { kind: "channel_pause", channel_slug: "reddit", trigger: "review" }, { channelNeverApproved: false, paidChannel: false }, "ask_founder", "evidence_missing"],
    ["(h) a quiet founder is never grounds, even with numbers", { kind: "channel_pause", channel_slug: "reddit", trigger: "review" }, { channelNeverApproved: false, paidChannel: false, channelEvidence: "per_item", whyCitesFounder: true }, "deny", "founder_silence_not_grounds"],
    ["R2 dispatch: Autopilot state unreadable", { kind: "dispatch_specialist", target: "x_organic", intent: "draft posts" }, { targetAllowed: null }, "ask_founder", "target_unverified"],
    ["a review pause of a never-tried channel", { kind: "channel_pause", channel_slug: "reddit", trigger: "review" }, { channelNeverApproved: true, paidChannel: false }, "ask_founder", "channel_never_tried"],
    ["a review pause of a paid channel (R1)", { kind: "channel_pause", channel_slug: "meta_ads", trigger: "review" }, { channelNeverApproved: false, paidChannel: true }, "ask_founder", "paid_channel_pause_needs_founder"],
    ["a review pause with unknown history", { kind: "channel_pause", channel_slug: "reddit", trigger: "review" }, { paidChannel: false }, "ask_founder", "channel_history_unknown"],
    ["goal change that eases", { kind: "goal_change", trigger: "review" }, { goalChange: { eases: true, movesBar: false, numberTrusted: true } }, "ask_founder", "eases_goal"],
    ["goal change that moves the founder's target", { kind: "goal_change", trigger: "question_expiry" }, { goalChange: { eases: false, movesBar: true, numberTrusted: true } }, "ask_founder", "moves_founder_target"],
    ["goal rewording", { kind: "goal_change", trigger: "question_expiry" }, { goalChange: { eases: false, movesBar: false, numberTrusted: false } }, "allow"],
    ["goal facts missing", { kind: "goal_change", trigger: "review" }, {}, "ask_founder", "goal_facts_unreadable"],
    ["dispatch to an allowed target", { kind: "dispatch_specialist", target: "research", intent: "x" }, { targetAllowed: true }, "allow"],
    ["dispatch to a target cgo may not start", { kind: "dispatch_specialist", target: "engineer", intent: "x" }, { targetAllowed: false }, "deny", "target_not_allowed"],
    ["dispatch whose order names an open card's object", { kind: "dispatch_specialist", target: "meta_ads", intent: "pause X" }, { targetAllowed: true, openAdvice: "conflict" }, "ask_founder", "open_advice_conflict"],
    ["dispatch with open cards unreadable", { kind: "dispatch_specialist", target: "meta_ads", intent: "x" }, { targetAllowed: true, openAdvice: "error" }, "ask_founder", "open_advice_unreadable"],
  ];
  it.each(cases)("%s -> %s", (_label, action, facts, verdict, reason) => {
    const v = evaluateUnattended(action, facts);
    expect(v.verdict).toBe(verdict);
    if (reason) expect(v.reasons).toContain(reason);
  });
});

describe("which conversion event fired (codex P1)", () => {
  const o = (conversionEvent: string | null, conversionPixelId: string | null = "px1"): AdObjectFacts => ({ id: "1", conversionObjective: true, objective: null, learning: false, daysSinceEdit: 30, lockDays: 7, spend7dUsd: 100, conversions7d: 0, targetCpaUsd: null, conversionEvent, conversionPixelId });
  const px = (entries: Array<[string, string[]]>) => new Map(entries.map(([id, evs]) => [id, new Set(evs.map(normEvent))]));
  it("matches Meta's two spellings of an event", () => {
    expect(normEvent("COMPLETE_REGISTRATION")).toBe(normEvent("CompleteRegistration"));
    expect(normEvent("INITIATED_CHECKOUT")).toBe(normEvent("InitiateCheckout"));
  });
  it("a healthy pixel that never fired Purchase does not verify a Purchase ad set", () => {
    const fired = px([["px1", ["PageView", "Lead"]]]);
    const [a, b, c] = withConversionFiring([o("PURCHASE"), o("LEAD"), o(null)], "meta", { ok: true, firedEvents: fired });
    expect([a.conversionEventFiring, b.conversionEventFiring, c.conversionEventFiring]).toEqual([false, true, null]);
  });
  it("a Purchase fired on an UNRELATED pixel does not verify this ad set's pixel", () => {
    const fired = px([["px1", ["PageView"]], ["px2", ["Purchase"]]]);
    expect(withConversionFiring([o("PURCHASE", "px1")], "meta", { ok: true, firedEvents: fired })[0].conversionEventFiring).toBe(false);
  });
  it("no pixel id on the ad set, or its pixel missing from the read: unverified", () => {
    const fired = px([["px2", ["Purchase"]]]);
    expect(withConversionFiring([o("PURCHASE", null)], "meta", { ok: true, firedEvents: fired })[0].conversionEventFiring).toBeNull();
    expect(withConversionFiring([o("PURCHASE", "px1")], "meta", { ok: true, firedEvents: fired })[0].conversionEventFiring).toBeNull();
  });
  it("no event list: unverified", () => {
    expect(withConversionFiring([o("PURCHASE")], "meta", { ok: true, firedEvents: null })[0].conversionEventFiring).toBeNull();
  });
});

describe("S4 pure helpers", () => {
  it("whyCitesFounder: the founder's silence, not the audience's", async () => {
    const { whyCitesFounder } = await import("../unattended-policy");
    expect(whyCitesFounder("The founder has not opened anything in 9 days.")).toBe(true);
    expect(whyCitesFounder("The founder never approves X posts.")).toBe(true);
    expect(whyCitesFounder("You never approve these drafts.")).toBe(true);
    expect(whyCitesFounder("Five posts, under 40 impressions and 2 clicks each.")).toBe(false);
    expect(whyCitesFounder("Car owners ignore the posts; 21 cards, none acted on.")).toBe(false);
  });

  it("R1: a held pause carries its numbers to the founder, and the ask is never cut mid-sentence", async () => {
    const { heldChangeAsk } = await import("../unattended-policy");
    const a = heldChangeAsk('apply "Pause Awareness"', ["pause_needs_founder"], "Last 7 days: $140 spent, 0 conversions; not set up to optimise for conversions, so judged on its own objective.");
    expect(a).toBe('I did not apply "Pause Awareness" on my own: Pausing is your call. Last 7 days: $140 spent, 0 conversions; not set up to optimise for conversions, so judged on its own objective. The card is waiting for you.');
    const long = heldChangeAsk(`apply "${"x".repeat(120)}"`, ["pause_needs_founder", "open_advice_conflict"], "E".repeat(300));
    expect(long.endsWith("The card is waiting for you.")).toBe(true);
    expect(long).not.toContain("EEE");
    expect(heldChangeAsk('apply "Raise budget"', ["founder_paused_it"], null, false).endsWith("Should I apply it?")).toBe(true);
  });

  it("names where the held card really is, from its stored home (bug #11)", async () => {
    const { heldChangeAsk } = await import("../unattended-policy");
    const growth = heldChangeAsk('apply "Cut “Search B” from $20 to $10 a day"', ["results_not_goal"], null, true, { kind: "growth" });
    expect(growth.endsWith("The card is waiting for you under What needs you on the Your CGO page.")).toBe(true);
    expect(growth).not.toMatch(/Needs you tab/);
    expect(heldChangeAsk('apply "X"', [], null, true, { kind: "needs_you" }).endsWith("The card is waiting for you in the Needs you tab.")).toBe(true);
    expect(heldChangeAsk('apply "X"', [], null, true, { kind: "channel", slug: "google_ads" }).endsWith("The card is waiting for you on the Google Ads channel page.")).toBe(true);
  });

  it("a short ChatGPT wallet never tells the founder to approve: launch would refuse it", async () => {
    const { heldChangeAsk } = await import("../unattended-policy");
    const r = ["chatgpt_wallet_insufficient"];
    expect(heldChangeAsk('apply "Launch"', r, null, true).endsWith("Add balance first; approving before that will not launch it.")).toBe(true);
    expect(heldChangeAsk('apply "Launch"', r, null, false).endsWith("Add prepaid ChatGPT balance, or tell me a smaller experiment.")).toBe(true);
    for (const cardExists of [true, false]) {
      for (const reasons of [r, ["pause_needs_founder"], []]) expect(heldChangeAsk('apply "X"', reasons, null, cardExists)).not.toContain("Approve it if you agree");
    }
  });
});

describe("the first switch-on of Zavi's own paused launch (PLAN-cgo-deadline-pace, change 5)", () => {
  const locked = { objects: [{ ...obj(), learning: null, daysSinceEdit: 0, lockDays: 7 }] };

  it("skips the learning lock, with no readiness check (an empty ad set spends nothing)", () => {
    expect(evaluateUnattended(ad("meta_ads.set_status", metaStatus("ACTIVE")), ok({ ...locked, firstOwnEnable: true })).verdict).toBe("allow");
  });
  it("any other resume keeps the learning lock", () => {
    const v = evaluateUnattended(ad("meta_ads.set_status", metaStatus("ACTIVE")), ok({ ...locked }));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("learning_lock");
  });
  it("a founder's own pause still goes to the founder", () => {
    const v = evaluateUnattended(ad("meta_ads.set_status", metaStatus("ACTIVE")), ok({ ...locked, pausedByFounder: true }));
    expect(v.reasons).toContain("founder_paused_it");
  });
  it("a budget raise inside the lock is still held", () => {
    const v = evaluateUnattended(ad("meta_ads.update_ad_set_budget", metaBudget(60, 40)), ok({ ...locked, firstOwnEnable: true }));
    expect(v.reasons).toContain("learning_lock");
  });
});

describe("C4: learning_lock / tracking / goal number do not hold a spend-up under the budget", () => {
  const settling = [obj({ daysSinceEdit: 2 })];
  const createBody = { name: "Prospecting", daily_budget_usd: 50, targeting: { geo_locations: { countries: ["US"] } } };
  const UP: Array<[string, UnattendedAction, Partial<UnattendedFacts>, string[]]> = [
    ["a raise inside its learning lock", ad("meta_ads.update_ad_set_budget", metaBudget(80, 40)), { objects: settling }, ["learning_lock"]],
    ["a raise with tracking unknown", ad("meta_ads.update_ad_set_budget", metaBudget(80, 40)), { trackingOk: null }, ["tracking_unknown"]],
    ["a raise with tracking broken", ad("google_ads.update_campaign_budget", googleBudget(80, 40)), { trackingOk: false }, ["tracking_broken"]],
    ["a raise resting on an untrusted goal number", ad("meta_ads.update_ad_set_budget", metaBudget(80, 40)), { goal: { present: true, numberTrusted: false } }, ["goal_number_untrusted"]],
    ["a create resting on an untrusted goal number", ad("meta_ads.create_ad_set", createBody), { goal: { present: true, numberTrusted: null } }, ["goal_number_untrusted"]],
    ["switching on inside a learning lock", ad("meta_ads.set_status", metaStatus("ACTIVE")), { objects: settling }, ["learning_lock"]],
  ];
  for (const [name, action, over, notes] of UP) {
    it(`${name}: held without a budget, allowed with a note under one`, () => {
      expect(evaluateUnattended(action, ok(over)).verdict).toBe("ask_founder");
      expect(evaluateUnattended(action, ok({ ...over, spendUpUnderBudget: false })).verdict).toBe("ask_founder");
      expect(evaluateUnattended(action, ok({ ...over, spendUpUnderBudget: null })).verdict).toBe("ask_founder");
      const v = evaluateUnattended(action, ok({ ...over, spendUpUnderBudget: true }));
      expect(v.verdict).toBe("allow");
      expect(v.notes).toEqual(notes);
    });
  }

  it("a CUT keeps every rule, budget or not", () => {
    const cut = ad("meta_ads.update_ad_set_budget", metaBudget(20, 40));
    for (const over of [{ objects: [obj({ daysSinceEdit: 2 })] }, { trackingOk: null }, { goal: { present: true, numberTrusted: false } as const }]) {
      const v = evaluateUnattended(cut, ok({ ...over, spendUpUnderBudget: true }));
      expect(v.verdict).toBe("ask_founder");
      expect(v.notes).toBeUndefined();
    }
  });

  it("a PAUSE stays the founder's (R1), budget or not", () => {
    for (const a of [ad("meta_ads.set_status", metaStatus("PAUSED")), ad("google_ads.set_status", googleStatus("PAUSED"))]) {
      const v = evaluateUnattended(a, ok({ spendUpUnderBudget: true }));
      expect(v.verdict).toBe("ask_founder");
      expect(v.reasons).toContain("pause_needs_founder");
    }
  });

  it("a founder's pause is never undone, even under a budget", () => {
    const on = ad("meta_ads.set_status", metaStatus("ACTIVE"));
    const v = evaluateUnattended(on, ok({ pausedByFounder: true, spendUpUnderBudget: true }));
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("founder_paused_it");
    expect(evaluateUnattended(on, ok({ pausedByFounder: null, spendUpUnderBudget: true })).reasons).toContain("pause_owner_unknown");
  });

  it("every other hold still holds a spend-up: open advice, unreadable goal or facts, unknown learning state, no location, founder-set budget", () => {
    const raise = ad("meta_ads.update_ad_set_budget", metaBudget(80, 40));
    const still: Array<[Partial<UnattendedFacts>, string]> = [
      [{ openAdvice: "conflict" }, "open_advice_conflict"],
      [{ goal: null }, "goal_unreadable"],
      [{ objects: null }, "ad_facts_unreadable"],
      [{ objects: [obj({ daysSinceEdit: null })] }, "learning_state_unknown"],
      [{ founderSetBudget: true }, "founder_set_budget"],
    ];
    for (const [over, reason] of still) {
      const v = evaluateUnattended(raise, ok({ ...over, spendUpUnderBudget: true }));
      expect(v.verdict, reason).toBe("ask_founder");
      expect(v.reasons).toContain(reason);
    }
    const noLoc = ad("google_ads.create_campaign", { ...searchCampaign, location_ids: [] });
    expect(evaluateUnattended(noLoc, ok({ spendUpUnderBudget: true })).reasons).toContain("no_location_target");
  });

  it("a class off the allowlist is still denied", () => {
    expect(evaluateUnattended(ad("google_ads.remove_resource", {}), ok({ spendUpUnderBudget: true })).verdict).toBe("deny");
  });
});
