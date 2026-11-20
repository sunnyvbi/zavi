import { describe, expect, it } from "vitest";
import { adDirection, evaluateUnattended, isExecutableAdClass, type UnattendedFacts } from "../unattended-policy";
import { reachesCgoAdDoor } from "@/services/channels/exec-actions";

const ids = { campaign_id: "22", account_id: "11" };
const org = "urn:li:organization:1";
const money = (amount: string, currency = "USD") => ({ amount, currency });
const bodies: Record<string, Record<string, unknown>> = {
  "linkedin_ads.resume_campaign": { ...ids, name: "Spring", rationale: "r", expected_status: "PAUSED", run_start_at: null, run_end_at: null, budget: { kind: "daily", amount: "40", currency: "USD" } },
  "linkedin_ads.update_campaign_budget": { ...ids, name: "Spring", kind: "daily", expected_current: money("40.00"), proposed: money("60.00"), rationale: "r" },
  "linkedin_ads.update_campaign": { ...ids, name: "Spring", rationale: "r", last_modified_at: null, changes: { unit_cost: { before: money("5.00"), after: money("6.00") } } },
  "linkedin_ads.update_campaign_group": { group_id: "33", account_id: "11", name: "G", rationale: "r", last_modified_at: null, changes: { run_end_at: { before: "2026-12-01T00:00:00.000Z", after: "2026-12-15T00:00:00.000Z" } } },
  "linkedin_ads.create_ad": { ...ids, campaign_name: "Spring", campaign_status: "ACTIVE", associated_entity: org, source: { kind: "post", post_urn: "urn:li:share:1" }, go_live: true, expected_ad_count: 1, rationale: "r" },
  "linkedin_ads.swap_ad": { ...ids, campaign_name: "Spring", associated_entity: org, old_creative_id: "44", old_ad_name: "Old", source: { kind: "post", post_urn: "urn:li:share:2" }, rationale: "r" },
  "linkedin_ads.create_campaign": { account_id: "11", group_id: "33", group_name: "G", expected_group_status: "ACTIVE", name: "New", daily_budget: money("20.00"), unit_cost: money("5.00"), geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: org, objective_type: null, post_urn: null, places: ["United States"], rationale: "r" },
  "linkedin_ads.duplicate": { target: "campaign", source_id: "22", account_id: "11", source_name: "Spring", new_name: "Spring (copy)", group_id: null, campaign_id: null, copy_ads: true, source_last_modified_at: null, rationale: "r" },
};
const ALLOWED = Object.keys(bodies);
const HELD = ["linkedin_ads.resume_campaign", "linkedin_ads.update_campaign_budget", "linkedin_ads.create_campaign", "linkedin_ads.duplicate"];
const NOT_HELD = ALLOWED.filter((c) => !HELD.includes(c));
const card = (exec_class: string, over: Record<string, unknown> = {}, origin: unknown = "agent") => ({
  kind: "ad" as const,
  exec_class,
  payload: { ...bodies[exec_class], ...(origin === null ? {} : { origin }), ...over },
  source: { table: "channel_actions" as const, id: "ca-1", run_id: "run-1" },
});
const ok = (): UnattendedFacts => ({
  refsResolved: true,
  openAdvice: "clear",
  goal: { present: true, numberTrusted: true },
  spendUpUnderBudget: true,
  channelAutorun: true,
  trackingOk: true,
  pausedByFounder: false,
  founderSetBudget: false,
  zaviRaisedRecently: false,
  linkedinAd: { available: true, wallet: false, accountInUse: true, liveTouchedSinceZavi: false, consent: true },
});
const withLi = (f: UnattendedFacts, li: Partial<NonNullable<UnattendedFacts["linkedinAd"]>>): UnattendedFacts => ({ ...f, linkedinAd: { ...f.linkedinAd!, ...li } });

describe("LinkedIn under Autopilot with an ad budget follows Meta: each newly allowed class is approved when every fact holds", () => {
  it("splits the classes into the four the executor holds and the four it cannot", () => {
    expect(NOT_HELD.sort()).toEqual(["linkedin_ads.create_ad", "linkedin_ads.swap_ad", "linkedin_ads.update_campaign", "linkedin_ads.update_campaign_group"]);
  });

  it.each(HELD)("%s is allowed, executable and reaches the cgo door", (cls) => {
    expect(evaluateUnattended(card(cls), ok())).toEqual({ verdict: "allow", reasons: [] });
    expect(isExecutableAdClass(cls)).toBe(true);
    expect(reachesCgoAdDoor(cls)).toBe(true);
  });

  it("tracking and an untrusted goal are notes, never holds, for a spend-up under the budget (C4 parity)", () => {
    const v = evaluateUnattended(card("linkedin_ads.update_campaign_budget"), { ...ok(), trackingOk: null, goal: { present: true, numberTrusted: false } });
    expect(v.verdict).toBe("allow");
    expect(v.notes).toEqual(expect.arrayContaining(["tracking_unknown", "goal_number_untrusted"]));
  });
});

describe("F2: a spend-up the executor cannot hold against the ad budget goes to the founder", () => {
  it.each(NOT_HELD)("%s raises spend with every other fact clean and still asks, for that reason alone", (cls) => {
    expect(evaluateUnattended(card(cls), ok())).toEqual({ verdict: "ask_founder", reasons: ["linkedin_change_not_held"] });
    expect(isExecutableAdClass(cls)).toBe(true);
    expect(reachesCgoAdDoor(cls)).toBe(true);
  });

  it.each([
    ["campaign_group", { target: "campaign_group", source_id: "33", source_name: "G", new_name: "G (copy)", group_id: null, campaign_id: null }],
    ["creative", { target: "creative", source_id: "44", source_name: "Old", new_name: "Old (copy)", group_id: null, campaign_id: "22" }],
  ])("a %s copy reserves nothing at execute, so it asks; only a campaign copy holds and runs", (_t, over) => {
    expect(evaluateUnattended(card("linkedin_ads.duplicate", over), ok())).toEqual({ verdict: "ask_founder", reasons: ["linkedin_change_not_held"] });
  });

  it("an edit that cannot raise spend is still approved: a group rename and a bid cut", () => {
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_group", { changes: { name: { before: "A", after: "B" } } }), ok())).toEqual({ verdict: "allow", reasons: [] });
    expect(evaluateUnattended(card("linkedin_ads.update_campaign", { changes: { unit_cost: { before: money("6.00"), after: money("5.00") } } }), ok())).toEqual({ verdict: "allow", reasons: [] });
  });
});

describe("F1: Autopilot needs the founder's paid permission on LinkedIn, as the wallet launch does", () => {
  it.each(ALLOWED)("%s asks when the permission is missing, revoked or unreadable", (cls) => {
    for (const consent of [false, null, undefined]) {
      const v = evaluateUnattended(card(cls), withLi(ok(), { consent }));
      expect([consent, v.verdict]).toEqual([consent, "ask_founder"]);
      expect(v.reasons).toContain("linkedin_paid_consent_required");
    }
  });

  it("a spend cut asks for the permission too, since Autopilot is still writing to LinkedIn", () => {
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { proposed: money("30.00") }), withLi(ok(), { consent: false })).reasons).toContain("linkedin_paid_consent_required");
  });
});

describe("every newly allowed class falls back to the founder", () => {
  it.each(ALLOWED)("(b) no ad budget: %s asks", (cls) => {
    const v = evaluateUnattended(card(cls), { ...ok(), spendUpUnderBudget: false });
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("no_ad_budget");
  });

  it.each(ALLOWED)("(b) the budget fact unreadable: %s asks", (cls) => {
    expect(evaluateUnattended(card(cls), { ...ok(), spendUpUnderBudget: null }).verdict).toBe("ask_founder");
  });

  it.each(ALLOWED)("(c) a founder's own chat order: %s is never approved", (cls) => {
    const v = evaluateUnattended(card(cls, {}, "user_initiated_chat"), ok());
    expect(v).toEqual({ verdict: "deny", reasons: ["founder_requested_change"] });
  });

  it.each(ALLOWED)("(c) a card with no origin (a dashboard card the founder filed): %s is never approved", (cls) => {
    expect(evaluateUnattended(card(cls, {}, null), ok())).toEqual({ verdict: "deny", reasons: ["founder_requested_change"] });
  });

  it.each(ALLOWED)("(e) every fact unreadable on its own: %s asks", (cls) => {
    const unreadable: Array<[string, UnattendedFacts]> = [
      ["available", withLi(ok(), { available: null })],
      ["wallet", withLi(ok(), { wallet: null })],
      ["accountInUse", withLi(ok(), { accountInUse: null })],
      ["openAdvice", { ...ok(), openAdvice: "error" }],
      ["goal", { ...ok(), goal: null }],
      ["autorun", { ...ok(), channelAutorun: null }],
      ["linkedinAd", { ...ok(), linkedinAd: undefined }],
    ];
    for (const [name, f] of unreadable) expect([name, evaluateUnattended(card(cls), f).verdict]).toEqual([name, "ask_founder"]);
  });

  it.each(ALLOWED)("(f) open advice on the same object: %s asks", (cls) => {
    const v = evaluateUnattended(card(cls), { ...ok(), openAdvice: "conflict" });
    expect(v.verdict).toBe("ask_founder");
    expect(v.reasons).toContain("open_advice_conflict");
  });

  it.each(ALLOWED)("(g) a campaign on Zavi's wallet billing: %s is denied, the wallet launch keeps its own path", (cls) => {
    expect(evaluateUnattended(card(cls), withLi(ok(), { wallet: true })).verdict).toBe("deny");
    expect(evaluateUnattended(card(cls), withLi(ok(), { wallet: true })).reasons).toContain("linkedin_wallet_campaign");
  });

  it.each(ALLOWED)("(g) an ad account this workspace does not manage (the wallet account included): %s is denied", (cls) => {
    expect(evaluateUnattended(card(cls), withLi(ok(), { accountInUse: false })).reasons).toContain("linkedin_account_not_in_use");
  });

  it.each(ALLOWED)("the channel set to ask first: %s asks", (cls) => {
    expect(evaluateUnattended(card(cls), { ...ok(), channelAutorun: false }).reasons).toContain("channel_asks_first");
  });

  it.each(ALLOWED)("LinkedIn Ads unavailable (tier, lock or write flag): %s asks", (cls) => {
    expect(evaluateUnattended(card(cls), withLi(ok(), { available: false })).reasons).toContain("channel_unavailable");
  });

  it.each(ALLOWED)("a cgo test whose end Zavi cannot verify: %s asks", (cls) => {
    expect(evaluateUnattended(card(cls), { ...ok(), testEnd: "unreadable" }).verdict).toBe("ask_founder");
  });
});

describe("(d) spend-up over the step or the budget, and the class-specific guardrails", () => {
  it("a daily raise past CGO_MAX_RAISE_STEP asks; exactly at the step is allowed", () => {
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { proposed: money("80.01") }), ok()).reasons).toContain("raise_over_cgo_step");
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { proposed: money("80.00") }), ok()).verdict).toBe("allow");
  });

  it("a raise from zero cannot be stepped and asks", () => {
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { expected_current: money("0.00"), proposed: money("10.00") }), ok()).reasons).toContain("raise_over_cgo_step");
  });

  it("a second raise within a day, an unreadable raise history, a founder-set budget and an unreadable budget owner each ask", () => {
    const raise = card("linkedin_ads.update_campaign_budget");
    expect(evaluateUnattended(raise, { ...ok(), zaviRaisedRecently: true }).reasons).toContain("raised_in_last_day");
    expect(evaluateUnattended(raise, { ...ok(), zaviRaisedRecently: null }).reasons).toContain("raise_history_unknown");
    expect(evaluateUnattended(raise, { ...ok(), founderSetBudget: true }).reasons.some((r) => r.startsWith("founder_set_budget"))).toBe(true);
    expect(evaluateUnattended(raise, { ...ok(), founderSetBudget: null }).reasons).toContain("budget_owner_unknown");
  });

  it("a total budget, a cut, and a non-USD account are the founder's", () => {
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { kind: "total" }), ok()).reasons).toContain("linkedin_total_budget_needs_founder");
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { proposed: money("30.00") }), ok()).verdict).toBe("ask_founder");
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_budget", { expected_current: money("40.00", "EUR"), proposed: money("60.00", "EUR") }), ok()).reasons).toContain("non_usd_account");
    expect(evaluateUnattended(card("linkedin_ads.create_campaign", { daily_budget: money("20.00", "EUR"), unit_cost: money("5.00", "EUR") }), ok()).reasons).toContain("non_usd_account");
  });

  it("a resume asks when the founder paused it, the pauser is unknown, LinkedIn shows an edit since, it has no daily budget, or it is not in USD", () => {
    const r = card("linkedin_ads.resume_campaign");
    expect(evaluateUnattended(r, { ...ok(), pausedByFounder: true }).reasons).toContain("founder_paused_it");
    expect(evaluateUnattended(r, { ...ok(), pausedByFounder: null }).reasons).toContain("pause_owner_unknown");
    expect(evaluateUnattended(r, withLi(ok(), { liveTouchedSinceZavi: true })).reasons).toContain("pause_owner_unknown");
    expect(evaluateUnattended(r, withLi(ok(), { liveTouchedSinceZavi: null })).reasons).toContain("pause_owner_unknown");
    expect(evaluateUnattended(card("linkedin_ads.resume_campaign", { budget: { kind: "total", amount: "900", currency: "USD" } }), ok()).reasons).toContain("linkedin_resume_needs_daily_budget");
    expect(evaluateUnattended(card("linkedin_ads.resume_campaign", { budget: null }), ok()).reasons).toContain("linkedin_resume_needs_daily_budget");
    expect(evaluateUnattended(card("linkedin_ads.resume_campaign", { budget: { kind: "daily", amount: "40", currency: "GBP" } }), ok()).reasons).toContain("non_usd_account");
  });

  it("a new campaign in an EU place asks, as the EU rule stays the founder's", () => {
    expect(evaluateUnattended(card("linkedin_ads.create_campaign", { places: ["Paris, Île-de-France, France"] }), ok()).reasons).toContain("eu_location_needs_founder");
  });

  it("a campaign edit that moves its locations asks for the location; one that only changes the audience asks only because it is not held", () => {
    const t = (before: string, after: string) => ({ changes: { targeting: { before_fingerprint: "f", after_criteria: {}, summary_before: before, summary_after: after } } });
    expect(evaluateUnattended(card("linkedin_ads.update_campaign", t("Locations: United States; Titles: CTO", "Locations: Canada; Titles: CTO")), ok()).reasons).toContain("location_change_needs_founder");
    expect(evaluateUnattended(card("linkedin_ads.update_campaign", t("Locations: United States; Titles: CTO", "Locations: United States; Titles: CEO")), ok()).reasons).toEqual(["linkedin_change_not_held"]);
  });

  it("switching a whole group on or off stays the founder's", () => {
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_group", { changes: { status: { before: "PAUSED", after: "ACTIVE" } } }), ok()).reasons).toContain("group_status_needs_founder");
    expect(evaluateUnattended(card("linkedin_ads.update_campaign_group", { changes: { status: { before: "ACTIVE", after: "PAUSED" } } }), ok()).reasons).toContain("group_status_needs_founder");
  });

  it.each([
    ["raised", { before: money("500.00"), after: money("700.00") }],
    ["cut", { before: money("700.00"), after: money("500.00") }],
    ["removed", { before: money("500.00"), after: null }],
    ["added", { before: null, after: money("500.00") }],
  ])("a campaign group's total budget %s is the founder's, never approved by Autopilot", (_label, total_budget) => {
    const v = evaluateUnattended(card("linkedin_ads.update_campaign_group", { changes: { total_budget } }), ok());
    expect(v.verdict).not.toBe("allow");
    expect(v.reasons).toContain("linkedin_total_budget_needs_founder");
  });
});

describe("what stays exactly as Meta", () => {
  it("archive is founder-only and delete is never unattended", () => {
    const a = (mode: string) => ({ kind: "ad" as const, exec_class: "linkedin_ads.archive", payload: { target: "campaign", id: "22", account_id: "11", campaign_id: null, name: "Spring", expected_status: "PAUSED", mode, rationale: "r" }, source: { table: "channel_actions" as const, id: "ca-1", run_id: "run-1" } });
    expect(evaluateUnattended(a("archive"), ok())).toEqual({ verdict: "deny", reasons: ["archive_needs_founder"] });
    expect(evaluateUnattended(a("delete"), ok())).toEqual({ verdict: "deny", reasons: ["delete_never_unattended"] });
    expect(reachesCgoAdDoor("linkedin_ads.archive")).toBe(false);
  });

  it("a location change and an ad on/off are asked, never approved, as on Meta", () => {
    const loc = { kind: "ad" as const, exec_class: "linkedin_ads.update_targeting", payload: { ...ids, name: "Spring", before_fingerprint: "f", before_criteria: {}, after_criteria: {}, places_before: ["United States"], places_after: ["Canada"], origin: "agent", rationale: "r" }, source: { table: "channel_actions" as const, id: "ca-1", run_id: "run-1" } };
    expect(evaluateUnattended(loc, ok()).reasons).toContain("location_change_needs_founder");
    const st = { kind: "ad" as const, exec_class: "linkedin_ads.set_ad_status", payload: { creative_id: "44", ...ids, campaign_name: "Spring", ad_name: "Old", expected_status: "PAUSED", status: "ACTIVE", origin: "agent", rationale: "r" }, source: { table: "channel_actions" as const, id: "ca-1", run_id: "run-1" } };
    expect(evaluateUnattended(st, ok()).reasons).toContain("ad_status_needs_founder");
    expect(reachesCgoAdDoor("linkedin_ads.update_targeting")).toBe(false);
    expect(reachesCgoAdDoor("linkedin_ads.set_ad_status")).toBe(false);
  });

  it("the open-advice envelope reads the same spend direction the gate does", () => {
    expect(adDirection("linkedin_ads.create_campaign", card("linkedin_ads.create_campaign").payload)).toBe("create");
    expect(adDirection("linkedin_ads.update_campaign_group", card("linkedin_ads.update_campaign_group", { changes: { name: { before: "A", after: "B" } } }).payload)).toBe("other");
    expect(adDirection("linkedin_ads.update_campaign", card("linkedin_ads.update_campaign").payload)).toBe("up");
  });
});
