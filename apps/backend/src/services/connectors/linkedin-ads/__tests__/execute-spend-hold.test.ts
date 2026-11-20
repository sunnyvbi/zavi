import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), log: vi.fn(), reserve: vi.fn(), commit: vi.fn(), settle: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/logging/log-event", () => ({ logEvent: m.log }));
vi.mock("@/services/decisions/ad-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/decisions/ad-budget")>()),
  reserveAdSpend: m.reserve,
  commitAdSpend: m.commit,
  settleAdSpendAfterError: m.settle,
}));

import { resetLinkedInAdsReadCache } from "../http";
import { executeLinkedInBudgetChange, executeLinkedInResume } from "../execute-change";
import { executeLinkedInCreateCampaign, executeLinkedInDuplicate } from "../execute-cards";

const DAY = 86_400_000;
const PAGE = "urn:li:organization:77";
const US = "urn:li:geo:103644278";
const LAST_MODIFIED = 1_760_000_000_000;
const targeting = { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": [US] } }, { or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } }] } };
const HELD = { status: "held", tenant_id: "t1", idem_key: "ca-1:op", fresh: true };

let live: Record<string, unknown>;
let refuseWrites = false;
let created = 900;
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const writes = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST");

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue({ id: "bind-1", funding_source: "provider" });
  m.inUse.mockResolvedValue(true);
  m.reserve.mockResolvedValue(HELD);
  m.commit.mockResolvedValue(undefined);
  m.settle.mockResolvedValue(undefined);
  refuseWrites = false;
  created = 900;
  live = { id: 22, account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:5", name: "Spring", status: "PAUSED", type: "SPONSORED_UPDATES", associatedEntity: PAGE, costType: "CPC", dailyBudget: { amount: "40", currencyCode: "USD" }, unitCost: { amount: "4", currencyCode: "USD" }, locale: { country: "US", language: "en" }, runSchedule: { start: Date.now() - 30 * DAY, end: Date.now() + 30 * DAY }, changeAuditStamps: { lastModified: { time: LAST_MODIFIED } }, targetingCriteria: targeting };
  m.fetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      if (refuseWrites) return { ok: false, status: 400, headers: new Headers(), json: async () => ({}), text: async () => JSON.stringify({ message: "refused" }) };
      if (new Headers(init.headers).get("X-RestLi-Method") === "CREATE") return { ok: true, status: 201, headers: new Headers({ "x-restli-id": String(++created) }), json: async () => ({}), text: async () => "" };
      return { ok: true, status: 204, headers: new Headers(), json: async () => ({}), text: async () => "" };
    }
    if (u.includes("adAccounts/11/adCampaigns/22")) return ok(live);
    if (u.includes("adAccounts/11/adCampaignGroups/5")) return ok({ id: 5, account: "urn:li:sponsoredAccount:11", name: "Q4", status: "ACTIVE" });
    if (u.includes("adAccounts/11/adCampaigns?") && u.includes("q=search")) return ok({ elements: [live] });
    if (u.includes("creatives?")) return ok({ elements: [] });
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const row = (approved_by_source: string | null, body: Record<string, unknown>, decision_class: string) => ({ id: "ca-1", tenant_id: "t1", exec_source: "channel_actions", decision_class, approved_by: approved_by_source ? null : "owner-1", approved_by_source, body });
const resumeBody = (over: Record<string, unknown> = {}) => ({ campaign_id: "22", account_id: "11", name: "Spring", origin: "agent", rationale: "r", expected_status: "PAUSED", run_start_at: null, run_end_at: new Date((live.runSchedule as { end: number }).end).toISOString(), budget: { kind: "daily", amount: "40", currency: "USD" }, ...over });
const raiseBody = (over: Record<string, unknown> = {}) => ({ campaign_id: "22", account_id: "11", name: "Spring", kind: "daily", expected_current: { amount: "40.00", currency: "USD" }, proposed: { amount: "60.00", currency: "USD" }, origin: "agent", rationale: "r", ...over });
const createBody = (over: Record<string, unknown> = {}) => ({ account_id: "11", group_id: "5", group_name: "Q4", expected_group_status: "ACTIVE", name: "Winter", daily_budget: { amount: "25", currency: "USD" }, unit_cost: { amount: "4.50", currency: "USD" }, geo_urns: [US], country: "US", language: "en", associated_entity: PAGE, objective_type: null, post_urn: null, places: ["United States"], origin: "agent", rationale: "r", ...over });
const resume = (src: string | null, over: Record<string, unknown> = {}) => executeLinkedInResume(row(src, resumeBody(over), "linkedin_ads.resume_campaign"));
const raise = (src: string | null, over: Record<string, unknown> = {}) => executeLinkedInBudgetChange(row(src, raiseBody(over), "linkedin_ads.update_campaign_budget"));

describe("a LinkedIn restart holds its daily budget against the ad budget before LinkedIn is called", () => {
  it("cgo: reserves the live daily budget on the bound ledger id, switches it on, then commits", async () => {
    await expect(resume("cgo")).resolves.toMatchObject({ ok: true });
    expect(m.reserve).toHaveBeenCalledTimes(1);
    expect(m.reserve.mock.calls[0][0]).toMatchObject({ id: "ca-1", tenant_id: "t1", exec_source: "channel_actions", approved_by_source: "cgo" });
    expect(m.reserve.mock.calls[0][1]).toEqual({ platform: "linkedin", op: "resume", object_id: "bind-1", daily_delta_usd: 40, currency: "USD" });
    expect(writes()).toHaveLength(1);
    expect(m.commit).toHaveBeenCalledWith(HELD, "bind-1");
    expect(m.reserve.mock.invocationCallOrder[0]).toBeLessThan(m.fetch.mock.invocationCallOrder[m.fetch.mock.calls.findIndex(([, i]) => (i as RequestInit)?.method === "POST")]);
  });

  it("an unbound campaign is held under its LinkedIn id", async () => {
    m.findBinding.mockResolvedValue(null);
    await resume("cgo");
    expect(m.reserve.mock.calls[0][1]).toMatchObject({ object_id: "22" });
    expect(m.commit).toHaveBeenCalledWith(HELD, "22");
  });

  it("must catch: the budget refuses the hold (over the month), so nothing is switched on and nothing is committed", async () => {
    m.reserve.mockResolvedValue({ status: "refused", error: "cap_refuse: ad_budget_over_cap" });
    await expect(resume("cgo")).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_refused" });
    expect(writes()).toHaveLength(0);
    expect(m.commit).not.toHaveBeenCalled();
  });

  it("must catch: cgo with no active budget, a non-USD account, or a total budget is refused before LinkedIn", async () => {
    m.reserve.mockResolvedValue({ status: "no_budget" });
    await expect(resume("cgo")).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_required" });
    m.reserve.mockClear();
    live.dailyBudget = { amount: "40", currencyCode: "EUR" };
    await expect(resume("cgo", { budget: { kind: "daily", amount: "40", currency: "EUR" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_required" });
    live.dailyBudget = { amount: "40", currencyCode: "USD" };
    live.totalBudget = { amount: "900", currencyCode: "USD" };
    await expect(resume("cgo", { budget: { kind: "total", amount: "900", currency: "USD" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_required" });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("the founder's own restart reserves too, and runs as before when no budget is active", async () => {
    m.reserve.mockResolvedValue({ status: "no_budget" });
    await expect(resume(null)).resolves.toMatchObject({ ok: true });
    expect(m.reserve.mock.calls[0][0]).toMatchObject({ approved_by: "owner-1", approved_by_source: null });
    expect(writes()).toHaveLength(1);
  });

  it("the founder's restart of a non-USD campaign is not held as dollars and still runs", async () => {
    live.dailyBudget = { amount: "40", currencyCode: "EUR" };
    await expect(resume(null, { budget: { kind: "daily", amount: "40", currency: "EUR" } })).resolves.toMatchObject({ ok: true });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it("LinkedIn refuses the write: the hold is settled as an error, never committed", async () => {
    refuseWrites = true;
    await expect(resume("cgo")).resolves.toMatchObject({ ok: false });
    expect(m.settle).toHaveBeenCalledWith(HELD, expect.anything());
    expect(m.commit).not.toHaveBeenCalled();
  });
});

describe("a LinkedIn daily raise holds the increase", () => {
  it("cgo: reserves the difference, writes, commits", async () => {
    live.status = "ACTIVE";
    await expect(raise("cgo")).resolves.toMatchObject({ ok: true });
    expect(m.reserve.mock.calls[0][1]).toEqual({ platform: "linkedin", op: "raise", object_id: "bind-1", daily_delta_usd: 20, currency: "USD" });
    expect(writes()).toHaveLength(1);
    expect(m.commit).toHaveBeenCalledWith(HELD, "bind-1");
  });

  it("must catch: a refused raise never reaches LinkedIn", async () => {
    m.reserve.mockResolvedValue({ status: "refused", error: "cap_refuse: ad_budget_over_projection" });
    await expect(raise("cgo")).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_refused" });
    expect(writes()).toHaveLength(0);
  });

  it("a cut holds nothing; a cgo total-budget raise is refused", async () => {
    await expect(raise("cgo", { proposed: { amount: "30.00", currency: "USD" } })).resolves.toMatchObject({ ok: true });
    expect(m.reserve).not.toHaveBeenCalled();
    live.totalBudget = { amount: "500", currencyCode: "USD" };
    await expect(raise("cgo", { kind: "total", expected_current: { amount: "500.00", currency: "USD" }, proposed: { amount: "700.00", currency: "USD" } })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_required" });
    expect(writes()).toHaveLength(1);
  });
});

describe("a cgo-approved paused create holds one day and records Zavi as its maker", () => {
  it("a new campaign: one-day create hold before the create, committed under the new campaign id", async () => {
    const r = await executeLinkedInCreateCampaign(row("cgo", createBody(), "linkedin_ads.create_campaign"));
    expect(r).toMatchObject({ ok: true });
    expect(m.reserve.mock.calls[0][1]).toEqual({ platform: "linkedin", op: "create", object_id: null, daily_delta_usd: 25, currency: "USD", paused: true });
    expect(m.commit).toHaveBeenCalledWith(HELD, "901");
  });

  it("must catch: a refused create hold creates nothing", async () => {
    m.reserve.mockResolvedValue({ status: "refused", error: "cap_refuse: ad_budget_over_cap" });
    await expect(executeLinkedInCreateCampaign(row("cgo", createBody(), "linkedin_ads.create_campaign"))).resolves.toMatchObject({ ok: false, code: "linkedin_ads_budget_refused" });
    expect(writes()).toHaveLength(0);
  });

  it("the founder's own create is unchanged: no hold", async () => {
    await expect(executeLinkedInCreateCampaign(row(null, createBody(), "linkedin_ads.create_campaign"))).resolves.toMatchObject({ ok: true });
    expect(m.reserve).not.toHaveBeenCalled();
  });

  it("a campaign copy holds the source's daily budget and commits under the copy's id", async () => {
    live.status = "ACTIVE";
    const body = { target: "campaign", source_id: "22", account_id: "11", source_name: "Spring", new_name: "Spring copy", group_id: null, campaign_id: null, copy_ads: false, source_last_modified_at: new Date(LAST_MODIFIED).toISOString(), origin: "agent", rationale: "r" };
    await expect(executeLinkedInDuplicate(row("cgo", body, "linkedin_ads.duplicate"))).resolves.toMatchObject({ ok: true });
    expect(m.reserve.mock.calls[0][1]).toEqual({ platform: "linkedin", op: "create", object_id: null, daily_delta_usd: 40, currency: "USD", paused: true });
    expect(m.commit).toHaveBeenCalledWith(HELD, "901");
  });
});
