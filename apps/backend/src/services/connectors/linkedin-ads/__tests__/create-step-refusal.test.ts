import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn(), save: vi.fn() }));
vi.mock("@/services/ads-wallet/accounts", () => ({
  accountChoices: async () => ({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: null }),
  connectCustomerAccount: async () => "binding",
  assertAccountAvailableForNewCampaign: async () => {},
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async () => ({ id: "binding" }), bindCampaign: async () => ({ id: "campaign-binding" }) }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: async () => ({ token: "secret-access-token-abc", account: { id: "11", currency: "USD", reference: "urn:li:organization:42" } }) }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (v: string) => v, tenantClient: () => ({ from: () => ({ insert: mocks.save, upsert: mocks.save, update: () => ({ eq: mocks.save }) }) }) }));

import { LINKEDIN_ADS_BILLING, LINKEDIN_ADS_BUSY, LINKEDIN_ADS_RECONNECT, LINKEDIN_ADS_SETTINGS_REFUSED, LINKEDIN_ADS_UNAVAILABLE, linkedinAdsPost } from "../http";
import { createLinkedInCampaignBundle, type LinkedInCampaignBundle } from "../write";
import type { LinkedInCreationJournal, LinkedInCreationProgress } from "../creation-progress";

const bundle: LinkedInCampaignBundle = {
  group: { name: "First test" },
  campaign: { name: "Pilot", daily_budget: { amount: "18", currency: "USD" }, unit_cost: { amount: "6", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:42" },
  creative: { post_urn: "urn:li:share:7000000000000000001" },
};

const ok = (status: number, id?: string) => ({ ok: true, status, headers: new Headers(id ? { "x-restli-id": id } : {}), json: async () => ({}) }) as unknown as Response;
const refused = (status: number, body: unknown) =>
  ({ ok: false, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function journal(): LinkedInCreationJournal {
  let state: LinkedInCreationProgress = { version: 1, payload_hash: "fixture", account_binding_id: null, group_id: null, campaign_id: null, creative_id: null, group_paused: false, in_flight: null };
  return { get state() { return state; }, get retryable() { return state.in_flight === null; }, async save(next) { state = structuredClone(next); } };
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.save.mockReset().mockResolvedValue({ error: null });
  mocks.post.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001", author: "urn:li:organization:42" }) });
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (String(url).startsWith("https://api.linkedin.com/rest/posts/") ? mocks.post(url, init) : mocks.fetch(url, init)));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("names the ad step and LinkedIn's own reason when the ad create is refused, not the campaign settings", async () => {
  mocks.fetch
    .mockResolvedValueOnce(ok(201, "600"))
    .mockResolvedValueOnce(ok(204))
    .mockResolvedValueOnce(ok(201, "700"))
    .mockResolvedValueOnce(refused(400, { status: 400, message: "Validation failed", errorDetails: { inputErrors: [{ code: "INVALID_VALUE", description: "Post urn:li:share:7000000000000000001 is not eligible for sponsorship token=AQV8x9Zk2LmQ7rT5wYp3", input: { inputPath: { fieldPath: "intendedStatus" } } }] } }));
  const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
  expect(e.code).toBe("linkedin_ads_write_refused");
  expect(e.message.startsWith("LinkedIn did not accept the ad, the last step of this campaign")).toBe(true);
  expect(e.message).toContain("intendedStatus: Post a LinkedIn item is not eligible for sponsorship");
  expect(e.message).not.toContain("campaign settings");
  expect(e.message).not.toMatch(/7000000000000000001|AQV8x9Zk2LmQ7rT5wYp3|secret-access-token|urn:li:/);
  expect(e.meta).toMatchObject({ made: expect.objectContaining({ group_id: "600", campaign_id: "700" }), linkedin_reason: expect.stringContaining("not eligible for sponsorship") });
});

it("a campaign-step refusal still names the campaign settings, now with LinkedIn's reason", async () => {
  mocks.fetch
    .mockResolvedValueOnce(ok(201, "600"))
    .mockResolvedValueOnce(ok(204))
    .mockResolvedValueOnce(refused(422, { errorDetails: { inputErrors: [{ description: "Daily budget is below the minimum for this account", input: { inputPath: { fieldPath: "dailyBudget/amount" } } }] } }));
  const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
  expect(e.code).toBe("linkedin_ads_write_refused");
  expect(e.message).toBe(`${LINKEDIN_ADS_SETTINGS_REFUSED} LinkedIn said: "dailyBudget/amount: Daily budget is below the minimum for this account".`);
  expect(e.message).not.toMatch(/\bad\b|campaign group/);
});

it("a campaign-group refusal names the campaign group", async () => {
  mocks.fetch.mockResolvedValueOnce(refused(400, { message: "runSchedule.start is required" }));
  const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
  expect(e.message).toBe(`LinkedIn did not accept the campaign group, the first step of this campaign. LinkedIn said: "runSchedule.start is required".`);
});

it("keeps the plain campaign-settings copy when LinkedIn gives no reason for the campaign step", async () => {
  mocks.fetch
    .mockResolvedValueOnce(ok(201, "600"))
    .mockResolvedValueOnce(ok(204))
    .mockResolvedValueOnce({ ok: false, status: 400, headers: new Headers(), text: async () => "<html>Bad Request</html>" } as unknown as Response);
  const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
  expect(e.message).toBe(LINKEDIN_ADS_SETTINGS_REFUSED);
});

it("the ad step's status-transition refusal names the ad and never blames the budget, dates or audience", async () => {
  mocks.fetch
    .mockResolvedValueOnce(ok(201, "600"))
    .mockResolvedValueOnce(ok(204))
    .mockResolvedValueOnce(ok(201, "700"))
    .mockResolvedValueOnce(refused(400, { status: 400, message: "/Creative/status transition is not allowed from null to PAUSED if /Creative/review/reviewStatus is not set to APPROVED." }));
  const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
  expect(e.code).toBe("linkedin_ads_write_refused");
  expect(e.message).toBe(`LinkedIn did not accept the ad, the last step of this campaign, for this campaign's post. LinkedIn said: "/Creative/status transition is not allowed from null to PAUSED if /Creative/review/reviewStatus is not set to APPROVED.".`);
  expect(e.message).not.toMatch(/budget|dates|audience|campaign settings/);
  const creativeCall = mocks.fetch.mock.calls[3];
  expect(String(creativeCall[0])).toBe("https://api.linkedin.com/rest/adAccounts/11/creatives");
});

it("the HTTP layer names the step it was given for any create refusal", async () => {
  const body = { message: "/Creative/status transition is not allowed" };
  mocks.fetch.mockResolvedValueOnce(refused(400, body)).mockResolvedValueOnce(refused(409, body)).mockResolvedValueOnce(refused(422, {}));
  const ad = await linkedinAdsPost("tok", "adAccounts/11/creatives", "CREATE", {}, "ad").catch((x) => x);
  const group = await linkedinAdsPost("tok", "adAccounts/11/adCampaignGroups", "CREATE", {}, "campaign group").catch((x) => x);
  const campaign = await linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}, "campaign").catch((x) => x);
  expect(ad.message).toBe(`LinkedIn did not accept the ad, the last step of this campaign, for this campaign's post. LinkedIn said: "/Creative/status transition is not allowed".`);
  expect(group.message).toBe(`LinkedIn did not accept the campaign group, the first step of this campaign. LinkedIn said: "/Creative/status transition is not allowed".`);
  expect(campaign.message).toBe(LINKEDIN_ADS_SETTINGS_REFUSED);
  expect([ad.code, group.code, campaign.code]).toEqual(["linkedin_ads_write_refused", "linkedin_ads_write_refused", "linkedin_ads_write_refused"]);
});

it("keeps reconnect, busy, unavailable and billing copy on the ad step", async () => {
  mocks.fetch
    .mockResolvedValueOnce(refused(401, {}))
    .mockResolvedValueOnce(refused(429, {}))
    .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), text: async () => "" } as unknown as Response)
    .mockResolvedValueOnce(refused(402, { message: "Account has no credit" }));
  const said: string[] = [];
  for (let i = 0; i < 4; i++) said.push((await linkedinAdsPost(`tok-${i}`, "adAccounts/11/creatives", "CREATE", {}, "ad").catch((x) => x)).message);
  expect(said).toEqual([LINKEDIN_ADS_RECONNECT, LINKEDIN_ADS_BUSY, LINKEDIN_ADS_UNAVAILABLE, LINKEDIN_ADS_BILLING]);
});

it("a campaign refused on every retry leaves one paused group, reused, and never creates a second", async () => {
  const groupPosts: unknown[] = [];
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/adCampaignGroups") && init?.method === "POST") { groupPosts.push(init.body); return ok(201, "600"); }
    if (href.endsWith("/adCampaignGroups/600") && init?.method === "POST") return ok(204);
    if (href.endsWith("/adCampaignGroups/600")) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: 600, account: "urn:li:sponsoredAccount:11", name: "First test", status: "PAUSED" }) } as unknown as Response;
    if (href.endsWith("/adCampaigns") && init?.method === "POST") return refused(422, { errorDetails: { inputErrors: [{ description: "Bid is below the minimum", input: { inputPath: { fieldPath: "unitCost/amount" } } }] } });
    throw new Error(`unexpected call ${href}`);
  });
  const progress = journal();
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress).catch((x) => x);
    expect(e.code).toBe("linkedin_ads_write_refused");
    expect(e.meta.made).toMatchObject({ group_id: "600", campaign_id: null });
  }
  expect(groupPosts).toHaveLength(1);
  expect(progress.state).toMatchObject({ group_id: "600", group_paused: true, campaign_id: null, in_flight: null });
});
