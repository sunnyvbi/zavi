import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn(), findBinding: vi.fn(), record: vi.fn(), switched: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async () => true, linkedinAccountStoppable: async () => true }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: m.token, forceRefreshConnector: async () => undefined }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding, getAccountBinding: vi.fn() }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: m.record }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: m.switched }));

import { listLinkedInAdAccounts, listLinkedInCampaigns } from "../client";
import { linkedinAdsPost, linkedinRefusalReason } from "../http";
import { executeLinkedInPause } from "../execute-pause";
import { readLinkedInPauseBody } from "@/services/tools/linkedin-ads/propose_pause_campaign";
import { classifyAdReadError } from "@/services/connectors/core/read-error-kind";
import { ExpectedToolError } from "@/services/tools/types";

const RAW = /tenant|HTTP|PAUSED|ACTIVE|ARCHIVED|urn:li|fieldPath|dailyBudget|\b\d{3}\b/;
const answer = (status: number, body: unknown = {}) =>
  ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const caught = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ExpectedToolError;
const writes = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.token.mockResolvedValue("tok");
  m.findBinding.mockResolvedValue(null);
  vi.stubGlobal("fetch", m.fetch);
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});

describe("LinkedIn Ads reads reach the founder in plain words", () => {
  it("says LinkedIn Ads is not connected, without the word tenant, and keeps the code", async () => {
    m.token.mockResolvedValue(null);
    const e = await caught(listLinkedInAdAccounts("t1"));
    expect(e).toMatchObject({ code: "linkedin_ads_not_connected" });
    expect(e.message).toBe("LinkedIn Ads is not connected. Connect it from Connectors in the left menu.");
    expect(e.message).not.toMatch(RAW);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [500, "LinkedIn Ads is not responding right now. Try again in a few minutes.", "vendor_error"],
    [503, "LinkedIn Ads is not responding right now. Try again in a few minutes.", "vendor_error"],
    [429, "LinkedIn Ads is busy right now. Try again in a few minutes.", "rate_limited"],
    [404, "LinkedIn Ads could not answer that request. Try again in a few minutes.", "unknown"],
  ])("a %s read says %s and still classifies by its status", async (status, copy, kind) => {
    m.fetch.mockResolvedValue(answer(status));
    const e = await caught(listLinkedInCampaigns("t1", "11"));
    expect(e).toMatchObject({ code: "linkedin_ads_http_error", meta: { status, http_status: status } });
    expect(e.message).toBe(copy);
    expect(e.message).not.toMatch(RAW);
    expect(classifyAdReadError(e)).toBe(kind);
  });

  it("a 401 that survives the refresh keeps the reconnect code and copy", async () => {
    m.fetch.mockResolvedValue(answer(401));
    const e = await caught(listLinkedInAdAccounts("t1"));
    expect(e).toMatchObject({ code: "linkedin_ads_token_revoked", message: "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu.", meta: { http_status: 401 } });
    expect(e.message).not.toMatch(RAW);
    expect(classifyAdReadError(e)).toBe("auth");
  });

  it.each([
    ["a body that is not JSON", { ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError("x"); } }],
    ["a page with no elements", answer(200, { paging: {} })],
  ])("an answer Zavi cannot read (%s) is a plain try-again", async (_label, r) => {
    m.fetch.mockResolvedValue(r);
    const e = await caught(listLinkedInAdAccounts("t1"));
    expect(e).toMatchObject({ code: "linkedin_ads_bad_response", message: "LinkedIn Ads sent back an answer Zavi could not read. Try again in a few minutes." });
  });
});

describe("LinkedIn Ads writes reach the founder in plain words", () => {
  const reason = { errorDetails: { inputErrors: [{ code: "FIELD_VALUE_TOO_LOW", description: "Daily budget is below the minimum", input: { inputPath: { fieldPath: "dailyBudget/amount" } } }] } };

  it.each([
    [400, "CREATE", "LinkedIn did not accept the campaign settings. Check the budget, dates and audience, then try again."],
    [422, "CREATE", "LinkedIn did not accept the campaign settings. Check the budget, dates and audience, then try again."],
    [409, "CREATE", "LinkedIn did not accept the campaign settings. Check the budget, dates and audience, then try again."],
    [422, "PARTIAL_UPDATE", "LinkedIn did not accept this change. Try again in a few minutes, or make the change in LinkedIn Campaign Manager."],
    [402, "CREATE", "LinkedIn says this ad account has a billing problem. Fix the payment method in LinkedIn Campaign Manager, then try again."],
    [402, "PARTIAL_UPDATE", "LinkedIn says this ad account has a billing problem. Fix the payment method in LinkedIn Campaign Manager, then try again."],
    [429, "CREATE", "LinkedIn Ads is busy right now. Try again in a few minutes."],
  ] as const)("a %s on %s is refused in plain words, with LinkedIn's reason kept off the message", async (status, method, copy) => {
    m.fetch.mockResolvedValueOnce(answer(status, reason));
    const e = await caught(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", method, {}));
    expect(e).toMatchObject({ code: "linkedin_ads_write_refused", meta: { status, http_status: status, linkedin_reason: "dailyBudget/amount: Daily budget is below the minimum" } });
    expect(e.message).toBe(copy);
    expect(e.message).not.toMatch(RAW);
  });

  it("a 5xx write says LinkedIn is not responding, keeps http_status, and never reads the body", async () => {
    const text = vi.fn(async () => "{}");
    m.fetch.mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), text } as unknown as Response);
    const e = await caught(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}));
    expect(e).toMatchObject({ code: "linkedin_ads_http_error", message: "LinkedIn Ads is not responding right now. Try again in a few minutes.", meta: { status: 503, http_status: 503 } });
    expect(e.meta).not.toHaveProperty("linkedin_reason");
    expect(text).not.toHaveBeenCalled();
    expect(classifyAdReadError(e)).toBe("vendor_error");
  });

  it("a 401 write keeps the reconnect code", async () => {
    m.fetch.mockResolvedValueOnce(answer(401));
    await expect(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {})).rejects.toMatchObject({ code: "linkedin_ads_token_revoked", message: "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu." });
  });
});

describe("pausing a campaign that cannot be paused", () => {
  const campaigns = (elements: Array<Record<string, unknown>>, account = "11") =>
    m.fetch.mockImplementation(async (href: string) => {
      const u = new URL(href);
      const one = u.pathname.match(/\/adAccounts\/(\d+)\/adCampaigns\/(\d+)$/);
      if (one) {
        const c = one[1] === "11" ? elements.find((e) => String(e.id) === one[2]) : undefined;
        return c ? answer(200, { account: `urn:li:sponsoredAccount:${account}`, ...c }) : answer(404);
      }
      return answer(200, { elements: elements.slice(0, 100), metadata: elements.length > 100 ? { nextPageToken: "p2" } : {} });
    });
  const pause = () => readLinkedInPauseBody("t1", { campaign_id: "22", account_id: "11", rationale: "r" });
  const others = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `Other ${i}`, status: "ACTIVE" }));
  const gets = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST").map(([href]) => new URL(href as string).pathname);

  it("files the card for a campaign the first 100 search results would miss, by reading it directly", async () => {
    campaigns([...others, { id: 22, name: "Spring", status: "ACTIVE" }]);
    await expect(pause()).resolves.toEqual({ campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring", rationale: "r" });
    expect(gets()).toEqual(["/rest/adAccounts/11/adCampaigns/22"]);
  });

  it("Approve pauses a campaign the first 100 search results would miss", async () => {
    campaigns([...others, { id: 22, name: "Spring", status: "ACTIVE" }]);
    const r = await executeLinkedInPause({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" } });
    expect(r).toEqual({ ok: true, notice: "Paused \"Spring\" in LinkedIn Ads." });
    expect(writes().map(([href]) => new URL(href as string).pathname)).toEqual(["/rest/adAccounts/11/adCampaigns/22"]);
  });

  it("refuses a campaign LinkedIn files under another account and sends no write", async () => {
    campaigns([{ id: 22, name: "Spring", status: "ACTIVE" }], "99");
    expect(await caught(pause())).toMatchObject({ code: "linkedin_ads_campaign_not_found" });
    const r = await executeLinkedInPause({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" } });
    expect(r).toMatchObject({ ok: false, code: "linkedin_ads_campaign_checking", error: expect.stringContaining('LinkedIn could not find "Spring" just now') });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["already paused", [{ id: 22, name: "Spring", status: "PAUSED" }], "\"Spring\" is already paused."],
    ["archived", [{ id: 22, name: "Spring", status: "ARCHIVED" }], "\"Spring\" is not running, so there is nothing to pause."],
    ["unnamed and paused", [{ id: 22, status: "PAUSED" }], "This campaign is already paused."],
    ["unnamed and completed", [{ id: 22, status: "COMPLETED" }], "This campaign is not running, so there is nothing to pause."],
  ])("the card refuses a campaign that is %s in plain words and files nothing", async (_label, elements, copy) => {
    campaigns(elements);
    const e = await caught(pause());
    expect(e).toMatchObject({ code: "linkedin_ads_campaign_not_active", message: copy });
    expect(e.message).not.toMatch(RAW);
    expect(m.record).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("a campaign that left the account is refused without its ids", async () => {
    campaigns([]);
    const e = await caught(pause());
    expect(e).toMatchObject({ code: "linkedin_ads_campaign_not_found", message: "This campaign is no longer in your LinkedIn Ads account. Refresh the campaign list, then try again." });
    expect(e.message).not.toMatch(/22|11/);
  });

  it.each([
    [{ campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" }, "LinkedIn shows \"Spring\" already ended, so there was nothing to pause."],
    [{ campaign_id: "22", account_id: "11", status: "PAUSED", name: "22" }, "LinkedIn shows this campaign already ended, so there was nothing to pause."],
  ])("Approve on a campaign that ended says so plainly, closes the card and sends LinkedIn no write", async (body, copy) => {
    campaigns([{ id: 22, name: body.name, status: "ARCHIVED" }]);
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r).toEqual({ ok: true, notice: copy });
    expect(r.notice).not.toMatch(RAW);
    expect(writes()).toHaveLength(0);
  });

  it("Approve on a damaged card says so plainly and makes no LinkedIn call", async () => {
    const r = await executeLinkedInPause({ tenant_id: "t1", body: { campaign_id: "22" } });
    expect(r).toEqual({ ok: false, code: "linkedin_ads_body_invalid", error: "This pause card is missing details, so Zavi did not change anything. Dismiss it and ask for the pause again." });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("Approve when LinkedIn is down says so plainly and sends no write", async () => {
    m.fetch.mockResolvedValue(answer(502));
    const r = await executeLinkedInPause({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" } });
    expect(r).toEqual({ ok: false, code: "linkedin_ads_http_error", error: "LinkedIn Ads is not responding right now. Try again in a few minutes." });
    expect(writes()).toHaveLength(0);
  });
});

describe("LinkedIn's refusal reason survives every shape of reply it sends", () => {
  const said = (body: unknown) => linkedinRefusalReason({ text: async () => JSON.stringify(body) });
  const rule = "/Campaign/totalBudget/amount cannot be set to 10; it cannot be lower than /Campaign/dailyBudget/amount 50";

  it.each<[string, unknown, string]>([
    ["input errors", { errorDetails: { inputErrors: [{ code: "CONDITIONAL_VALUE_TOO_LOW", description: rule, input: { inputPath: { fieldPath: "totalBudget/amount" } } }] } }, `totalBudget/amount: ${rule}`],
    ["an input error with only a code", { errorDetails: { inputErrors: [{ code: "CONDITIONAL_VALUE_TOO_LOW", input: { inputPath: { fieldPath: "totalBudget/amount" } } }] } }, "totalBudget/amount: CONDITIONAL_VALUE_TOO_LOW"],
    ["an errors list", { errors: [{ code: "CONDITIONAL_VALUE_TOO_LOW", message: rule }] }, rule],
    ["an errors list with only a code", { errors: [{ code: "CONDITIONAL_VALUE_TOO_LOW", field: "totalBudget/amount" }] }, "totalBudget/amount: CONDITIONAL_VALUE_TOO_LOW"],
    ["a bare message", { message: rule, status: 400 }, rule],
    ["a bare code", { code: "CONDITIONAL_VALUE_TOO_LOW", status: 400 }, "CONDITIONAL_VALUE_TOO_LOW"],
  ])("reads %s", async (_label, body, reason) => {
    expect(await said(body)).toBe(reason);
  });

  it.each<[string, unknown]>([
    ["inputErrors that is not a list", { errorDetails: { inputErrors: { code: "X" } } }],
    ["errors that is not a list", { errors: "nope" }],
    ["a list holding nulls", { errors: [null], errorDetails: { inputErrors: [null] } }],
  ])("%s is no reason, not a crash", async (_label, body) => {
    expect(await said(body)).toBeNull();
  });

  it("a malformed refusal on a write stays a clean refusal, so nothing is mistaken for a write that may have landed", async () => {
    m.fetch.mockResolvedValueOnce(answer(422, { errorDetails: { inputErrors: { code: "X" } } }));
    const e = await caught(linkedinAdsPost("tok", "adAccounts/11/adCampaigns/22", "PARTIAL_UPDATE", {}));
    expect(e).toMatchObject({ code: "linkedin_ads_write_refused", meta: { http_status: 422 } });
  });

  it("the documented refusal carries its reason out of a real write", async () => {
    m.fetch.mockResolvedValueOnce(answer(400, { errors: [{ code: "CONDITIONAL_VALUE_TOO_LOW", message: rule }] }));
    const e = await caught(linkedinAdsPost("tok", "adAccounts/11/adCampaigns/22", "PARTIAL_UPDATE", {}));
    expect(e.meta?.linkedin_reason).toBe(rule);
    expect(e.message).not.toContain("dailyBudget");
  });
});
