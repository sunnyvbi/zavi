import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), emit: vi.fn(), signal: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));
vi.mock("../../read_analytics", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readCampaignPauseSignal: m.signal }));

import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { canonicalTargeting } from "@/services/connectors/linkedin-ads/account-reads";
import { linkedinAdsProposeResumeCampaignTool } from "../propose_resume_campaign";
import { linkedinAdsProposeBudgetChangeTool } from "../propose_budget_change";
import { currentLocationUrns, linkedinAdsProposeTargetingChangeTool, replaceLocations } from "../propose_targeting_change";
import { linkedinActionRaisesSpend } from "../../_change-bodies";

const DAY = 86_400_000;
const US = "urn:li:geo:103644278";
const CA = "urn:li:geo:101174742";
const DE = "urn:li:geo:101282230";
const LOC = "urn:li:adTargetingFacet:locations";
const targeting = { include: { and: [{ or: { [LOC]: [US] } }, { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } }] } };
let live: Record<string, unknown>;
let funder: Record<string, unknown> | null;
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const entity = (urn: string, name: string) => ({ urn, name, facetUrn: LOC, isTargetable: true });
const ctx = (over: Record<string, unknown> = {}) => ({ tenant_id: "t1", log: () => {}, emit_decision: m.emit, ...over }) as never;

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.inUse.mockResolvedValue(true);
  m.emit.mockResolvedValue("card-1");
  m.signal.mockResolvedValue({ signal: "pause_candidate", note: "" });
  live = { id: 22, account: "urn:li:sponsoredAccount:11", name: "Spring", status: "PAUSED", objectiveType: "WEBSITE_CONVERSIONS", dailyBudget: { amount: "40", currencyCode: "USD" }, runSchedule: { start: Date.now() - 30 * DAY, end: Date.now() + 30 * DAY }, targetingCriteria: targeting };
  funder = { id: 23, account: "urn:li:sponsoredAccount:11", name: "Loser", status: "ACTIVE" };
  m.fetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("adAccounts/11/adCampaigns/22")) return ok(live);
    if (u.includes("adAccounts/11/adCampaigns/23")) return funder ? ok(funder) : { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => "{}" };
    if (u.includes("adTargetingEntities") && u.includes("q=urns")) return ok({ elements: [entity(US, "United States"), entity(CA, "Canada")].filter((e) => u.includes(encodeURIComponent(e.urn)) || u.includes(e.urn)) });
    if (u.includes("adTargetingEntities") && u.includes("typeahead")) {
      if (/query=Canada/i.test(u)) return ok({ elements: [entity(CA, "Canada")] });
      if (/query=Germany/i.test(u)) return ok({ elements: [entity(DE, "Germany")] });
      if (/query=United(%20| )States/i.test(u)) return ok({ elements: [entity(US, "United States")] });
      if (/query=Springfield/i.test(u)) return ok({ elements: [entity("urn:li:geo:1", "Springfield, Illinois, United States"), entity("urn:li:geo:2", "Springfield, Missouri, United States")] });
      return ok({ elements: [] });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const resume = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeResumeCampaignTool.execute(c, { campaign_id: "22", account_id: "11", rationale: "it converted at $30 before the pause", ...input });
const budget = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeBudgetChangeTool.execute(c, { campaign_id: "22", account_id: "11", proposed_amount: "30", rationale: "$400 over 30 days, 0 conversions", ...input });
const retarget = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeTargetingChangeTool.execute(c, { campaign_id: "22", account_id: "11", add_locations: ["Canada"], rationale: "Canada clicks convert twice as often on the site", ...input });

describe("the three change tools only ever file a card, and only for a campaign in the founder's own account", () => {
  it("none of them works outside a channel run", async () => {
    const bare = ctx({ emit_decision: undefined });
    for (const call of [() => resume({}, bare), () => budget({}, bare), () => retarget({}, bare)]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_propose_not_channel_run" });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("a wallet-bound campaign is refused by all three before LinkedIn is read", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", funding_source: "wallet" });
    for (const call of [resume, budget, retarget]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_propose_resume_campaign", () => {
  it("files the card with LinkedIn's live schedule and budget, and the status it must still be at approval", async () => {
    await expect(resume()).resolves.toMatchObject({ action_id: "card-1", status: "waiting_for_owner", campaign: { was: "PAUSED" } });
    expect(m.emit).toHaveBeenCalledWith("linkedin_ads.resume_campaign", expect.objectContaining({ campaign_id: "22", expected_status: "PAUSED", budget: { kind: "daily", amount: "40", currency: "USD" }, run_end_at: expect.any(String) }));
  });

  it("refuses a running campaign and anything LinkedIn cannot restart", async () => {
    live.status = "ACTIVE";
    await expect(resume()).rejects.toMatchObject({ code: "linkedin_ads_campaign_active" });
    live.status = "ARCHIVED";
    await expect(resume()).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_restartable" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("a paused campaign whose end date has passed needs run_until like a completed one", async () => {
    live.runSchedule = { start: Date.now() - 30 * DAY, end: Date.now() - DAY };
    await expect(resume()).rejects.toMatchObject({ code: "linkedin_ads_end_date_required" });
    await expect(resume({ run_until: "2099-02-28" })).resolves.toMatchObject({ campaign: { was: "PAUSED", run_until: "2099-02-28T23:59:59.000Z" } });
  });

  it("a completed campaign needs run_until after today, and the card carries that new end", async () => {
    live.status = "COMPLETED";
    await expect(resume()).rejects.toMatchObject({ code: "linkedin_ads_end_date_required" });
    await expect(resume({ run_until: "2020-01-01" })).rejects.toMatchObject({ code: "linkedin_ads_end_date_passed" });
    await expect(resume({ run_until: "2099-02-30" })).rejects.toMatchObject({ code: "linkedin_ads_end_date_passed" });
    await expect(resume({ run_until: "2099-02-28" })).resolves.toMatchObject({ campaign: { run_until: "2099-02-28T23:59:59.000Z" } });
    expect(m.emit).toHaveBeenCalledWith("linkedin_ads.resume_campaign", expect.objectContaining({ expected_status: "COMPLETED", run_end_at: "2099-02-28T23:59:59.000Z" }));
  });
});

describe("linkedin_ads_propose_budget_change", () => {
  it("a cut on a pause_candidate files with the live amount as the drift anchor, and a member may approve it", async () => {
    await expect(budget()).resolves.toMatchObject({ status: "waiting_for_founder", change: { kind: "daily", from: { amount: "40.00", currency: "USD" }, to: { amount: "30.00", currency: "USD" }, step_pct: -25 } });
    const [cls, body] = m.emit.mock.calls[0];
    expect(cls).toBe("linkedin_ads.update_campaign_budget");
    expect(linkedinActionRaisesSpend(cls, body)).toBe(false);
  });

  it("the agent's own cut is refused when the campaign has results; the founder's chat order is not", async () => {
    m.signal.mockResolvedValue({ signal: "has_results", note: "It converted 5 times." });
    await expect(budget()).rejects.toMatchObject({ code: "linkedin_ads_cut_not_candidate", meta: { pause_signal: "has_results" } });
    expect(m.emit).not.toHaveBeenCalled();
    await expect(budget({}, ctx({ run_trigger: "chat", founder_chat_order: true }))).resolves.toMatchObject({ action_id: "card-1" });
    expect(m.signal).toHaveBeenCalledTimes(1);
  });

  it("must catch: a cut on a campaign whose numbers LinkedIn left out is refused like a pause, never filed quietly", async () => {
    m.signal.mockResolvedValue({ signal: "metrics_unread", note: "LinkedIn left spend out of 3 days." });
    await expect(budget()).rejects.toMatchObject({ code: "linkedin_ads_cut_not_candidate", meta: { pause_signal: "metrics_unread" } });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("must catch: the raise cap is judged on exact cents, so a step that rounds down to 30.0% is still over the cap", async () => {
    live.dailyBudget = { amount: "1000", currencyCode: "USD" };
    await expect(budget({ proposed_amount: "1300.40" })).rejects.toMatchObject({ code: "linkedin_ads_budget_step_too_big" });
    expect(m.emit).not.toHaveBeenCalled();
    await expect(budget({ proposed_amount: "1300" })).resolves.toMatchObject({ change: { step_pct: 30 } });
  });

  it("a standing company rule does not count as the founder's order", async () => {
    m.signal.mockResolvedValue({ signal: "has_results", note: "It converted." });
    await expect(budget({}, ctx({ run_trigger: "chat", founder_chat_order: true, rules_steered: { budget: true, status: false } }))).rejects.toMatchObject({ code: "linkedin_ads_cut_not_candidate" });
  });

  it("the agent's own raise steps at most +30%; a bigger step is refused with the allowed amount, a founder's is not", async () => {
    await expect(budget({ proposed_amount: "60" })).rejects.toMatchObject({ code: "linkedin_ads_budget_step_too_big", message: expect.stringContaining("USD 52.00") });
    expect(m.emit).not.toHaveBeenCalled();
    await expect(budget({ proposed_amount: "52" })).resolves.toMatchObject({ status: "waiting_for_owner", change: { step_pct: 30 } });
    expect(linkedinActionRaisesSpend(...(m.emit.mock.calls[0] as [string, unknown]))).toBe(true);
    await expect(budget({ proposed_amount: "60" }, ctx({ run_trigger: "chat", founder_chat_order: true }))).resolves.toMatchObject({ change: { step_pct: 50 } });
  });

  it("a small raise under the floor passes even when its percentage is large", async () => {
    live.dailyBudget = { amount: "10", currencyCode: "USD" };
    await expect(budget({ proposed_amount: "19" })).resolves.toMatchObject({ change: { step_pct: 90 } });
  });

  it("must catch: a zero live budget is unread, so the agent cannot raise from nothing with the step cap switched off", async () => {
    live.dailyBudget = { amount: "0", currencyCode: "USD" };
    await expect(budget({ proposed_amount: "500" })).rejects.toMatchObject({ code: "linkedin_ads_budget_unread" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("names the funding campaign on a raise after reading it from the same account", async () => {
    await expect(budget({ proposed_amount: "50", funded_by_campaign_id: "23" })).resolves.toMatchObject({ change: { funded_by: { campaign_id: "23", name: "Loser" } } });
    funder = null;
    await expect(budget({ proposed_amount: "50", funded_by_campaign_id: "23" })).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_found" });
    await expect(budget({ proposed_amount: "50", funded_by_campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_funded_by_self" });
  });

  it("refuses the same amount, a zero, a daily cut under LinkedIn's USD 10 floor, and an ambiguous budget kind", async () => {
    await expect(budget({ proposed_amount: "40.00" })).rejects.toMatchObject({ code: "linkedin_ads_budget_unchanged" });
    await expect(budget({ proposed_amount: "0" })).rejects.toMatchObject({ code: "linkedin_ads_budget_zero" });
    await expect(budget({ proposed_amount: "9.99" })).rejects.toMatchObject({ code: "linkedin_ads_budget_below_minimum" });
    live.totalBudget = { amount: "900", currencyCode: "USD" };
    await expect(budget()).rejects.toMatchObject({ code: "linkedin_ads_budget_kind_required" });
    await expect(budget({ kind: "total", proposed_amount: "800" })).resolves.toMatchObject({ change: { kind: "total", from: { amount: "900.00" } } });
    expect(m.emit).toHaveBeenCalledTimes(1);
  });
});

describe("linkedin_ads_propose_targeting_change", () => {
  it("adds a resolved place, keeps the rest of the audience, and fingerprints the live criteria", async () => {
    await expect(retarget()).resolves.toMatchObject({ status: "waiting_for_owner", locations: { before: ["United States"], after: ["United States", "Canada"] } });
    const [cls, body] = m.emit.mock.calls[0] as [string, { before_fingerprint: string; after_criteria: unknown }];
    expect(cls).toBe("linkedin_ads.update_targeting");
    expect(body.before_fingerprint).toBe(canonicalTargeting(targeting));
    expect(currentLocationUrns(body.after_criteria)).toEqual([US, CA]);
    expect(JSON.stringify(body.after_criteria)).toContain("interfaceLocales");
  });

  it("removes by the name LinkedIn gives the current place, and refuses a place the campaign does not target", async () => {
    live.targetingCriteria = replaceLocations(targeting, [US, CA]);
    await expect(retarget({ add_locations: [], remove_locations: ["canada"] })).resolves.toMatchObject({ locations: { after: ["United States"] } });
    await expect(retarget({ add_locations: [], remove_locations: ["Mexico"] })).rejects.toMatchObject({ code: "linkedin_ads_location_not_targeted" });
  });

  it("never leaves a campaign with no location, never adds the EU, never adds an ambiguous or unknown place", async () => {
    await expect(retarget({ add_locations: [], remove_locations: ["United States"] })).rejects.toMatchObject({ code: "linkedin_ads_no_locations_left" });
    await expect(retarget({ add_locations: ["Germany"] })).rejects.toMatchObject({ code: "linkedin_ads_location_eu" });
    await expect(retarget({ add_locations: ["Springfield"] })).rejects.toMatchObject({ code: "linkedin_ads_location_unknown" });
    await expect(retarget({ add_locations: ["Atlantis"] })).rejects.toMatchObject({ code: "linkedin_ads_location_unknown" });
    await expect(retarget({ add_locations: ["United States"] })).rejects.toMatchObject({ code: "linkedin_ads_targeting_unchanged" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("an audience with no interface language is never rewritten", () => {
    expect(() => replaceLocations({ include: { and: [{ or: { [LOC]: [US] } }] } }, [CA])).toThrow(expect.objectContaining({ code: "linkedin_ads_targeting_invalid" }));
  });

  it("must catch: a profile-location audience, a location clause or-ed with another facet, and an audience with no location clause are all refused instead of silently narrowed or widened", async () => {
    const locales = { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } };
    live.targetingCriteria = { include: { and: [{ or: { "urn:li:adTargetingFacet:profileLocations": [US] } }, locales] } };
    await expect(retarget()).rejects.toMatchObject({ code: "linkedin_ads_targeting_profile_locations" });
    live.targetingCriteria = { include: { and: [{ or: { [LOC]: [US], "urn:li:adTargetingFacet:industries": ["urn:li:industry:4"] } }, locales] } };
    await expect(retarget()).rejects.toMatchObject({ code: "linkedin_ads_targeting_invalid" });
    live.targetingCriteria = { include: { and: [locales] } };
    await expect(retarget()).rejects.toMatchObject({ code: "linkedin_ads_targeting_invalid" });
    expect(() => replaceLocations({ include: { and: [locales] } }, [CA])).toThrow(expect.objectContaining({ code: "linkedin_ads_targeting_invalid" }));
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("replacing locations touches only the locations key of its clause", () => {
    const sibling = "urn:li:adTargetingFacet:industries";
    const out = replaceLocations({ include: { and: [{ or: { [LOC]: [US], [sibling]: ["urn:li:industry:4"] } }, { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } }] } }, [CA]);
    expect(out.include?.and?.[0]).toEqual({ or: { [LOC]: [CA], [sibling]: ["urn:li:industry:4"] } });
  });
});
