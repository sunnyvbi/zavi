import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), emit: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));

import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { canonicalTargeting } from "@/services/connectors/linkedin-ads/account-reads";
import { linkedinAdsProposeCampaignEditTool, replaceAudienceFacets } from "../propose_campaign_edit";
import { linkedinAdsProposeCampaignGroupEditTool } from "../propose_campaign_group_edit";
import { linkedinAdsProposeArchiveTool } from "../propose_archive";
import { linkedinAdsProposeAdStatusTool } from "../propose_ad_status";
import { currentLocationUrns } from "../propose_targeting_change";
import {
  LINKEDIN_AD_STATUS_CLASS,
  LINKEDIN_ARCHIVE_CLASS,
  LINKEDIN_CAMPAIGN_EDIT_CLASS,
  LINKEDIN_GROUP_EDIT_CLASS,
  linkedinAdStatusBodySchema,
  linkedinArchiveBodySchema,
  linkedinCampaignEditBodySchema,
  linkedinCardRaisesSpend,
  linkedinGroupEditBodySchema,
} from "../../_change-bodies";

const DAY = 86_400_000;
const US = "urn:li:geo:103644278";
const CA = "urn:li:geo:101174742";
const DE = "urn:li:geo:101282230";
const LOC = "urn:li:adTargetingFacet:locations";
const LOCALES = "urn:li:adTargetingFacet:interfaceLocales";
const TITLES = "urn:li:adTargetingFacet:titles";
const SKILLS = "urn:li:adTargetingFacet:skills";
const targeting = { include: { and: [{ or: { [LOC]: [US] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }, { or: { [SKILLS]: ["urn:li:skill:9"] } }] } };
const END = Date.UTC(2027, 0, 31, 23, 59, 59);
const STAMP = Date.UTC(2026, 10, 1, 12, 0, 0);
let live: Record<string, unknown>;
let group: Record<string, unknown> | null;
let ads: Array<Record<string, unknown>>;
let accounts: Array<Record<string, unknown>>;
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const gone = { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => "{}" };
const entity = (urn: string, name: string, facetUrn = LOC) => ({ urn, name, facetUrn, isTargetable: true });
const ctx = (over: Record<string, unknown> = {}) => ({ tenant_id: "t1", log: () => {}, emit_decision: m.emit, ...over }) as never;
const KNOWN = [entity(US, "United States"), entity(CA, "Canada"), entity("urn:li:skill:9", "Python", SKILLS), entity("urn:li:title:1", "Founder", TITLES), entity("urn:li:title:2", "CTO", TITLES)];

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.inUse.mockResolvedValue(true);
  m.emit.mockResolvedValue("card-1");
  live = {
    id: 22, account: "urn:li:sponsoredAccount:11", name: "Spring", status: "ACTIVE", objectiveType: "WEBSITE_CONVERSIONS",
    dailyBudget: { amount: "40", currencyCode: "USD" }, unitCost: { amount: "3.5", currencyCode: "USD" },
    runSchedule: { start: Date.now() - 30 * DAY, end: END }, targetingCriteria: targeting,
    audienceExpansionEnabled: true, changeAuditStamps: { lastModified: { time: STAMP } },
  };
  group = { id: 5, account: "urn:li:sponsoredAccount:11", name: "Q1", status: "ACTIVE", totalBudget: { amount: "1000", currencyCode: "USD" }, runSchedule: { start: Date.now() - 30 * DAY }, changeAuditStamps: { lastModified: { time: STAMP } } };
  ads = [
    { id: "urn:li:sponsoredCreative:7", campaign: "urn:li:sponsoredCampaign:22", name: "Hero", intendedStatus: "ACTIVE" },
    { id: "urn:li:sponsoredCreative:8", campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "PAUSED" },
  ];
  accounts = [{ id: 11, name: "Acme", currency: "USD", status: "ACTIVE" }];
  m.fetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("adAccounts/11/adCampaigns/22")) return ok(live);
    if (u.includes("adAccounts/11/adCampaignGroups/5")) return group ? ok(group) : gone;
    if (u.includes("adAccounts/11/creatives/urn%3Ali%3AsponsoredCreative%3A7")) return ads[0] ? ok(ads[0]) : gone;
    if (u.includes("adAccounts/11/creatives") && u.includes("q=criteria")) return ok({ elements: ads });
    if (u.includes("adAccounts?q=search")) return ok({ elements: accounts });
    if (u.includes("adTargetingEntities") && u.includes("q=urns")) return ok({ elements: KNOWN.filter((e) => u.includes(encodeURIComponent(e.urn)) || u.includes(e.urn)) });
    if (u.includes("adTargetingEntities") && u.includes("typeahead")) {
      if (/query=Canada/i.test(u)) return ok({ elements: [entity(CA, "Canada")] });
      if (/query=Germany/i.test(u)) return ok({ elements: [entity(DE, "Germany")] });
      return ok({ elements: [] });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const edit = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeCampaignEditTool.execute(c, { campaign_id: "22", account_id: "11", rationale: "CTR 0.9% on the new creative", new_name: "Spring 2027", ...input });
const groupEdit = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeCampaignGroupEditTool.execute(c, { group_id: "5", account_id: "11", rationale: "Q1 is overspending", new_name: "Q1 2027", ...input });
const archive = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeArchiveTool.execute(c, { target: "campaign", id: "22", account_id: "11", rationale: "no spend in 90 days", ...input });
const adStatus = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeAdStatusTool.execute(c, { creative_id: "8", campaign_id: "22", account_id: "11", status: "ACTIVE", rationale: "the hero ad is fatigued", ...input });
const emitted = <T>(i = 0) => m.emit.mock.calls[i] as [string, T];

describe("the four edit tools only file a card, and only for objects in the founder's own account", () => {
  it("none of them works outside a channel run", async () => {
    const bare = ctx({ emit_decision: undefined });
    for (const call of [() => edit({}, bare), () => groupEdit({}, bare), () => archive({}, bare), () => adStatus({}, bare)]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_propose_not_channel_run" });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("refuses a wallet-bound campaign before LinkedIn is read, on every campaign-shaped tool", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", funding_source: "wallet" });
    await expect(edit()).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    await expect(archive()).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    await expect(archive({ target: "creative", id: "7", campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    await expect(adStatus()).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("refuses an account this workspace does not use before LinkedIn is read, on every tool", async () => {
    m.inUse.mockResolvedValue(false);
    for (const call of [() => edit(), () => groupEdit(), () => archive(), () => archive({ target: "campaign_group", id: "5" }), () => adStatus()]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_propose_campaign_edit", () => {
  it("files every change with its 'before' taken from the LIVE read, never from the input, and the body passes the strict schema", async () => {
    live.name = "Renamed in LinkedIn";
    await expect(edit({ new_name: "Spring 2027", run_until: "2027-03-31", bid: "4", audience_expansion: false, offsite_delivery: true })).resolves.toMatchObject({ status: "waiting_for_owner", campaign: { id: "22", name: "Renamed in LinkedIn" } });
    const [cls, body] = emitted<Record<string, unknown>>();
    expect(cls).toBe(LINKEDIN_CAMPAIGN_EDIT_CLASS);
    expect(linkedinCampaignEditBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      campaign_id: "22", account_id: "11", name: "Renamed in LinkedIn", last_modified_at: new Date(STAMP).toISOString(),
      changes: {
        name: { before: "Renamed in LinkedIn", after: "Spring 2027" },
        run_end_at: { before: new Date(END).toISOString(), after: "2027-03-31T23:59:59.000Z" },
        unit_cost: { before: { amount: "3.50", currency: "USD" }, after: { amount: "4.00", currency: "USD" } },
        audience_expansion: { before: true, after: false },
        offsite_delivery: { before: false, after: true },
      },
    });
    expect((body.changes as Record<string, unknown>).targeting).toBeUndefined();
    expect(linkedinCardRaisesSpend(cls, body)).toBe(true);
  });

  it("must catch: a change equal to the live value is dropped, and a card with nothing left is refused instead of filed", async () => {
    await expect(edit({ new_name: "Spring" })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
    await expect(edit({ new_name: "Spring", bid: "3.50", audience_expansion: true, offsite_delivery: false, run_until: "2027-01-31" })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
    await expect(edit({ new_name: "Spring", bid: "3.50", audience_expansion: true, offsite_delivery: false, run_until: "2027-01-31", add_locations: ["United States"] })).rejects.toMatchObject({ code: "linkedin_ads_location_unknown" });
    expect(m.emit).not.toHaveBeenCalled();
    await expect(edit({ new_name: "Spring", bid: "3.5", audience_expansion: true, offsite_delivery: true })).resolves.toMatchObject({ changes: { offsite_delivery: { before: false, after: true } } });
    expect(Object.keys(emitted<{ changes: object }>()[1].changes)).toEqual(["offsite_delivery"]);
  });

  it("refuses a zero bid, a run_until not after today, and an ended campaign, filing nothing", async () => {
    await expect(edit({ bid: "0" })).rejects.toMatchObject({ code: "linkedin_ads_bid_zero" });
    await expect(edit({ bid: "0.00" })).rejects.toMatchObject({ code: "linkedin_ads_bid_zero" });
    await expect(edit({ run_until: new Date().toISOString().slice(0, 10) })).rejects.toMatchObject({ code: "linkedin_ads_end_date_passed" });
    await expect(edit({ run_until: "2026-02-30" })).rejects.toMatchObject({ code: "linkedin_ads_end_date_passed" });
    for (const status of ["ARCHIVED", "CANCELED", "PENDING_DELETION", "REMOVED"]) {
      live.status = status;
      await expect(edit()).rejects.toMatchObject({ code: "linkedin_ads_campaign_ended" });
    }
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("refuses run_until together with clear_end_date, and clears an end date only when there is one", async () => {
    await expect(edit({ run_until: "2027-03-31", clear_end_date: true })).rejects.toThrow();
    await expect(edit({ new_name: undefined, clear_end_date: true })).resolves.toMatchObject({ changes: { run_end_at: { before: new Date(END).toISOString(), after: null } } });
    live.runSchedule = { start: Date.now() - DAY };
    await expect(edit({ new_name: undefined, clear_end_date: true })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
  });

  it("a location change fingerprints the live audience, keeps the interface language and the other facets, and never adds the EU", async () => {
    await expect(edit({ new_name: undefined, add_locations: ["Canada"] })).resolves.toMatchObject({ status: "waiting_for_owner" });
    const [, body] = emitted<{ changes: { targeting: { before_fingerprint: string; after_criteria: unknown; summary_before: string; summary_after: string } } }>();
    const t = body.changes.targeting;
    expect(t.before_fingerprint).toBe(canonicalTargeting(targeting));
    expect(currentLocationUrns(t.after_criteria)).toEqual([US, CA]);
    expect(JSON.stringify(t.after_criteria)).toContain(LOCALES);
    expect(JSON.stringify(t.after_criteria)).toContain("urn:li:skill:9");
    expect(t.summary_before).toBe("Locations: United States; Skills: Python");
    expect(t.summary_after).toBe("Locations: United States, Canada; Skills: Python");
    expect(linkedinCampaignEditBodySchema.safeParse(body).success).toBe(true);
    m.emit.mockClear();
    await expect(edit({ new_name: undefined, add_locations: ["Germany"] })).rejects.toMatchObject({ code: "linkedin_ads_location_eu" });
    await expect(edit({ new_name: undefined, remove_locations: ["United States"] })).rejects.toMatchObject({ code: "linkedin_ads_no_locations_left" });
    await expect(edit({ new_name: undefined, remove_locations: ["Mexico"] })).rejects.toMatchObject({ code: "linkedin_ads_location_not_targeted" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("an audience object replaces the non-location facets, keeps locations and language, and is a no-op when it matches what is live", async () => {
    await expect(edit({ new_name: undefined, audience: { titles: ["urn:li:title:1", "urn:li:title:2"] } })).resolves.toMatchObject({ status: "waiting_for_owner" });
    const [, body] = emitted<{ changes: { targeting: { after_criteria: { include: { and: Array<{ or: Record<string, string[]> }> } }; summary_after: string } } }>();
    const and = body.changes.targeting.after_criteria.include.and;
    expect(and).toEqual([{ or: { [LOC]: [US] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }, { or: { [TITLES]: ["urn:li:title:1", "urn:li:title:2"] } }]);
    expect(body.changes.targeting.summary_after).toBe("Locations: United States; Job titles: Founder or CTO");
    m.emit.mockClear();
    await expect(edit({ new_name: undefined, audience: { titles: ["urn:li:title:1"], seniorities: ["urn:li:seniority:3"] } })).rejects.toThrow();
    live.targetingCriteria = { include: { and: [{ or: { [LOC]: [US] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }] } };
    await expect(edit({ new_name: undefined, audience: {} })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
    expect(m.emit).not.toHaveBeenCalled();
    expect(() => replaceAudienceFacets({ include: { and: [{ or: { [LOC]: [US] } }] } }, { titles: [], seniorities: [], industries: [], staffCountRanges: [] })).toThrow(expect.objectContaining({ code: "linkedin_ads_targeting_invalid" }));
  });
});

describe("linkedin_ads_propose_campaign_group_edit", () => {
  it("files the live 'before' for name, status, end date and total budget, and the body passes the strict schema", async () => {
    group!.name = "Renamed in LinkedIn";
    await expect(groupEdit({ new_name: "Q1 2027", status: "PAUSED", run_until: "2027-06-30", total_budget: "1500" })).resolves.toMatchObject({ status: "waiting_for_owner", group: { id: "5", name: "Renamed in LinkedIn" } });
    const [cls, body] = emitted<Record<string, unknown>>();
    expect(cls).toBe(LINKEDIN_GROUP_EDIT_CLASS);
    expect(linkedinGroupEditBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      group_id: "5", account_id: "11", name: "Renamed in LinkedIn", last_modified_at: new Date(STAMP).toISOString(),
      changes: {
        name: { before: "Renamed in LinkedIn", after: "Q1 2027" },
        status: { before: "ACTIVE", after: "PAUSED" },
        run_end_at: { before: null, after: "2027-06-30T23:59:59.000Z" },
        total_budget: { before: { amount: "1000.00", currency: "USD" }, after: { amount: "1500.00", currency: "USD" } },
      },
    });
  });

  it("reads the group only after the account check, and refuses the default group, an ended group and a no-op", async () => {
    group!.backfilled = true;
    await expect(groupEdit()).rejects.toMatchObject({ code: "linkedin_ads_default_group" });
    group!.backfilled = false;
    group!.status = "ARCHIVED";
    await expect(groupEdit()).rejects.toMatchObject({ code: "linkedin_ads_group_ended" });
    group!.status = "ACTIVE";
    await expect(groupEdit({ new_name: "Q1", status: "ACTIVE", total_budget: "1000.00" })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
    await expect(groupEdit({ total_budget: "0" })).rejects.toMatchObject({ code: "linkedin_ads_budget_zero" });
    group = null;
    await expect(groupEdit()).rejects.toMatchObject({ code: "linkedin_ads_group_not_found" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("a group with no budget takes the account currency, and is refused when no currency is known", async () => {
    delete group!.totalBudget;
    await expect(groupEdit({ new_name: undefined, total_budget: "500" })).resolves.toMatchObject({ changes: { total_budget: { before: null, after: { amount: "500.00", currency: "USD" } } } });
    await expect(groupEdit({ new_name: undefined, clear_total_budget: true })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
    accounts = [{ id: 11, name: "Acme", status: "ACTIVE" }];
    resetLinkedInAdsReadCache();
    await expect(groupEdit({ new_name: undefined, total_budget: "500" })).rejects.toMatchObject({ code: "linkedin_ads_currency_unknown" });
    expect(m.emit).toHaveBeenCalledTimes(1);
  });

  it("must catch: a draft group cannot be switched on from here", async () => {
    group!.status = "DRAFT";
    await expect(groupEdit({ new_name: undefined, status: "ACTIVE" })).rejects.toMatchObject({ code: "linkedin_ads_group_status_unsupported" });
    expect(m.emit).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_propose_archive", () => {
  it("refuses a running campaign or group, the default group, and anything already archived or deleted", async () => {
    await expect(archive()).rejects.toMatchObject({ code: "linkedin_ads_campaign_active" });
    await expect(archive({ target: "campaign_group", id: "5" })).rejects.toMatchObject({ code: "linkedin_ads_group_active" });
    group!.status = "PAUSED";
    group!.backfilled = true;
    await expect(archive({ target: "campaign_group", id: "5" })).rejects.toMatchObject({ code: "linkedin_ads_default_group" });
    live.status = "ARCHIVED";
    await expect(archive()).rejects.toMatchObject({ code: "linkedin_ads_already_archived" });
    live.status = "PENDING_DELETION";
    await expect(archive({ mode: "delete" })).rejects.toMatchObject({ code: "linkedin_ads_already_archived" });
    ads[0].intendedStatus = "ARCHIVED";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_already_archived" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("files the live status as expected_status for a paused campaign, a paused group and an ad, with the body passing the strict schema", async () => {
    live.status = "PAUSED";
    await expect(archive()).resolves.toMatchObject({ status: "waiting_for_owner", target: { kind: "campaign", id: "22", name: "Spring", was: "PAUSED" } });
    group!.status = "PAUSED";
    await expect(archive({ target: "campaign_group", id: "5", mode: "delete" })).resolves.toMatchObject({ target: { kind: "campaign_group", was: "PAUSED" }, mode: "delete" });
    ads[0].intendedStatus = "PAUSED";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22" })).resolves.toMatchObject({ target: { kind: "creative", id: "7", name: "Hero", was: "PAUSED" } });
    expect(m.emit).toHaveBeenCalledTimes(3);
    for (const [cls, body] of m.emit.mock.calls as Array<[string, unknown]>) {
      expect(cls).toBe(LINKEDIN_ARCHIVE_CLASS);
      expect(linkedinArchiveBodySchema.safeParse(body).success).toBe(true);
    }
    expect(emitted<Record<string, unknown>>(2)[1]).toMatchObject({ target: "creative", id: "7", campaign_id: "22", expected_status: "PAUSED", mode: "archive" });
  });

  it("must catch: an ad that is on is refused for archive and delete, even when another ad in its campaign is on", async () => {
    ads.push({ id: "urn:li:sponsoredCreative:9", campaign: "urn:li:sponsoredCampaign:22", name: "Second", intendedStatus: "ACTIVE" });
    await expect(archive({ target: "creative", id: "7", campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_ad_active" });
    await expect(archive({ target: "creative", id: "7", campaign_id: "22", mode: "delete" })).rejects.toMatchObject({ code: "linkedin_ads_ad_active" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("an ad outside the named campaign, and a creative without campaign_id, are refused", async () => {
    ads[0].campaign = "urn:li:sponsoredCampaign:99";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_ad_not_found" });
    await expect(archive({ target: "creative", id: "7" })).rejects.toThrow();
    expect(m.emit).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_propose_ad_status", () => {
  it("turning an ad on waits for an owner; turning one off is a member-level approval; the body passes the strict schema", async () => {
    await expect(adStatus()).resolves.toMatchObject({ status: "waiting_for_owner", ad: { id: "8", name: "Ad 8", was: "PAUSED", becomes: "ACTIVE" } });
    ads.push({ id: "urn:li:sponsoredCreative:9", campaign: "urn:li:sponsoredCampaign:22", name: "Second", intendedStatus: "ACTIVE" });
    resetLinkedInAdsReadCache();
    await expect(adStatus({ creative_id: "7", status: "PAUSED" })).resolves.toMatchObject({ status: "waiting_for_approval", ad: { id: "7", name: "Hero", was: "ACTIVE", becomes: "PAUSED" } });
    for (const [cls, body] of m.emit.mock.calls as Array<[string, unknown]>) {
      expect(cls).toBe(LINKEDIN_AD_STATUS_CLASS);
      expect(linkedinAdStatusBodySchema.safeParse(body).success).toBe(true);
    }
    expect(emitted<Record<string, unknown>>(0)[1]).toEqual({ creative_id: "8", campaign_id: "22", account_id: "11", campaign_name: "Spring", ad_name: "Ad 8", expected_status: "PAUSED", status: "ACTIVE", rationale: "the hero ad is fatigued", origin: "agent" });
    expect(linkedinCardRaisesSpend(LINKEDIN_AD_STATUS_CLASS, emitted(0)[1])).toBe(true);
    expect(linkedinCardRaisesSpend(LINKEDIN_AD_STATUS_CLASS, emitted(1)[1])).toBe(false);
  });

  it("must catch: the last ad that is on in a running campaign is never turned off, but it is once the campaign is paused", async () => {
    await expect(adStatus({ creative_id: "7", status: "PAUSED" })).rejects.toMatchObject({ code: "linkedin_ads_last_live_ad" });
    expect(m.emit).not.toHaveBeenCalled();
    live.status = "PAUSED";
    await expect(adStatus({ creative_id: "7", status: "PAUSED" })).resolves.toMatchObject({ status: "waiting_for_approval" });
  });

  it("refuses a no-op, an ad being deleted or archived, and an ad not in the campaign", async () => {
    await expect(adStatus({ creative_id: "7", status: "ACTIVE" })).rejects.toMatchObject({ code: "linkedin_ads_change_empty" });
    ads[1].intendedStatus = "PENDING_DELETION";
    resetLinkedInAdsReadCache();
    await expect(adStatus()).rejects.toMatchObject({ code: "linkedin_ads_ad_not_switchable" });
    ads[1].intendedStatus = "ARCHIVED";
    resetLinkedInAdsReadCache();
    await expect(adStatus()).rejects.toMatchObject({ code: "linkedin_ads_ad_not_switchable" });
    await expect(adStatus({ creative_id: "12" })).rejects.toMatchObject({ code: "linkedin_ads_ad_not_found" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("a draft ad can be turned on and the card says it was a draft", async () => {
    ads[1].intendedStatus = "DRAFT";
    await expect(adStatus()).resolves.toMatchObject({ ad: { was: "DRAFT" } });
    expect(emitted<Record<string, unknown>>()[1]).toMatchObject({ expected_status: "DRAFT", status: "ACTIVE" });
  });
});
