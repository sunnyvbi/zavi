import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), log: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));
vi.mock("@/services/logging/log-event", () => ({ logEvent: m.log }));

import { resetLinkedInAdsReadCache } from "../http";
import { executeLinkedInBudgetChange, executeLinkedInResume, executeLinkedInTargetingChange } from "../execute-change";
import { canonicalTargeting } from "../account-reads";

const DAY = 86_400_000;
const targeting = { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278"] } }, { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } }] } };
let live: Record<string, unknown>;
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const posts = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST").map(([u, init]) => ({ url: String(u), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.inUse.mockResolvedValue(true);
  live = { id: 22, account: "urn:li:sponsoredAccount:11", name: "Spring", status: "PAUSED", dailyBudget: { amount: "40", currencyCode: "USD" }, runSchedule: { start: Date.now() - 30 * DAY, end: Date.now() + 30 * DAY }, targetingCriteria: targeting };
  m.fetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, status: 204, headers: new Headers(), json: async () => ({}), text: async () => "" };
    if (String(url).includes("adAccounts/11/adCampaigns/22")) return ok(live);
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const resume = (over: Record<string, unknown> = {}) =>
  executeLinkedInResume({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", name: "Spring", rationale: "r", expected_status: "PAUSED", run_start_at: null, run_end_at: new Date((live.runSchedule as { end: number }).end).toISOString(), budget: null, ...over } });
const budget = (over: Record<string, unknown> = {}) =>
  executeLinkedInBudgetChange({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", name: "Spring", kind: "daily", expected_current: { amount: "40.00", currency: "USD" }, proposed: { amount: "30.00", currency: "USD" }, rationale: "r", ...over } });
const retarget = (over: Record<string, unknown> = {}) =>
  executeLinkedInTargetingChange({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", name: "Spring", before_fingerprint: canonicalTargeting(targeting), before_criteria: targeting, after_criteria: { ...targeting, marker: 1 }, places_before: ["United States"], places_after: ["United States", "Canada"], rationale: "r", ...over } });

describe("every change card re-reads LinkedIn and refuses on drift, so an approval applies only what the founder saw", () => {
  it("restarts a paused campaign with a bare status PARTIAL_UPDATE", async () => {
    await expect(resume()).resolves.toMatchObject({ ok: true });
    expect(posts()).toEqual([{ url: expect.stringContaining("adAccounts/11/adCampaigns/22"), body: { patch: { $set: { status: "ACTIVE" } } } }]);
  });

  it("must catch: a paused campaign whose end date has passed is not switched on without a new end date, and gets the new schedule when the card carries one", async () => {
    live.runSchedule = { start: Date.now() - 30 * DAY, end: Date.now() - DAY };
    await expect(resume()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_end_date_passed" });
    expect(posts()).toEqual([]);
    const end = new Date(Date.now() + 10 * DAY).toISOString();
    await expect(resume({ run_start_at: new Date((live.runSchedule as { start: number }).start).toISOString(), run_end_at: end })).resolves.toMatchObject({ ok: true });
    expect(posts()[0].body).toEqual({ patch: { $set: { status: "ACTIVE", runSchedule: { start: (live.runSchedule as { start: number }).start, end: Date.parse(end) } } } });
  });

  it("refuses when the campaign is no longer in the status the card was written against", async () => {
    live.status = "COMPLETED";
    await expect(resume()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    expect(posts()).toEqual([]);
  });

  it("must catch: an end date edited in LinkedIn after the card was written refuses the restart, so a run never outlives the date the owner approved", async () => {
    const liveEnd = (live.runSchedule as { end: number }).end;
    await expect(resume({ run_end_at: new Date(liveEnd + 20 * DAY).toISOString() })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    await expect(resume({ run_end_at: null })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    expect(posts()).toEqual([]);
    await expect(resume({ run_end_at: new Date(liveEnd).toISOString() })).resolves.toMatchObject({ ok: true });
    expect(posts()).toHaveLength(1);
  });

  it("an already-running campaign is a notice, not a second write", async () => {
    live.status = "ACTIVE";
    await expect(resume()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already running") });
    expect(posts()).toEqual([]);
  });

  it("a completed campaign needs a future end date and keeps LinkedIn's own start", async () => {
    live.status = "COMPLETED";
    const start = live.runSchedule as { start: number };
    const end = new Date(Date.now() + 10 * DAY).toISOString();
    const run_start_at = new Date(start.start).toISOString();
    await expect(resume({ expected_status: "COMPLETED", run_start_at, run_end_at: new Date(Date.now() - DAY).toISOString() })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_end_date_passed" });
    expect(posts()).toEqual([]);
    await expect(resume({ expected_status: "COMPLETED", run_start_at, run_end_at: end })).resolves.toMatchObject({ ok: true });
    expect(posts()[0].body).toEqual({ patch: { $set: { status: "ACTIVE", runSchedule: { start: start.start, end: Date.parse(end) } } } });
  });

  it("a restart applies only at the budget the card showed, to the cent, and only with the start date it was written against", async () => {
    const card = { budget: { kind: "daily", amount: "40", currency: "USD" } };
    await expect(resume(card)).resolves.toMatchObject({ ok: true });
    m.fetch.mockClear();
    live.dailyBudget = { amount: "45", currencyCode: "USD" };
    await expect(resume(card)).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_drift", error: expect.stringContaining("USD 45 now") });
    delete live.dailyBudget;
    live.totalBudget = { amount: "40", currencyCode: "USD" };
    await expect(resume(card)).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_drift" });
    live.status = "COMPLETED";
    live.dailyBudget = { amount: "40", currencyCode: "USD" };
    const start = (live.runSchedule as { start: number }).start;
    const end = new Date(Date.now() + 10 * DAY).toISOString();
    await expect(resume({ ...card, expected_status: "COMPLETED", run_end_at: end, run_start_at: new Date(start - DAY).toISOString() })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    await expect(resume({ ...card, expected_status: "COMPLETED", run_end_at: end, run_start_at: null })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_schedule_drift" });
    expect(posts()).toEqual([]);
    await expect(resume({ ...card, expected_status: "COMPLETED", run_end_at: end, run_start_at: new Date(start).toISOString() })).resolves.toMatchObject({ ok: true });
  });

  it("refuses a wallet-bound campaign before any read: Zavi's launch flow owns those", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", funding_source: "wallet" });
    await expect(resume()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_wallet_campaign" });
    await expect(budget()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_wallet_campaign" });
    await expect(retarget()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_wallet_campaign" });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("refuses an account this workspace does not use", async () => {
    m.inUse.mockResolvedValue(false);
    await expect(budget()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("lowers a budget only when LinkedIn still shows the amount on the card, to the cent", async () => {
    await expect(budget()).resolves.toMatchObject({ ok: true });
    expect(posts()[0].body).toEqual({ patch: { $set: { dailyBudget: { amount: "30.00", currencyCode: "USD" } } } });
    m.fetch.mockClear();
    live.dailyBudget = { amount: "40.01", currencyCode: "USD" };
    await expect(budget()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_drift", error: expect.stringContaining("USD 40.01 now") });
    expect(posts()).toEqual([]);
  });

  it("refuses when the campaign switched from a daily to a total budget since the card", async () => {
    delete live.dailyBudget;
    live.totalBudget = { amount: "400", currencyCode: "USD" };
    await expect(budget()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_kind_changed" });
    expect(posts()).toEqual([]);
  });

  it("a card whose two currencies disagree is invalid and sends nothing", async () => {
    await expect(budget({ proposed: { amount: "30.00", currency: "EUR" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_body_invalid" });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("changes locations only while the live audience matches the fingerprint on the card", async () => {
    await expect(retarget()).resolves.toMatchObject({ ok: true, places_change: { before: ["United States"], after: ["United States", "Canada"] } });
    expect(posts()[0].body).toEqual({ patch: { $set: { targetingCriteria: { ...targeting, marker: 1 } } } });
    m.fetch.mockClear();
    live.targetingCriteria = { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:101174742"] } }, { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } }] } };
    await expect(retarget()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_targeting_drift" });
    expect(posts()).toEqual([]);
  });

  it("the fingerprint ignores key and list order, so LinkedIn re-serialising the same audience is not drift", async () => {
    live.targetingCriteria = { include: { and: [{ or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } }, { or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278"] } }] } };
    await expect(retarget()).resolves.toMatchObject({ ok: true });
  });

  it("never rewrites an audience without an interface language, which LinkedIn would refuse or widen", async () => {
    await expect(retarget({ after_criteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:1"] } }] } } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_targeting_invalid" });
    expect(posts()).toEqual([]);
  });
});
