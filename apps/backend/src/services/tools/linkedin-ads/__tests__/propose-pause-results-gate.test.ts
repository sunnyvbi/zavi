import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), accountBinding: vi.fn(), boundCampaign: vi.fn(), record: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async () => true, linkedinAccountStoppable: async () => true }));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async () => "tenant-tok",
  forceRefreshConnector: vi.fn(),
  markConnectorTokenRevoked: vi.fn(),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding, getAccountBinding: m.accountBinding }));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ linkedinCampaign: m.boundCampaign }));

import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { linkedinAdsProposePauseCampaignTool, readLinkedInPauseBody } from "../propose_pause_campaign";
import { buildLinkedInExecCardBody, type LinkedInStatusBody } from "../_exec-action";

type Row = { pivotValues: string[]; impressions?: number; clicks?: number; costInLocalCurrency?: string; externalWebsiteConversions?: number; oneClickLeads?: number };
const URN = "urn:li:sponsoredCampaign:22";
const campaign = { id: 22, name: "Spring", status: "ACTIVE", account: "urn:li:sponsoredAccount:11" };
const row = (over: Partial<Row> = {}): Row => ({ pivotValues: [URN], impressions: 4000, clicks: 60, costInLocalCurrency: "420.50", externalWebsiteConversions: 0, oneClickLeads: 0, ...over });
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const down = () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({}), text: async () => "down" });

let windowAnswer: () => unknown;
let historyAnswer: () => unknown;
const analyticsCalls = () => m.fetch.mock.calls.filter(([u]) => String(u).includes("adAnalytics"));

const spanDays = (url: string) => {
  const [, sy, sm, sd, ey, em, ed] = url.match(/start:\(year:(\d+),month:(\d+),day:(\d+)\),end:\(year:(\d+),month:(\d+),day:(\d+)\)/) as string[];
  return (Date.UTC(+ey, +em - 1, +ed) - Date.UTC(+sy, +sm - 1, +sd)) / 86_400_000;
};
const propose = (rationale = "$420 over 30 days, 0 signups on this link's utm_campaign") =>
  linkedinAdsProposePauseCampaignTool.execute({ tenant_id: "t1", log: () => {}, emit_decision: m.record } as never, { campaign_id: "22", account_id: "11", rationale });

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.record.mockResolvedValue("card-1");
  windowAnswer = () => ok({ elements: [row()] });
  historyAnswer = () => ok({ elements: [row({ externalWebsiteConversions: 3 })] });
  m.fetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("adCampaigns/22")) return ok(campaign);
    return spanDays(u) > 90 ? historyAnswer() : windowAnswer();
  });
  vi.stubGlobal("fetch", m.fetch);
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  vi.unstubAllGlobals();
});

describe("the pause tool decides from LinkedIn's results, not from the rationale it was handed", () => {
  it("files the card for a real pause candidate, with the rationale untouched", async () => {
    await expect(propose()).resolves.toMatchObject({ action_id: "card-1" });
    expect(m.record).toHaveBeenCalledWith("linkedin_ads.set_status", expect.objectContaining({ campaign_id: "22", status: "PAUSED", rationale: "$420 over 30 days, 0 signups on this link's utm_campaign" }));
  });

  it.each([
    ["conversions from a post with no tracked link", () => ok({ elements: [row({ externalWebsiteConversions: 5 })] }), "has_results"],
    ["lead-form leads only", () => ok({ elements: [row({ oneClickLeads: 2 })] }), "has_results"],
    ["a suppressed conversions metric", () => ok({ elements: [row({ externalWebsiteConversions: undefined })] }), "metrics_unread"],
    ["no spend in the window", () => ok({ elements: [row({ costInLocalCurrency: "0" })] }), "no_spend"],
    ["no analytics row at all", () => ok({ elements: [] }), "metrics_unread"],
    ["a row that belongs to another campaign", () => ok({ elements: [row({ pivotValues: ["urn:li:sponsoredCampaign:23"] })] }), "metrics_unread"],
  ])("refuses with no card on %s", async (_label, answer, signal) => {
    windowAnswer = answer;
    await expect(propose()).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate", meta: { pause_signal: signal } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("must catch: a measured year with no result is unverified tracking, so no card", async () => {
    historyAnswer = () => ok({ elements: [row()] });
    await expect(propose()).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate", meta: { pause_signal: "tracking_unverified" } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("must catch: history that failed to read is unknown tracking, so no card", async () => {
    historyAnswer = down;
    await expect(propose()).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate", meta: { pause_signal: "tracking_history_unread" } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("must catch: another campaign's results in the history answer prove nothing about this one", async () => {
    historyAnswer = () => ok({ elements: [row({ pivotValues: ["urn:li:sponsoredCampaign:23"], externalWebsiteConversions: 9 })] });
    await expect(propose()).rejects.toMatchObject({ meta: { pause_signal: "tracking_history_unread" } });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("a window read that fails still files the card, and the card tells the founder the results were not re-read", async () => {
    windowAnswer = down;
    await expect(propose("Founder-facing reason")).resolves.toMatchObject({ action_id: "card-1" });
    const body = m.record.mock.calls[0][1] as { rationale: string };
    expect(body.rationale).toContain("Founder-facing reason");
    expect(body.rationale).toContain("could not re-read this campaign's results");
  });

  it("asks only about this campaign, over the same 30 days the recipe reads", async () => {
    await propose();
    const [first] = analyticsCalls();
    expect(String(first[0])).toContain("campaigns=List(urn%3Ali%3AsponsoredCampaign%3A22)");
    expect(spanDays(String(first[0]))).toBe(29);
  });

  it("a wallet campaign's results are read with its own token, never the tenant's", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", account_binding_id: "ab1" });
    m.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    m.boundCampaign.mockResolvedValue({ token: "wallet-tok", campaign: { id: "22", name: "Spring", status: "ACTIVE" } });
    windowAnswer = () => ok({ elements: [row({ externalWebsiteConversions: 5 })] });
    await expect(propose()).rejects.toMatchObject({ meta: { pause_signal: "has_results" } });
    const calls = analyticsCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer wallet-tok");
  });

  it("must catch: the founder's own pause button is never gated by results and reads no analytics", async () => {
    windowAnswer = () => ok({ elements: [row({ externalWebsiteConversions: 5 })] });
    await expect(readLinkedInPauseBody("t1", { campaign_id: "22", account_id: "11", rationale: "Founder asked" })).resolves.toMatchObject({ campaign_id: "22", status: "PAUSED", rationale: "Founder asked" });
    expect(analyticsCalls()).toHaveLength(0);
  });
});

describe("a founder's direct order to pause does not need a pause_candidate, and nothing else gets past it", () => {
  const hasResults = () => { windowAnswer = () => ok({ elements: [row({ externalWebsiteConversions: 5 })] }); };
  const proposeAs = (ctx: Record<string, unknown>) =>
    linkedinAdsProposePauseCampaignTool.execute({ tenant_id: "t1", log: () => {}, emit_decision: m.record, ...ctx } as never, { campaign_id: "22", account_id: "11", rationale: "The founder asked to pause Spring." });

  it.each([
    ["a founder's typed chat order", { run_trigger: "chat", founder_chat_order: true }],
    ["its handoff child", { run_trigger: "handoff", founder_chat_order: true }],
    ["a founder's top-action press", { run_trigger: "manual", top_action_run: true }],
  ])("%s files the card on a campaign that is working, and spends no read on it", async (_label, ctx) => {
    hasResults();
    await expect(proposeAs(ctx)).resolves.toMatchObject({ action_id: "card-1", status: "waiting_for_founder" });
    expect(m.record).toHaveBeenCalledWith("linkedin_ads.set_status", expect.objectContaining({ status: "PAUSED", rationale: "The founder asked to pause Spring." }));
    expect(analyticsCalls()).toHaveLength(0);
  });

  it.each([
    ["the agent's own scheduled run", { run_trigger: "cron" }],
    ["the agent's own manual run", { run_trigger: "manual" }],
    ["a handoff with no founder order", { run_trigger: "handoff" }],
    ["a founder mark that could not be verified", { run_trigger: "handoff", founder_chat_order: true, founder_order_unverified: true }],
    ["a turn a standing rule steered, not the founder's words", { run_trigger: "chat", founder_chat_order: true, rules_steered: { budget: false, status: true } }],
    ["a turn carrying a captured web page", { run_trigger: "chat", founder_chat_order: true, untrusted_context: true }],
  ])("%s stays refused on a campaign with results, and files no card", async (_label, ctx) => {
    hasResults();
    await expect(proposeAs(ctx)).rejects.toMatchObject({ code: "linkedin_ads_pause_not_candidate" });
    expect(m.record).not.toHaveBeenCalled();
  });

  it("an order still cannot pause a campaign that is not running", async () => {
    m.fetch.mockImplementation(async () => ok({ ...campaign, status: "PAUSED" }));
    await expect(proposeAs({ run_trigger: "chat", founder_chat_order: true })).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_active" });
    expect(m.record).not.toHaveBeenCalled();
  });
});

describe("Flow 44: a pause card on a shared-wallet campaign never sends the founder to Campaign Manager", () => {
  const walletBound = () => {
    m.findBinding.mockResolvedValue({ id: "b1", account_binding_id: "ab1", funding_source: "wallet" });
    m.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    m.boundCampaign.mockResolvedValue({ token: "wallet-tok", campaign: { id: "22", name: "Spring", status: "ACTIVE" } });
  };
  it("the wallet card's sentence, rationale and link name no Campaign Manager and no LinkedIn ad account URL", async () => {
    walletBound();
    windowAnswer = down;
    await propose("Founder-facing reason");
    const payload = m.record.mock.calls[0][1] as LinkedInStatusBody;
    expect(payload.funding_source).toBe("wallet");
    expect(payload.rationale).toContain("could not re-read this campaign's results");
    const { card } = buildLinkedInExecCardBody(payload);
    const text = JSON.stringify(card);
    expect(text).not.toMatch(/Campaign Manager|linkedin\.com/);
    expect(card.link).toBe("/channels/linkedin_ads");
    expect(card.change_sentence).toContain("paid from your Zavi wallet");
  });
  it("an own-billing card keeps its Campaign Manager sentence, results note and link", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", account_binding_id: "ab1", funding_source: "provider" });
    m.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    m.boundCampaign.mockResolvedValue({ token: "own-tok", campaign: { id: "22", name: "Spring", status: "ACTIVE" } });
    windowAnswer = down;
    await propose("Founder-facing reason");
    const payload = m.record.mock.calls[0][1] as LinkedInStatusBody;
    expect(payload).not.toHaveProperty("funding_source");
    expect(payload.rationale).toContain("in LinkedIn Campaign Manager before approving");
    const { card } = buildLinkedInExecCardBody(payload);
    expect(card.link).toBe("https://www.linkedin.com/campaignmanager/accounts/11/campaigns/22/summary");
    expect(card.change_sentence).toBe('Zavi pauses "Spring" in LinkedIn Campaign Manager. It stops spending until someone turns it back on.');
  });
});
