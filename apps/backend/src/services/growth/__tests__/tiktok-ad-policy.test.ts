import { describe, expect, it } from "vitest";
import { evaluateTiktokAd } from "../tiktok-ad-policy";
import { evaluateUnattended, isExecutableAdClass, adDirection, type UnattendedFacts } from "../unattended-policy";
import { CGO_MAX_RAISE_STEP } from "../cgo-spend-authority";
import { inflightOutcome, type LedgerRow } from "@/services/decisions/ad-hold-resolve";

const base = { advertiser_id: "111", advertiser_name: "Main", level: "ad_group", object_id: "201", campaign_id: "102", ad_group_id: "201", name: "Group", rationale: "r" };
const budget = (from: number, to: number, origin = "specialist") => ({ ...base, origin, expected_current_daily_budget_usd: from, expected_current_status: "ACTIVE", daily_budget_usd: to });
const status = (to: "ACTIVE" | "PAUSED") => ({ ...base, status: to, expected_current_status: to === "ACTIVE" ? "PAUSED" : "ACTIVE", daily_budget_usd: to === "ACTIVE" ? 30 : null });
const ad = (exec_class: string, payload: unknown) => ({ kind: "ad" as const, exec_class, payload, source: { table: "channel_actions" as const, id: "a1", run_id: "r1" } });

const ok: UnattendedFacts = {
  refsResolved: true,
  openAdvice: "clear",
  goal: { present: true, numberTrusted: true },
  spendUpUnderBudget: true,
  channelAutorun: true,
  trackingOk: null,
  pausedByFounder: false,
  founderSetBudget: false,
  zaviRaisedRecently: false,
  objects: [{ id: "201", conversionObjective: null, objective: null, learning: null, daysSinceEdit: null, lockDays: 0, spend7dUsd: 140, conversions7d: 3, targetCpaUsd: null }],
};

describe("cgo may launch on TikTok within its ad budget (Ravi 2026-10-14): the Meta/Google create rules", () => {
  const launch = {
    advertiser_id: "7689989546330849300",
    advertiser_name: "Main",
    campaign_type: "TRAFFIC",
    name: "Atlanta gig test",
    locations: [{ location_id: "6252001", country_code: "US", name: "United States" }],
    daily_budget_usd: 25,
    start_time: "2026-10-15T00:00:00.000Z",
    video: { video_id: "v1", source: "zavi", artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", width: 720, height: 1280, duration_s: 12 },
    identity: { identity_id: "8f5d4c18-e601-5496-b38f-566335ea3ec3", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "7695136887945789461", display_name: "brand" },
    ad_text: "Rent a car for gig work",
    call_to_action: "LEARN_MORE",
    landing_url: "https://upcar.ai/",
    hold_estimate_usd: 500,
    rationale: "r",
  };
  const create = ad("tiktok_ads.create_launch", launch);
  const createFacts: UnattendedFacts = { refsResolved: true, openAdvice: "clear", goal: { present: true, numberTrusted: true }, spendUpUnderBudget: true, channelAutorun: true, trackingOk: null };

  it("is executable, a create, and allowed under an active budget with the switch on (tracking is a note)", () => {
    expect(isExecutableAdClass("tiktok_ads.create_launch")).toBe(true);
    expect(adDirection("tiktok_ads.create_launch", launch)).toBe("create");
    expect(evaluateUnattended(create, createFacts)).toEqual({ verdict: "allow", reasons: [], notes: ["tracking_unknown"] });
  });

  it("asks the founder: no active budget, the channel set to ask first, open advice against it, an unreadable goal, an unreadable body", () => {
    expect(evaluateUnattended(create, { ...createFacts, spendUpUnderBudget: false })).toMatchObject({ verdict: "ask_founder", reasons: ["tracking_unknown"] });
    expect(evaluateUnattended(create, { ...createFacts, channelAutorun: false }).reasons).toContain("channel_asks_first");
    expect(evaluateUnattended(create, { ...createFacts, openAdvice: "conflict" }).reasons).toContain("open_advice_conflict");
    expect(evaluateUnattended(create, { ...createFacts, goal: null }).reasons).toContain("goal_unreadable");
    expect(evaluateUnattended(ad("tiktok_ads.create_launch", { name: "x" }), createFacts).verdict).toBe("deny");
  });

  it("a launch the founder started from a channel top-action button is never cgo's, whatever the facts", () => {
    const pressed = ad("tiktok_ads.create_launch", { ...launch, origin: "user_initiated_ledger" });
    expect(evaluateUnattended(pressed, createFacts)).toMatchObject({ verdict: "deny", reasons: ["founder_staged_change"] });
    expect(evaluateUnattended(ad("tiktok_ads.create_launch", { ...launch, origin: "specialist" }), createFacts).verdict).toBe("allow");
  });
});

describe("cgo on TikTok", () => {
  it("routes TikTok classes to the TikTok rules and calls them executable", () => {
    expect(isExecutableAdClass("tiktok_ads.update_budget")).toBe(true);
    expect(isExecutableAdClass("tiktok_ads.set_status")).toBe(true);
    expect(isExecutableAdClass("tiktok_ads.delete_campaign")).toBe(false);
    expect(adDirection("tiktok_ads.update_budget", budget(30, 36))).toBe("up");
    expect(adDirection("tiktok_ads.set_status", status("PAUSED"))).toBe("down");
    expect(evaluateUnattended(ad("tiktok_ads.update_budget", budget(30, 36)), ok)).toEqual({ verdict: "allow", reasons: [], notes: ["tracking_unknown"] });
  });

  it("a missing goal is reported, not thrown, whatever the switch says; an untrusted goal number still counts on an ask-first channel", () => {
    const r = ad("tiktok_ads.update_budget", budget(30, 33));
    expect(evaluateTiktokAd(r, { ...ok, goal: null }).reasons).toContain("goal_unreadable");
    const noBudget = evaluateTiktokAd(r, { ...ok, spendUpUnderBudget: false, channelAutorun: false, goal: { present: true, numberTrusted: false } });
    expect(noBudget.reasons).toEqual(expect.arrayContaining(["goal_number_untrusted", "channel_asks_first"]));
    expect(evaluateTiktokAd(r, { ...ok, channelAutorun: false }).reasons).toContain("channel_asks_first");
  });

  it("ask first: a raise on a TikTok channel set to ask first, or with an unreadable switch, goes to the founder", () => {
    const r = ad("tiktok_ads.update_budget", budget(30, 33));
    expect(evaluateTiktokAd(r, { ...ok, channelAutorun: false }).reasons).toContain("channel_asks_first");
    expect(evaluateTiktokAd(r, { ...ok, channelAutorun: null }).reasons).toContain("autorun_unreadable");
  });

  it("a raise within CGO_MAX_RAISE_STEP is allowed; past it the founder decides", () => {
    const within = 30 * (1 + CGO_MAX_RAISE_STEP);
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, within)), ok).verdict).toBe("allow");
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, within + 1)), ok)).toMatchObject({ verdict: "ask_founder", reasons: ["raise_over_cgo_step"] });
  });

  it("one raise a day, never over a budget the founder set; unreadable history asks", () => {
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, zaviRaisedRecently: true }).reasons).toContain("raised_in_last_day");
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, zaviRaisedRecently: null }).reasons).toContain("raise_history_unknown");
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, founderSetBudget: true }).reasons).toContain("founder_set_budget");
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, founderSetBudget: null }).reasons).toContain("budget_owner_unknown");
  });

  it("without an active budget, unknown tracking holds a raise (it is a note only under a budget)", () => {
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, spendUpUnderBudget: false })).toMatchObject({ verdict: "ask_founder", reasons: ["tracking_unknown"] });
  });

  it("a pause needs the founder; a cut needs the founder", () => {
    expect(evaluateTiktokAd(ad("tiktok_ads.set_status", status("PAUSED")), ok)).toEqual({ verdict: "ask_founder", reasons: ["pause_needs_founder"] });
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(60, 50)), ok)).toEqual({ verdict: "ask_founder", reasons: ["tracking_unknown"] });
  });

  it("a raise or resume without the object's own 7 days goes to the founder, even under a budget", () => {
    const perf = ok.objects![0];
    for (const card of [ad("tiktok_ads.update_budget", budget(30, 33)), ad("tiktok_ads.set_status", status("ACTIVE"))]) {
      expect(evaluateTiktokAd(card, { ...ok, objects: null })).toMatchObject({ verdict: "ask_founder", reasons: ["ad_facts_unreadable"] });
      expect(evaluateTiktokAd(card, { ...ok, objects: [] })).toMatchObject({ verdict: "ask_founder", reasons: ["ad_facts_unreadable"] });
      expect(evaluateTiktokAd(card, { ...ok, objects: [{ ...perf, spend7dUsd: null }] })).toMatchObject({ verdict: "ask_founder", reasons: ["performance_unreadable"] });
      expect(evaluateTiktokAd(card, { ...ok, objects: [{ ...perf, conversions7d: null }] })).toMatchObject({ verdict: "ask_founder", reasons: ["performance_unreadable"] });
    }
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, objects: [{ ...perf, spend7dUsd: 0, conversions7d: 0 }] }).verdict).toBe("allow");
  });

  it("a resume is cgo's unless the founder paused it (R4)", () => {
    expect(evaluateTiktokAd(ad("tiktok_ads.set_status", status("ACTIVE")), ok).verdict).toBe("allow");
    expect(evaluateTiktokAd(ad("tiktok_ads.set_status", status("ACTIVE")), { ...ok, pausedByFounder: true }).reasons).toContain("founder_paused_it");
    expect(evaluateTiktokAd(ad("tiktok_ads.set_status", status("ACTIVE")), { ...ok, pausedByFounder: null }).reasons).toContain("pause_owner_unknown");
  });

  it("a change the founder staged, or an unreadable body, is never cgo's", () => {
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33, "user_initiated_chat")), ok)).toEqual({ verdict: "deny", reasons: ["founder_staged_change"] });
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", { nope: 1 }), ok)).toEqual({ verdict: "deny", reasons: ["body_unreadable"] });
  });

  it("open advice on the same object holds it", () => {
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, openAdvice: "conflict" }).reasons).toContain("open_advice_conflict");
    expect(evaluateTiktokAd(ad("tiktok_ads.update_budget", budget(30, 33)), { ...ok, openAdvice: "error" }).reasons).toContain("open_advice_unreadable");
  });
});

describe("an in-flight TikTok hold is judged from the ledger (ad groups included)", () => {
  const NOW = new Date("2026-10-07T12:00:00Z");
  const hold = (op: string) => ({ id: "h", op, platform: "tiktok", object_id: "201", updated_at: "2026-10-07T10:00:00.000Z" });
  const row = (over: Partial<LedgerRow>): LedgerRow => ({ object_id: "201", campaign_id: "102", level: "ad_group", budget_kind: "daily", budget_usd: 30, campaign_budget_usd: null, status: "ACTIVE", as_of: "2026-10-07T11:30:00.000Z", ...over });
  const raiseCard = { exec_class: "tiktok_ads.update_budget", body: budget(30, 36) as Record<string, unknown> };
  const resumeCard = { exec_class: "tiktok_ads.set_status", body: status("ACTIVE") as Record<string, unknown> };

  it("an ad-group raise: landed at the target, not landed at the old budget, unknown otherwise", () => {
    expect(inflightOutcome(hold("raise"), raiseCard, [row({ budget_usd: 36 })], NOW)).toBe("landed");
    expect(inflightOutcome(hold("raise"), raiseCard, [row({ budget_usd: 30 })], NOW)).toBe("not_landed");
    expect(inflightOutcome(hold("raise"), raiseCard, [row({ budget_usd: 33 })], NOW)).toBeNull();
    expect(inflightOutcome(hold("raise"), raiseCard, [row({ budget_usd: 36, as_of: "2026-10-07T09:00:00.000Z" })], NOW)).toBeNull();
    expect(inflightOutcome(hold("raise"), raiseCard, [], NOW)).toBeNull();
  });
  it("an ad-group resume: on is landed, paused is not; CAMPAIGN_PAUSED (the ad group itself on, its campaign off) is landed", () => {
    expect(inflightOutcome(hold("resume"), resumeCard, [row({ status: "ACTIVE" })], NOW)).toBe("landed");
    expect(inflightOutcome(hold("resume"), resumeCard, [row({ status: "PAUSED" })], NOW)).toBe("not_landed");
    expect(inflightOutcome(hold("resume"), resumeCard, [row({ status: "CAMPAIGN_PAUSED" })], NOW)).toBe("landed");
  });
});
