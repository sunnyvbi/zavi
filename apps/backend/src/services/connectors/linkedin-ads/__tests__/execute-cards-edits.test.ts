import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), log: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));

import { resetLinkedInAdsReadCache } from "../http";
import { executeLinkedInAdStatus, executeLinkedInArchive, executeLinkedInCampaignEdit, executeLinkedInGroupEdit } from "../execute-cards";
import { canonicalTargeting } from "../account-reads";

const DAY = 86_400_000;
const LOC = "urn:li:adTargetingFacet:locations";
const LOCALES = "urn:li:adTargetingFacet:interfaceLocales";
const targeting = { include: { and: [{ or: { [LOC]: ["urn:li:geo:103644278"] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }] } };
const afterTargeting = { include: { and: [{ or: { [LOC]: ["urn:li:geo:103644278", "urn:li:geo:101174742"] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }] } };
const START = Date.UTC(2026, 9, 1);
const END = Date.UTC(2027, 0, 31, 23, 59, 59);
const FUTURE = Date.UTC(2027, 2, 31, 23, 59, 59);
let live: Record<string, unknown>;
let group: Record<string, unknown> | null;
let ads: Array<Record<string, unknown>>;
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const gone = { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => "{}" };
const posts = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST").map(([u, init]) => ({ url: String(u), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.inUse.mockResolvedValue(true);
  live = { id: 22, account: "urn:li:sponsoredAccount:11", name: "Spring", status: "ACTIVE", dailyBudget: { amount: "40", currencyCode: "USD" }, unitCost: { amount: "3.5", currencyCode: "USD" }, runSchedule: { start: START, end: END }, targetingCriteria: targeting, audienceExpansionEnabled: true };
  group = { id: 5, account: "urn:li:sponsoredAccount:11", name: "Q1", status: "ACTIVE", totalBudget: { amount: "1000", currencyCode: "USD" }, runSchedule: { start: START } };
  ads = [
    { id: "urn:li:sponsoredCreative:7", campaign: "urn:li:sponsoredCampaign:22", name: "Hero", intendedStatus: "ACTIVE" },
    { id: "urn:li:sponsoredCreative:8", campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "PAUSED" },
  ];
  m.fetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") return { ok: true, status: 204, headers: new Headers(), json: async () => ({}), text: async () => "" };
    if (u.includes("adAccounts/11/adCampaigns/22")) return ok(live);
    if (u.includes("adAccounts/11/adCampaignGroups/5")) return group ? ok(group) : gone;
    if (u.includes("adAccounts/11/creatives/urn%3Ali%3AsponsoredCreative%3A7")) return ads[0] ? ok(ads[0]) : gone;
    if (u.includes("adAccounts/11/creatives") && u.includes("q=criteria")) return ok({ elements: ads });
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const base = { campaign_id: "22", account_id: "11", name: "Spring", rationale: "r", last_modified_at: null };
const edit = (changes: Record<string, unknown>, over: Record<string, unknown> = {}) => executeLinkedInCampaignEdit({ tenant_id: "t1", body: { ...base, changes, ...over } });
const groupEdit = (changes: Record<string, unknown>, over: Record<string, unknown> = {}) => executeLinkedInGroupEdit({ tenant_id: "t1", body: { group_id: "5", account_id: "11", name: "Q1", rationale: "r", last_modified_at: null, changes, ...over } });
const archive = (over: Record<string, unknown> = {}) => executeLinkedInArchive({ tenant_id: "t1", body: { target: "campaign", id: "22", account_id: "11", campaign_id: null, name: "Spring", expected_status: "PAUSED", mode: "archive", rationale: "r", ...over } });
const adStatus = (over: Record<string, unknown> = {}) => executeLinkedInAdStatus({ tenant_id: "t1", body: { creative_id: "8", campaign_id: "22", account_id: "11", campaign_name: "Spring", ad_name: "Ad 8", expected_status: "PAUSED", status: "ACTIVE", rationale: "r", ...over } });

describe("campaign edit cards re-read LinkedIn and apply only when every 'before' still holds", () => {
  it("happy path sends exactly one PARTIAL_UPDATE with only the changed fields", async () => {
    await expect(edit({ name: { before: "Spring", after: "Spring 2027" }, run_end_at: { before: iso(END), after: iso(FUTURE) }, unit_cost: { before: { amount: "3.50", currency: "USD" }, after: { amount: "4.00", currency: "USD" } }, audience_expansion: { before: true, after: false }, offsite_delivery: { before: false, after: true }, targeting: { before_fingerprint: canonicalTargeting(targeting), after_criteria: afterTargeting, summary_before: "US", summary_after: "US, CA" } })).resolves.toMatchObject({ ok: true });
    expect(posts()).toEqual([{ url: expect.stringContaining("adAccounts/11/adCampaigns/22"), body: { patch: { $set: { name: "Spring 2027", runSchedule: { start: START, end: FUTURE }, unitCost: { amount: "4.00", currencyCode: "USD" }, audienceExpansionEnabled: false, offsiteDeliveryEnabled: true, targetingCriteria: afterTargeting } } } }]);
  });

  it("must catch: drift on each field refuses with no POST", async () => {
    live.name = "Edited elsewhere";
    await expect(edit({ name: { before: "Spring", after: "Spring 2027" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_name_drift" });
    live.name = "Spring";
    live.runSchedule = { start: START, end: END + DAY };
    await expect(edit({ run_end_at: { before: iso(END), after: iso(FUTURE) } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    live.runSchedule = { start: START, end: END };
    await expect(edit({ run_end_at: { before: null, after: iso(FUTURE) } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    live.unitCost = { amount: "3.51", currencyCode: "USD" };
    await expect(edit({ unit_cost: { before: { amount: "3.50", currency: "USD" }, after: { amount: "4.00", currency: "USD" } } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_bid_drift" });
    live.unitCost = { amount: "3.50", currencyCode: "EUR" };
    await expect(edit({ unit_cost: { before: { amount: "3.50", currency: "USD" }, after: { amount: "4.00", currency: "USD" } } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_bid_drift" });
    live.audienceExpansionEnabled = false;
    await expect(edit({ audience_expansion: { before: true, after: false } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_setting_drift" });
    live.offsiteDeliveryEnabled = true;
    await expect(edit({ offsite_delivery: { before: false, after: true } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_setting_drift" });
    live.targetingCriteria = afterTargeting;
    await expect(edit({ targeting: { before_fingerprint: canonicalTargeting(targeting), after_criteria: afterTargeting, summary_before: "a", summary_after: "b" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_targeting_drift" });
    expect(posts()).toEqual([]);
  });

  it("an ended campaign, a passed end date, an unreadable start, and an audience without a language all send nothing", async () => {
    live.status = "ARCHIVED";
    await expect(edit({ name: { before: "Spring", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_campaign_ended" });
    live.status = "ACTIVE";
    await expect(edit({ run_end_at: { before: iso(END), after: iso(Date.now() - DAY) } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_end_date_passed" });
    live.runSchedule = { end: END };
    await expect(edit({ run_end_at: { before: iso(END), after: iso(FUTURE) } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_unread" });
    live.runSchedule = { start: START, end: END };
    await expect(edit({ targeting: { before_fingerprint: canonicalTargeting(targeting), after_criteria: { include: { and: [{ or: { [LOC]: ["urn:li:geo:1"] } }] } }, summary_before: "a", summary_after: "b" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_targeting_invalid" });
    expect(posts()).toEqual([]);
  });

  it("a card whose changes already hold in LinkedIn is a notice, not a write; an empty or malformed card is invalid", async () => {
    live.name = "Spring 2027";
    await expect(edit({ name: { before: "Spring 2027", after: "Spring 2027" } })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already") });
    await expect(edit({})).resolves.toMatchObject({ ok: false, code: "linkedin_ads_body_invalid" });
    await expect(edit({ unit_cost: { before: { amount: "3.5", currency: "usd" }, after: { amount: "4", currency: "USD" } } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_body_invalid" });
    expect(posts()).toEqual([]);
  });

  it("a wallet campaign and an unused account are refused before any read", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", funding_source: "wallet" });
    await expect(edit({ name: { before: "Spring", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_wallet_campaign" });
    m.findBinding.mockResolvedValue(null);
    m.inUse.mockResolvedValue(false);
    await expect(edit({ name: { before: "Spring", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    await expect(groupEdit({ name: { before: "Q1", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});

describe("campaign group edit cards", () => {
  it("happy path sends $set for changed fields and $delete for a cleared budget", async () => {
    await expect(groupEdit({ name: { before: "Q1", after: "Q1 2027" }, status: { before: "ACTIVE", after: "PAUSED" }, run_end_at: { before: null, after: iso(FUTURE) }, total_budget: { before: { amount: "1000.00", currency: "USD" }, after: { amount: "1500.00", currency: "USD" } } })).resolves.toMatchObject({ ok: true });
    expect(posts()).toEqual([{ url: expect.stringContaining("adAccounts/11/adCampaignGroups/5"), body: { patch: { $set: { name: "Q1 2027", status: "PAUSED", runSchedule: { start: START, end: FUTURE }, totalBudget: { amount: "1500.00", currencyCode: "USD" } } } } }]);
    m.fetch.mockClear();
    await expect(groupEdit({ total_budget: { before: { amount: "1000.00", currency: "USD" }, after: null } })).resolves.toMatchObject({ ok: true });
    expect(posts()[0].body).toEqual({ patch: { $delete: ["totalBudget"] } });
  });

  it("must catch: drift on name, status, end date and budget refuses with no POST", async () => {
    group!.name = "Renamed";
    await expect(groupEdit({ name: { before: "Q1", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_name_drift" });
    group!.name = "Q1";
    group!.status = "PAUSED";
    await expect(groupEdit({ status: { before: "ACTIVE", after: "PAUSED" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    await expect(groupEdit({ status: { before: "PAUSED", after: "PAUSED" } })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already") });
    group!.status = "ACTIVE";
    group!.runSchedule = { start: START, end: END };
    await expect(groupEdit({ run_end_at: { before: null, after: iso(FUTURE) } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    group!.totalBudget = { amount: "1000.01", currencyCode: "USD" };
    await expect(groupEdit({ total_budget: { before: { amount: "1000.00", currency: "USD" }, after: null } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_drift" });
    delete group!.totalBudget;
    await expect(groupEdit({ total_budget: { before: { amount: "1000.00", currency: "USD" }, after: null } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_drift" });
    expect(posts()).toEqual([]);
  });

  it("the backfilled default group, an ended group and a missing group are refused", async () => {
    group!.backfilled = true;
    await expect(groupEdit({ name: { before: "Q1", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_default_group" });
    group!.backfilled = false;
    group!.status = "ARCHIVED";
    await expect(groupEdit({ name: { before: "Q1", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_group_ended" });
    group = null;
    await expect(groupEdit({ name: { before: "Q1", after: "X" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_group_not_found" });
    expect(posts()).toEqual([]);
  });
});

describe("archive cards", () => {
  it("archives a paused campaign, deletes a paused group, archives an ad, each with one status PARTIAL_UPDATE", async () => {
    live.status = "PAUSED";
    await expect(archive()).resolves.toMatchObject({ ok: true });
    group!.status = "PAUSED";
    await expect(archive({ target: "campaign_group", id: "5", name: "Q1", mode: "delete" })).resolves.toMatchObject({ ok: true });
    ads[0].intendedStatus = "PAUSED";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22", name: "Hero", expected_status: "PAUSED" })).resolves.toMatchObject({ ok: true });
    expect(posts()).toEqual([
      { url: expect.stringContaining("adAccounts/11/adCampaigns/22"), body: { patch: { $set: { status: "ARCHIVED" } } } },
      { url: expect.stringContaining("adAccounts/11/adCampaignGroups/5"), body: { patch: { $set: { status: "PENDING_DELETION" } } } },
      { url: expect.stringContaining("creatives/urn%3Ali%3AsponsoredCreative%3A7"), body: { patch: { $set: { intendedStatus: "ARCHIVED" } } } },
    ]);
  });

  it("must catch: an ACTIVE campaign or group is refused even when the card says it was active", async () => {
    await expect(archive({ expected_status: "ACTIVE" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_campaign_active" });
    await expect(archive({ target: "campaign_group", id: "5", name: "Q1", expected_status: "ACTIVE" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_group_active" });
    group!.status = "PAUSED";
    group!.backfilled = true;
    await expect(archive({ target: "campaign_group", id: "5", name: "Q1" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_default_group" });
    expect(posts()).toEqual([]);
  });

  it("must catch: an ad that is on is never archived or deleted, even with a second live ad or a paused campaign", async () => {
    const creative = { target: "creative", id: "7", campaign_id: "22", name: "Hero", expected_status: "ACTIVE" };
    await expect(archive(creative)).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_active" });
    await expect(archive({ ...creative, mode: "delete" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_active" });
    ads[1].intendedStatus = "ACTIVE";
    resetLinkedInAdsReadCache();
    await expect(archive(creative)).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_active" });
    resetLinkedInAdsReadCache();
    live.status = "PAUSED";
    await expect(archive({ ...creative, mode: "delete" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_active" });
    expect(posts()).toEqual([]);
  });

  it("an already archived or deleted object is a notice with no POST; a status change since the card is drift", async () => {
    live.status = "ARCHIVED";
    await expect(archive()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already archived") });
    live.status = "PENDING_DELETION";
    await expect(archive({ mode: "delete" })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already deleted") });
    live.status = "COMPLETED";
    await expect(archive()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    ads[0].intendedStatus = "ARCHIVED";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22", name: "Hero", expected_status: "ACTIVE" })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already archived") });
    ads[0].intendedStatus = "PAUSED";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22", name: "Hero", expected_status: "ACTIVE" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    ads[0].campaign = "urn:li:sponsoredCampaign:99";
    await expect(archive({ target: "creative", id: "7", campaign_id: "22", name: "Hero", expected_status: "PAUSED" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_campaign_not_found" });
    expect(posts()).toEqual([]);
  });
});

describe("ad status cards", () => {
  it("turns an ad on or off with one intendedStatus PARTIAL_UPDATE", async () => {
    await expect(adStatus()).resolves.toMatchObject({ ok: true });
    expect(posts()).toEqual([{ url: expect.stringContaining("creatives/urn%3Ali%3AsponsoredCreative%3A8"), body: { patch: { $set: { intendedStatus: "ACTIVE" } } } }]);
    m.fetch.mockClear();
    resetLinkedInAdsReadCache();
    ads.push({ id: "urn:li:sponsoredCreative:9", campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "ACTIVE" });
    await expect(adStatus({ creative_id: "7", ad_name: "Hero", expected_status: "ACTIVE", status: "PAUSED" })).resolves.toMatchObject({ ok: true });
    expect(posts()[0].body).toEqual({ patch: { $set: { intendedStatus: "PAUSED" } } });
  });

  it("must catch: the last live ad of a running campaign is never turned off, but is once the campaign is paused", async () => {
    await expect(adStatus({ creative_id: "7", ad_name: "Hero", expected_status: "ACTIVE", status: "PAUSED" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_last_live_ad" });
    expect(posts()).toEqual([]);
    live.status = "PAUSED";
    resetLinkedInAdsReadCache();
    await expect(adStatus({ creative_id: "7", ad_name: "Hero", expected_status: "ACTIVE", status: "PAUSED" })).resolves.toMatchObject({ ok: true });
    expect(posts()).toHaveLength(1);
  });

  it("drift, a no-op and a missing ad send nothing", async () => {
    ads[1].intendedStatus = "DRAFT";
    await expect(adStatus()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    ads[1].intendedStatus = "ACTIVE";
    resetLinkedInAdsReadCache();
    await expect(adStatus()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already on") });
    await expect(adStatus({ creative_id: "12" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_not_found" });
    expect(posts()).toEqual([]);
  });
});
