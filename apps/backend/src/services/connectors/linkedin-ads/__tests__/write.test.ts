
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn(), bind:vi.fn(), save:vi.fn(), resolve:vi.fn(), post: vi.fn(), page: vi.fn(), choices: vi.fn(), order: [] as string[] }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: mocks.token }));

vi.mock("@/services/ads-wallet/accounts",()=>({accountChoices:mocks.choices,connectCustomerAccount:async()=>"binding",assertAccountAvailableForNewCampaign:async()=>{}}));
vi.mock("@/services/ads-wallet/bindings",()=>({getAccountBinding:async()=>({id:"binding"}),bindCampaign:mocks.bind}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account",()=>({resolveLinkedinAccount:mocks.resolve}));
vi.mock("@/services/tenant-client",()=>({asTenantId:(v:string)=>v,tenantClient:()=>({from:()=>({insert:mocks.save,upsert:mocks.save,update:()=>({eq:mocks.save})})})}));

import { linkedinAdsGet, linkedinAdsPost, linkedinCreativePath } from "../http";
import { AD_REFUSED_MEMBER_POST, CHANGED_IN_LINKEDIN, createLinkedInCampaignBundle, POST_MISSING, LINKEDIN_ACCOUNT_DISABLED, NOTHING_SENT, pauseLinkedInCampaign, POST_AUTHOR_REFUSED, type LinkedInCampaignBundle } from "../write";
import type { LinkedInCreationJournal, LinkedInCreationProgress } from "../creation-progress";

type Call = { url: string; init: RequestInit };
const calls = (): Call[] => mocks.fetch.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
const bodyOf = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;
const resp = (status: number, id?: string) =>
  ({ ok: status < 400, status, headers: new Headers(id ? { "x-restli-id": id } : {}), json: async () => ({}) }) as unknown as Response;

const bundle: LinkedInCampaignBundle = {
  group: { name: "First test" },
  campaign: {
    name: "Pilot",
    daily_budget: { amount: "18", currency: "USD" },
    unit_cost: { amount: "6", currency: "USD" },
    geo_urns: ["urn:li:geo:103644278"],
    country: "US",
    language: "en",
    associated_entity: "urn:li:organization:42",
  },
  creative: { post_urn: "urn:li:share:7000000000000000001" },
};

it.each(["titles", "seniorities"])("submits the reviewed %s, industry and company-size audience to LinkedIn", async roleFacet => {
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "800"));
  const audience = { titles: roleFacet === "titles" ? ["urn:li:title:1", "urn:li:title:2"] : [], seniorities: roleFacet === "seniorities" ? ["urn:li:seniority:7"] : [], industries: ["urn:li:industry:4"], staffCountRanges: ["urn:li:staffCountRange:(51,200)"] };
  await createLinkedInCampaignBundle("t1", "11", { ...bundle, campaign: { ...bundle.campaign, audience } });
  const campaign = calls().find(c => c.url.endsWith("/adCampaigns"));
  const criteria = bodyOf(campaign!).targetingCriteria as { include: { and: unknown[] } };
  expect(criteria.include.and).toHaveLength(5);
  expect(criteria.include.and).toContainEqual({ or: { [`urn:li:adTargetingFacet:${roleFacet}`]: audience[roleFacet as "titles" | "seniorities"] } });
  expect(criteria.include.and).toContainEqual({ or: { "urn:li:adTargetingFacet:staffCountRanges": audience.staffCountRanges } });
});

function journal(): LinkedInCreationJournal {
  let state: LinkedInCreationProgress = { version: 1, payload_hash: "fixture", account_binding_id: null, group_id: null, campaign_id: null, creative_id: null, group_paused: false, in_flight: null };
  return { get state() { return state; }, get retryable() { return state.in_flight === null; }, async save(next) { state = structuredClone(next); } };
}

const groupRead = () => ({ ok: true, json: async () => ({ id: 600, account: "urn:li:sponsoredAccount:11", status: "PAUSED", name: "First test" }) });
function campaignRead() {
  const sent = calls().find(c => c.url.endsWith("/adCampaigns") && c.init.method === "POST");
  if (!sent) throw new Error("No campaign was created in the first attempt");
  const body = bodyOf(sent);
  return { ok: true, json: async () => ({ id: 700, ...body }) };
}

describe("the promoted post must come from the ad account's page", () => {
  it.each([["another company page", "urn:li:organization:99"], ["a company page whose id starts with the account's", "urn:li:organization:420"], ["a Showcase page", "urn:li:organizationBrand:99"]])("creates no group, campaign or ad for a post from %s", async (_label, author) => {
    mocks.post.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001", author }) });
    mocks.fetch.mockResolvedValue(resp(201, "600"));
    const progress = journal();
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch" });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001"]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(progress.state).toMatchObject({ account_binding_id: null, group_id: null, in_flight: null });
  });

  const allThree = ["POST adAccounts/11/adCampaignGroups", "POST adAccounts/11/adCampaignGroups/600", "POST adAccounts/11/adCampaigns", "POST adAccounts/11/creatives"];
  const creates = () => mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));

  it.each([[403, "the post-author read is outside Zavi's scopes"], [404, "LinkedIn cannot find the post for this member"], [500, "LinkedIn is having a bad moment"]])("goes ahead with every create when the post read answers %s (%s), leaving LinkedIn's creative check as the backstop", async (status) => {
    mocks.post.mockResolvedValue({ ok: false, status, json: async () => ({}) });
    creates();
    expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree]);
  });

  it("goes ahead when the post read never answers at all", async () => {
    mocks.post.mockRejectedValue(new TypeError("fetch failed"));
    creates();
    expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([["a Thought Leader post by a member", "urn:li:person:abc"], ["no author", undefined], ["an author LinkedIn shapes oddly", { urn: "urn:li:organization:99" }]])("leaves %s for LinkedIn to judge and creates all three", async (_label, author) => {
    mocks.post.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001", author }) });
    creates();
    expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree]);
  });

  const unconfirmedPost = () => mocks.post.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001" }) });
  const refusal = (status: number, body: unknown) =>
    ({ ok: false, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  const postReason = { errorDetails: { inputErrors: [{ description: "The share's author is not allowed for this campaign", input: { inputPath: { fieldPath: "content.reference" } } }] } };
  const refusedAd = (r: Response = refusal(400, postReason)) => mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(r);
  const archives = ["POST adAccounts/11/adCampaigns/700", "POST adAccounts/11/adCampaignGroups/600"];

  it("archives the paused campaign and group it just made when LinkedIn refuses the ad for another page's post", async () => {
    unconfirmedPost();
    refusedAd();
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e).toMatchObject({
      code: POST_AUTHOR_REFUSED,
      message: "LinkedIn refused the ad for this post, and Zavi could not confirm who published it. LinkedIn only runs posts from the page this ad account advertises for, or a member's post that page may sponsor. Zavi archived the paused campaign and campaign group it had just made, so nothing can spend. Paste a post from that page, or a member's post, and approve a new campaign.",
      meta: expect.objectContaining({ made: expect.objectContaining({ group_id: "600", campaign_id: "700" }), archived: { campaign: true, group: true }, linkedin_reason: "content.reference: The share's author is not allowed for this campaign" }),
    });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree, ...archives]);
    expect(bodyOf(calls()[4])).toEqual({ patch: { $set: { status: "ARCHIVED" } } });
    expect(bodyOf(calls()[5])).toEqual({ patch: { $set: { status: "ARCHIVED" } } });
  });

  it.each([
    ["the token cannot read the post (403)", () => mocks.post.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })],
    ["the post read never answers", () => mocks.post.mockRejectedValue(new TypeError("fetch failed"))],
    ["the post has no author", () => mocks.post.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001" }) })],
  ])("archives the paused campaign and group when LinkedIn refuses the ad for a post whose author Zavi could not confirm because %s", async (_label, unread) => {
    unread();
    refusedAd();
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    const progress = journal();
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: POST_AUTHOR_REFUSED, meta: expect.objectContaining({ archived: { campaign: true, group: true } }) });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree, ...archives]);
    expect(bodyOf(calls()[4])).toEqual({ patch: { $set: { status: "ARCHIVED" } } });
    expect(bodyOf(calls()[5])).toEqual({ patch: { $set: { status: "ARCHIVED" } } });
    expect(progress.state).toMatchObject({ group_id: "600", campaign_id: "700", archived: true });
  });

  it.each([
    ["its error code", { errorDetails: { inputErrors: [{ code: "DIRECT_SPONSORED_CONTENT_MISMATCH" }] } }],
    ["its message", { message: "Direct Sponsored Content is not created by the account" }],
  ])("archives on LinkedIn's direct sponsored content mismatch, named by %s", async (_label, body) => {
    unconfirmedPost();
    refusedAd(refusal(400, body));
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).rejects.toMatchObject({ code: POST_AUTHOR_REFUSED });
    expect(mocks.order.slice(-2)).toEqual(archives);
  });

  it("on Try again, still reads the post and archives what it made when LinkedIn refuses the ad for another page's post", async () => {
    unconfirmedPost();
    const progress = journal();
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(422));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
    expect(progress.state).toMatchObject({ group_id: "600", campaign_id: null, in_flight: null });
    mocks.fetch.mockReset();
    mocks.order.length = 0;
    mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(refusal(400, postReason)).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: POST_AUTHOR_REFUSED, meta: expect.objectContaining({ archived: { campaign: true, group: true } }) });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", "GET adAccounts/11/adCampaignGroups/600", "POST adAccounts/11/adCampaigns", "POST adAccounts/11/creatives", ...archives]);
    expect(progress.state).toMatchObject({ group_id: "600", campaign_id: "700", archived: true });
  });

  it("answers a Try again on an archived setup plainly, with no LinkedIn call", async () => {
    unconfirmedPost();
    refusedAd();
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    const progress = journal();
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: POST_AUTHOR_REFUSED });
    expect(progress.state).toMatchObject({ group_id: "600", campaign_id: "700", archived: true, in_flight: null });
    const before = mocks.order.length;
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: POST_AUTHOR_REFUSED });
    expect(mocks.order.length).toBe(before);
  });

  it.each([
    ["a billing hold", refusal(402, postReason), "linkedin_ads_write_refused"],
    ["a conflict", refusal(409, postReason), "linkedin_ads_write_refused"],
    ["the account role (403)", refusal(403, postReason), "linkedin_ads_forbidden"],
    ["a 422 about the account, not the post", refusal(422, { message: "/status: account on hold" }), "linkedin_ads_write_refused"],
    ["a 422 that only mentions sponsored content", refusal(422, { errorDetails: { inputErrors: [{ description: "Account is not enabled for sponsored content", input: { inputPath: { fieldPath: "account" } } }] } }), "linkedin_ads_write_refused"],
    ["a 400 with no reason", resp(400), "linkedin_ads_write_refused"],
  ])("keeps the setup for Try again when LinkedIn refuses the ad for %s", async (_label, answer, code) => {
    unconfirmedPost();
    refusedAd(answer as Response);
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).rejects.toMatchObject({ code });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree]);
  });

  it("says the empty group stays paused when only the campaign could be archived", async () => {
    unconfirmedPost();
    refusedAd();
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(500));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e).toMatchObject({ code: POST_AUTHOR_REFUSED, meta: expect.objectContaining({ archived: { campaign: true, group: false } }) });
    expect(e.message).toContain("the empty campaign group stays paused");
  });

  it("keeps LinkedIn's refusal (and the Campaign Manager path) when the campaign cannot be archived", async () => {
    unconfirmedPost();
    refusedAd();
    mocks.fetch.mockResolvedValueOnce(resp(500));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).rejects.toMatchObject({ code: "linkedin_ads_write_refused" });
    expect(mocks.order.slice(-1)).toEqual(["POST adAccounts/11/adCampaigns/700"]);
  });

  it("keeps a refused Thought Leader post's campaign for a retry once the member allows it", async () => {
    mocks.post.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001", author: "urn:li:person:abc" }) });
    refusedAd();
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).rejects.toMatchObject({ code: "linkedin_ads_write_refused" });
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree]);
  });

  it("on a 403 for a member's post, says LinkedIn refused the ad, not the account role, keeps LinkedIn's reason and keeps the setup", async () => {
    mocks.post.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001", author: "urn:li:person:abc" }) });
    refusedAd(refusal(403, { message: "Not enough permissions to sponsor this member's post" }));
    const progress = journal();
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress).catch((x) => x);
    expect(e).toMatchObject({ code: "linkedin_ads_forbidden", meta: expect.objectContaining({ linkedin_reason: "Not enough permissions to sponsor this member's post", http_status: 403 }) });
    expect(e.message).toMatch(/would not use this member's post as its ad/);
    expect(e.message).not.toMatch(/Campaign Manager|Account Manager/);
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree]);
    expect(progress.state).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null, in_flight: null });
  });

  it("on a 403 for a page post, names the post as the refused part and not the account role", async () => {
    unconfirmedPost();
    refusedAd(refusal(403, {}));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e.code).toBe("linkedin_ads_forbidden");
    expect(e.message).toMatch(/would not use this post as its ad/);
    expect(e.message).not.toMatch(/Campaign Manager|Account Manager/);
    expect(e.meta.linkedin_reason).toBeUndefined();
  });

  it("keeps the account-role message when the 403 comes on the campaign, before any ad", async () => {
    unconfirmedPost();
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(refusal(403, { message: "Member lacks role" }));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e.code).toBe("linkedin_ads_forbidden");
    expect(e.message).toMatch(/Campaign Manager/);
    expect(e.meta.linkedin_reason).toBe("Member lacks role");
  });

  it("hands a 401 on the post read back as token_revoked so the refresh wrapper can retry, creating nothing", async () => {
    mocks.post.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const progress = journal();
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(progress.state).toMatchObject({ account_binding_id: null, group_id: null });
  });

  it("reads the post with the account's own token before the first create, then creates all three", async () => {
    mocks.resolve.mockResolvedValue({ token: "managed-tok", account: { id: "11", currency: "USD", reference: "urn:li:organization:42" } });
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
    expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
    expect(mocks.order).toEqual([
      "GET posts/urn%3Ali%3Ashare%3A7000000000000000001",
      "POST adAccounts/11/adCampaignGroups",
      "POST adAccounts/11/adCampaignGroups/600",
      "POST adAccounts/11/adCampaigns",
      "POST adAccounts/11/creatives",
    ]);
    expect((mocks.post.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer managed-tok" });
  });
});

it("resumes a refused campaign create using the saved group, without making another group", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(422));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  expect(progress.state).toMatchObject({ group_id: "600", group_paused: true, in_flight: null });
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 600, account: "urn:li:sponsoredAccount:11", status: "PAUSED", name: "First test" }) })
    .mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
  expect(calls().filter(c => c.init.method === "POST").map(c => c.url)).toEqual([
    "https://api.linkedin.com/rest/adAccounts/11/adCampaigns", "https://api.linkedin.com/rest/adAccounts/11/creatives",
  ]);
});

it("never repeats a campaign create whose response was lost: another attempt finds it in Zavi's own group first", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockRejectedValueOnce(new Error("timeout"));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  expect(progress.state).toMatchObject({ group_id: "600", in_flight: "campaign_id" });
  const campaign = campaignRead();
  mocks.fetch.mockReset();
  mocks.fetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ elements: [{ id: 700, campaignGroup: "urn:li:sponsoredCampaignGroup:600" }] }) })
    .mockResolvedValueOnce(groupRead())
    .mockResolvedValueOnce(campaign)
    .mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
  expect(calls().filter(c => c.init.method === "POST").map(c => c.url)).toEqual(["https://api.linkedin.com/rest/adAccounts/11/creatives"]);
  expect(calls()[0].url).toContain("adAccounts/11/adCampaigns?q=search");
});

it("never repeats a campaign group create whose response was lost", async () => {
  const progress = journal();
  mocks.fetch.mockRejectedValueOnce(new Error("timeout"));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  expect(progress.state).toMatchObject({ group_id: null, in_flight: "group_id" });
  mocks.fetch.mockReset();
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("resumes a refused creative without recreating its group or paused campaign", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(422));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  expect(progress.state).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null, in_flight: null });
  const campaign = campaignRead();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce(campaign).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).toMatchObject({ campaign_id: "700", creative_id: "800" });
  expect(calls().filter(c => c.init.method === "POST").map(c => c.url)).toEqual(["https://api.linkedin.com/rest/adAccounts/11/creatives"]);
});

it("repairs a lost inventory save using confirmed objects, with no additional creates", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  mocks.save.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "offline" } });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  expect(progress.state).toMatchObject({ creative_id: "800", in_flight: null });
  const campaign = campaignRead();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce(campaign).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "urn:li:sponsoredCreative:800", campaign: "urn:li:sponsoredCampaign:700", content: { reference: bundle.creative.post_urn }, intendedStatus: "DRAFT" }) });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).resolves.toMatchObject({ creative_id: "800" });
  expect(calls().every(c => !c.init.method || c.init.method === "GET")).toBe(true);
});

it.each(["DRAFT", "PAUSED"])("creates the ad DRAFT, never PAUSED, and a retry accepts that ad read back as %s", async readBack => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  mocks.save.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "offline" } });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  const adCreate = calls().filter(c => c.init.method === "POST" && c.url.endsWith("/creatives"));
  expect(adCreate).toHaveLength(1);
  expect(bodyOf(adCreate[0]).intendedStatus).toBe("DRAFT");
  expect(String(adCreate[0].init.body)).not.toContain("PAUSED");
  const campaign = campaignRead();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce(campaign).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "urn:li:sponsoredCreative:800", campaign: "urn:li:sponsoredCampaign:700", content: { reference: bundle.creative.post_urn }, intendedStatus: readBack }) });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).resolves.toMatchObject({ creative_id: "800" });
  expect(calls().every(c => !c.init.method || c.init.method === "GET")).toBe(true);
});

it("non-regression guard: stops on a retry once the draft ad was switched on in LinkedIn", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  mocks.save.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "offline" } });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  const adCreate = calls().filter(c => c.init.method === "POST" && c.url.endsWith("/creatives"));
  expect(adCreate).toHaveLength(1);
  const campaign = campaignRead();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce(campaign).mockResolvedValueOnce({ ok: true, json: async () => ({ id: "urn:li:sponsoredCreative:800", campaign: "urn:li:sponsoredCampaign:700", content: { reference: bundle.creative.post_urn }, intendedStatus: "ACTIVE" }) });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial", message: "The ad Zavi made was switched on or archived in LinkedIn, outside Zavi." });
  expect(calls().every(c => !c.init.method || c.init.method === "GET")).toBe(true);
});

it("refuses to continue if an existing group was moved to another account", async () => {
  const progress = journal();
  await progress.save({ ...progress.state, account_binding_id: "binding", group_id: "600", group_paused: true });
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 600, account: "urn:li:sponsoredAccount:99", name: "First test", status: "PAUSED" }) });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial" });
  expect(calls().every(c => !c.init.method || c.init.method === "GET")).toBe(true);
});

it("stops before sending any create when checkpoint storage is unavailable", async () => {
  const progress = journal();
  progress.save = async () => { throw new Error("checkpoint offline"); };
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow("checkpoint offline");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("keeps a successful create with a missing ID uncertain, rather than creating it again", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
  expect(progress.state.in_flight).toBe("group_id");
  mocks.fetch.mockReset();
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("does not repeat a successful create whose checkpoint could not be saved", async () => {
  const progress = journal();
  const save = progress.save;
  progress.save = async next => {
    if (next.group_id) throw new Error("checkpoint offline");
    await save(next);
  };
  mocks.fetch.mockResolvedValueOnce(resp(201, "600"));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial", meta: { made: { group_id: "600" }, progress_unsaved: "group_id" } });
  expect(progress.state.in_flight).toBe("group_id");
  mocks.fetch.mockReset();
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

const founderEdits: Array<[string, (c: Record<string, unknown>) => void]> = [
  ["name", c => { c.name = "Pilot (renamed)"; }],
  ["daily budget", c => { c.dailyBudget = { amount: "999", currencyCode: "USD" }; }],
  ["bid", c => { c.unitCost = { amount: "11.50", currencyCode: "USD" }; c.costType = "CPM"; }],
  ["audience", c => { c.targetingCriteria = { include: { and: [] } }; }],
  ["locale and delivery settings", c => { c.locale = { country: "GB", language: "en" }; c.audienceExpansionEnabled = true; c.offsiteDeliveryEnabled = true; c.creativeSelection = "ROUND_ROBIN"; }],
];

it.each(founderEdits)("resumes a saved campaign after the founder edits its %s in LinkedIn, adding only the draft ad", async (_label, edit) => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(422));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  const c: Record<string, unknown> = await campaignRead().json();
  edit(c);
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 600, account: "urn:li:sponsoredAccount:11", status: "PAUSED", name: "Renamed group" }) }).mockResolvedValueOnce({ ok: true, json: async () => c }).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
  const sent = calls().filter(x => x.init.method === "POST");
  expect(sent.map(x => x.url)).toEqual(["https://api.linkedin.com/rest/adAccounts/11/creatives"]);
  expect(bodyOf(sent[0])).toEqual({ campaign: "urn:li:sponsoredCampaign:700", content: { reference: bundle.creative.post_urn }, intendedStatus: "DRAFT" });
});

const unsafeEdits: Array<[string, (c: Record<string, unknown>) => void, string]> = [
  ["switched on", c => { c.status = "ACTIVE"; }, "The campaign Zavi made is no longer paused in LinkedIn, outside Zavi."],
  ["archived", c => { c.status = "ARCHIVED"; }, "The campaign Zavi made is no longer paused in LinkedIn, outside Zavi."],
  ["moved to another group", c => { c.campaignGroup = "urn:li:sponsoredCampaignGroup:601"; }, "The campaign Zavi made was moved to another ad account, campaign group or company page in LinkedIn, outside Zavi."],
  ["moved to another account", c => { c.account = "urn:li:sponsoredAccount:12"; }, "The campaign Zavi made was moved to another ad account, campaign group or company page in LinkedIn, outside Zavi."],
  ["pointed at another company page", c => { c.associatedEntity = "urn:li:organization:99"; }, "The campaign Zavi made was moved to another ad account, campaign group or company page in LinkedIn, outside Zavi."],
  ["answered with another campaign id", c => { c.id = 701; }, "The campaign Zavi made was moved to another ad account, campaign group or company page in LinkedIn, outside Zavi."],
  ["billed in another currency", c => { c.dailyBudget = { amount: "18", currencyCode: "EUR" }; }, "The campaign Zavi made was moved to another ad account, campaign group or company page in LinkedIn, outside Zavi."],
];

it.each(unsafeEdits)("does not resume a saved campaign that was %s in LinkedIn, and creates nothing", async (_label, edit, message) => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(422));
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toThrow();
  const c: Record<string, unknown> = await campaignRead().json();
  edit(c);
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce({ ok: true, json: async () => c });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial", message, meta: { [CHANGED_IN_LINKEDIN]: true } });
  expect(calls().every(x => !x.init.method || x.init.method === "GET")).toBe(true);
});

it.each([["switched on", "ACTIVE"], ["archived", "ARCHIVED"]])("does not resume when the paused campaign group was %s in LinkedIn", async (_label, status) => {
  const progress = journal();
  await progress.save({ ...progress.state, account_binding_id: "binding", group_id: "600", group_paused: true });
  mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 600, account: "urn:li:sponsoredAccount:11", name: "First test", status }) });
  await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: "exec_partial", message: "The campaign group Zavi made was switched on or archived in LinkedIn, outside Zavi.", meta: { [CHANGED_IN_LINKEDIN]: true } });
  expect(calls().every(x => !x.init.method || x.init.method === "GET")).toBe(true);
});

beforeEach(() => {
  mocks.token.mockReset().mockResolvedValue("tok");
  mocks.fetch.mockReset();
  mocks.bind.mockReset().mockResolvedValue({id:"campaign-binding"});
  mocks.save.mockReset().mockResolvedValue({error:null});
  mocks.resolve.mockReset().mockResolvedValue({token:"tok",account:{id:"11",currency:"USD",reference:"urn:li:organization:42"}});
  mocks.post.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "urn:li:share:7000000000000000001", author: "urn:li:organization:42" }) });
  mocks.choices.mockReset().mockResolvedValue({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: null });
  mocks.order.length = 0;
  mocks.page.mockReset().mockRejectedValue(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (String(url).startsWith("https://www.linkedin.com/")) return mocks.page(url, init);
    mocks.order.push(`${init?.method ?? "GET"} ${String(url).replace("https://api.linkedin.com/rest/", "")}`);
    return String(url).startsWith("https://api.linkedin.com/rest/posts/") ? mocks.post(url, init) : mocks.fetch(url, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("linkedinAdsPost", () => {
  it("sends the Rest.li write headers and returns the x-restli-id", async () => {
    mocks.fetch.mockResolvedValue(resp(201, "987"));
    const r = await linkedinAdsPost("tok", "adAccounts/11/adCampaignGroups", "CREATE", { name: "g" });
    expect(r.id).toBe("987");
    const [c] = calls();
    expect(c.url).toBe("https://api.linkedin.com/rest/adAccounts/11/adCampaignGroups");
    const h = c.init.headers as Record<string, string>;
    expect(h["X-RestLi-Method"]).toBe("CREATE");
    expect(h["Linkedin-Version"]).toBe("202608");
    expect(h["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(h["Content-Type"]).toBe("application/json");
    expect(c.init.method).toBe("POST");
  });

  it("refuses a path outside the module alphabet before any network call", async () => {
    await expect(linkedinAdsPost("tok", "adAccounts/../oops", "CREATE", {})).rejects.toMatchObject({ code: "linkedin_ads_bad_path" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("maps 401/403 to the reconnect/scope error and 4xx writes to a refusal with the status", async () => {
    mocks.fetch.mockResolvedValueOnce(resp(403));
    await expect(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {})).rejects.toMatchObject({ code: "linkedin_ads_forbidden" });
    mocks.fetch.mockResolvedValueOnce(resp(401));
    await expect(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {})).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
    mocks.fetch.mockResolvedValueOnce(resp(422));
    await expect(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {})).rejects.toMatchObject({
      code: "linkedin_ads_write_refused",
      meta: expect.objectContaining({ status: 422 }),
    });
    mocks.fetch.mockResolvedValueOnce(resp(409));
    await expect(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {})).rejects.toMatchObject({
      code: "linkedin_ads_write_refused",
      meta: expect.objectContaining({ status: 409 }),
    });
  });
});

describe("linkedinAdsPost refusal reason", () => {
  const refusal = (status: number, body: string) =>
    ({ ok: false, status, headers: new Headers(), text: async () => body, json: async () => JSON.parse(body) }) as unknown as Response;

  it("keeps LinkedIn's own field and reason on the refusal's meta, off the founder's message", async () => {
    mocks.fetch.mockResolvedValueOnce(refusal(400, JSON.stringify({
      status: 400,
      message: "Validation failed",
      errorDetails: { inputErrors: [
        { code: "FIELD_VALUE_TOO_LOW", description: "Daily budget is below the minimum for this account", input: { inputPath: { fieldPath: "dailyBudget/amount" } } },
        { code: "INVALID_VALUE", input: { inputPath: { fieldPath: "locale" } } },
      ] },
    })));
    const err = await linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}).catch((e) => e);
    expect(err).toMatchObject({ code: "linkedin_ads_write_refused", meta: expect.objectContaining({ status: 400, linkedin_reason: "dailyBudget/amount: Daily budget is below the minimum for this account; locale: INVALID_VALUE" }) });
    expect(err.message).toBe("LinkedIn did not accept the campaign settings. Check the budget, dates and audience, then try again.");
  });

  it("falls back to LinkedIn's top-level message, flattens control characters and caps the length", async () => {
    mocks.fetch.mockResolvedValueOnce(refusal(422, JSON.stringify({ message: `Account\nis\u0000on hold ${"x".repeat(600)}` })));
    const err = await linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}).catch((e) => e);
    const reason = err.meta.linkedin_reason;
    expect(reason.startsWith("Account is on hold x")).toBe(true);
    expect(reason).toHaveLength(400);
    expect(reason.endsWith("…")).toBe(true);
    expect(reason).not.toMatch(/[\u0000-\u001f]/);
  });

  it("gives the plain refusal with no reason when LinkedIn's body is not JSON, and never reads the body of a 5xx", async () => {
    mocks.fetch.mockResolvedValueOnce(refusal(400, "<html>Bad Request</html>"));
    const bare = await linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {}).catch((e) => e);
    expect(bare).toMatchObject({ code: "linkedin_ads_write_refused", message: "LinkedIn did not accept the campaign settings. Check the budget, dates and audience, then try again." });
    expect(bare.meta).not.toHaveProperty("linkedin_reason");
    const text = vi.fn(async () => JSON.stringify({ message: "upstream" }));
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), text } as unknown as Response);
    await expect(linkedinAdsPost("tok", "adAccounts/11/adCampaigns", "CREATE", {})).rejects.toMatchObject({ code: "linkedin_ads_http_error", message: "LinkedIn Ads is not responding right now. Try again in a few minutes.", meta: { status: 503, http_status: 503 } });
    expect(text).not.toHaveBeenCalled();
  });
});

describe("pauseLinkedInCampaign", () => {
  it("PARTIAL_UPDATEs the campaign to PAUSED", async () => {
    mocks.fetch.mockResolvedValue(resp(204));
    await pauseLinkedInCampaign("t1", "11", "22");
    const [c] = calls();
    expect(c.url).toBe("https://api.linkedin.com/rest/adAccounts/11/adCampaigns/22");
    expect((c.init.headers as Record<string, string>)["X-RestLi-Method"]).toBe("PARTIAL_UPDATE");
    expect(bodyOf(c)).toEqual({ patch: { $set: { status: "PAUSED" } } });
  });

  it("refuses non-numeric ids before any network call", async () => {
    await expect(pauseLinkedInCampaign("t1", "11", "22/33")).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("createLinkedInCampaignBundle", () => {
  it.each(["0", "0.00"])("must catch: an approved card with a bid of %s reaches no LinkedIn endpoint and saves nothing", async (amount) => {
    const journal = { state: {}, save: vi.fn(async () => undefined) };
    await expect(createLinkedInCampaignBundle("t1", "11", { ...bundle, campaign: { ...bundle.campaign, unit_cost: { amount, currency: "USD" } } }, undefined, journal as never)).rejects.toMatchObject({ code: "linkedin_ads_bid_invalid" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(journal.save).not.toHaveBeenCalled();
  });

  it.each([
    ["GB", "urn:li:geo:101165590"],
    ["CA", "urn:li:geo:101174742"],
    ["IN", "urn:li:geo:102713980"],
  ])("sends LinkedIn's supported en_US locale for an English campaign targeting %s, keeping that country's geo", async (country, geo) => {
    mocks.fetch
      .mockResolvedValueOnce(resp(201, "600"))
      .mockResolvedValueOnce(resp(204))
      .mockResolvedValueOnce(resp(201, "700"))
      .mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
    await createLinkedInCampaignBundle("t1", "11", { ...bundle, campaign: { ...bundle.campaign, country, geo_urns: [geo] } });
    const cb = bodyOf(calls()[2]);
    expect(cb.locale).toEqual({ country: "US", language: "en" });
    const facets = (cb.targetingCriteria as { include: { and: Array<{ or: Record<string, string[]> }> } }).include.and.map((c) => c.or);
    expect(facets).toContainEqual({ "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] });
    expect(facets).toContainEqual({ "urn:li:adTargetingFacet:locations": [geo] });
    expect(JSON.stringify(cb)).not.toContain(`en_${country}`);
  });

  it("creates the group ACTIVE then pauses it (a PAUSED campaign is refused inside a DRAFT group), campaign PAUSED, creative DRAFT", async () => {
    mocks.fetch
      .mockResolvedValueOnce(resp(201, "600"))
      .mockResolvedValueOnce(resp(204))
      .mockResolvedValueOnce(resp(201, "700"))
      .mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
    const r = await createLinkedInCampaignBundle("t1", "11", bundle);
    expect(r).toEqual({ group_id: "600", campaign_id: "700", creative_id: "urn:li:sponsoredCreative:800" });

    const [group, groupPause, campaign, creative] = calls();
    expect(group.url).toContain("adAccounts/11/adCampaignGroups");
    const g = bodyOf(group);
    expect(g.status).toBe("ACTIVE");
    expect(groupPause.url).toBe("https://api.linkedin.com/rest/adAccounts/11/adCampaignGroups/600");
    expect((groupPause.init.headers as Record<string, string>)["X-RestLi-Method"]).toBe("PARTIAL_UPDATE");
    expect(bodyOf(groupPause)).toEqual({ patch: { $set: { status: "PAUSED" } } });
    expect((g.runSchedule as { start?: number }).start).toBeTypeOf("number");
    expect(g.account).toBe("urn:li:sponsoredAccount:11");

    expect(campaign.url).toContain("adAccounts/11/adCampaigns");
    const cb = bodyOf(campaign);
    expect(cb.status).toBe("PAUSED");
    expect(cb.campaignGroup).toBe("urn:li:sponsoredCampaignGroup:600");
    expect(cb.dailyBudget).toEqual({ amount: "18", currencyCode: "USD" });
    expect(cb.audienceExpansionEnabled).toBe(false);
    expect(cb.offsiteDeliveryEnabled).toBe(false);
    expect(cb.associatedEntity).toBe("urn:li:organization:42");
    expect(cb.politicalIntent).toBe("NOT_DECLARED");
    const facets = (cb.targetingCriteria as { include: { and: Array<{ or: Record<string, string[]> }> } }).include.and.map((c) => c.or);
    expect(facets).toContainEqual({ "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] });
    expect(facets.some((f) => Array.isArray(f["urn:li:adTargetingFacet:locations"]) && f["urn:li:adTargetingFacet:locations"].length > 0)).toBe(true);
    expect(cb.locale).toEqual({ country: "US", language: "en" });

    expect(creative.url).toContain("adAccounts/11/creatives");
    const cr = bodyOf(creative);
    expect(cr.intendedStatus).toBe("DRAFT");
    expect(cr.campaign).toBe("urn:li:sponsoredCampaign:700");
    expect(cr.content).toEqual({ reference: "urn:li:share:7000000000000000001" });

    for (const c of [campaign, creative]) expect(String(c.init.body)).not.toContain("ACTIVE");
  });

  it("a failure mid-bundle reports what was already created and creates nothing twice", async () => {
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(422));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle)).rejects.toMatchObject({
      code: "linkedin_ads_write_refused",
      meta: expect.objectContaining({ made: { group_id: "600", campaign_id: null, creative_id: null } }),
    });
    expect(calls()).toHaveLength(3);
  });

  it("a group that cannot be paused stops the bundle before any campaign exists under an active group", async () => {
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(422));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle)).rejects.toMatchObject({
      code: "linkedin_ads_write_refused",
      meta: expect.objectContaining({ made: { group_id: "600", campaign_id: null, creative_id: null } }),
    });
    expect(calls()).toHaveLength(2);
    expect(calls().some((c) => c.url.endsWith("/adCampaigns"))).toBe(false);
  });

  it("a create that returns no x-restli-id stops the bundle rather than guessing an id", async () => {
    mocks.fetch.mockResolvedValueOnce(resp(201));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle)).rejects.toMatchObject({ code: "linkedin_ads_bad_response" });
    expect(calls()).toHaveLength(1);
  });
});

describe("createLinkedInCampaignBundle: error meta (F2)", () => {
  it("a network error mid-bundle still carries the created ids as meta.made", async () => {
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle)).rejects.toMatchObject({
      code: "linkedin_ads_outcome_unknown",
      meta: expect.objectContaining({ made: { group_id: "600", campaign_id: null, creative_id: null } }),
    });
    expect(calls()).toHaveLength(3);
  });

  it("a network error on the first create carries empty made and the outcome-unknown code", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(createLinkedInCampaignBundle("t1", "11", bundle)).rejects.toMatchObject({
      code: "linkedin_ads_outcome_unknown",
      meta: expect.objectContaining({ made: { group_id: null, campaign_id: null, creative_id: null } }),
    });
  });
});

it("does not create when a pinned account has changed",async()=>{
 mocks.resolve.mockResolvedValue({token:"tok",account:{id:"12",currency:"USD",reference:"urn:li:organization:42"}});
 await expect(createLinkedInCampaignBundle("t1","11",bundle,"binding")).rejects.toMatchObject({code:"ads_account_mismatch"});
 expect(mocks.fetch).not.toHaveBeenCalled();
});
it("retains partial creation evidence when saving the campaign identity fails",async()=>{
 mocks.fetch.mockResolvedValueOnce(resp(201,"600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201,"700"));
 mocks.bind.mockRejectedValue(new Error("storage down"));
 await expect(createLinkedInCampaignBundle("t1","11",bundle)).rejects.toMatchObject({code:"linkedin_ads_outcome_unknown",message:"LinkedIn made the paused campaign, but Zavi could not finish saving its setup.",meta:{made:{group_id:"600",campaign_id:"700",creative_id:null}}});
 expect(calls()).toHaveLength(3);
});
it("leaves the campaign's launch row with no ad when LinkedIn fails the ad create",async()=>{
 mocks.fetch.mockResolvedValueOnce(resp(201,"600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201,"700")).mockResolvedValueOnce(resp(503));
 await expect(createLinkedInCampaignBundle("t1","11",bundle,undefined,journal())).rejects.toMatchObject({meta:{made:{group_id:"600",campaign_id:"700",creative_id:null}}});
 expect(mocks.save.mock.calls.map(c=>c[0])).toEqual([expect.objectContaining({campaign_binding_id:"campaign-binding",provider_group_id:"600"})]);
 expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("provider_creative_ids");
});

describe("the encoded sponsoredCreative path segment", () => {
  const encoded = "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A120491345";

  it("builds the URL-encoded creative URN LinkedIn's creatives API addresses", () => {
    expect(linkedinCreativePath("42", "120491345")).toBe(encoded);
    for (const [a, c] of [["42", "urn:li:sponsoredCreative:1"], ["42", "1/../2"], ["4x", "1"], ["42", ""]]) {
      expect(() => linkedinCreativePath(a, c)).toThrow(/invalid API resource path/);
    }
  });

  it("GET and PARTIAL_UPDATE reach LinkedIn with the segment still encoded", async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "urn:li:sponsoredCreative:120491345" }) } as unknown as Response);
    await linkedinAdsGet("tok", encoded);
    mocks.fetch.mockResolvedValueOnce(resp(204));
    await linkedinAdsPost("tok", encoded, "PARTIAL_UPDATE", { patch: { $set: { intendedStatus: "PAUSED" } } });
    expect(calls().map((c) => c.url)).toEqual([
      `https://api.linkedin.com/rest/${encoded}`,
      `https://api.linkedin.com/rest/${encoded}`,
    ]);
  });

  it.each([
    "adAccounts/42/creatives/urn:li:sponsoredCreative:1",
    "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A1%2F..%2Fx",
    "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A1/x",
    "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A",
    "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A1?x=1",
    "adAccounts/42/adCampaigns/urn%3Ali%3AsponsoredCampaign%3A1",
    "adAccounts/42/creatives/urn%3Ali%3AsponsoredCreative%3A1%00",
    "adAccounts/%34%32/creatives/urn%3Ali%3AsponsoredCreative%3A1",
    "%2e%2e/creatives/urn%3Ali%3AsponsoredCreative%3A1",
    "adAccounts/42/creatives/urn%3ali%3asponsoredCreative%3a1",
    "adAccounts:42",
  ])("refuses %s on GET and POST before any network call", async (path) => {
    await expect(linkedinAdsGet("tok", path)).rejects.toMatchObject({ code: "linkedin_ads_bad_path" });
    await expect(linkedinAdsPost("tok", path, "PARTIAL_UPDATE", {})).rejects.toMatchObject({ code: "linkedin_ads_bad_path" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

const withExclusions: LinkedInCampaignBundle = { ...bundle, campaign: { ...bundle.campaign, geo_urns: ["urn:li:geo:103644278", "urn:li:geo:101174742"], excluded_geo_urns: ["urn:li:geo:102095887"] } };

it("sends included places in include and excluded places in exclude, never mixed", async () => {
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "800"));
  await createLinkedInCampaignBundle("t1", "11", withExclusions);
  const criteria = bodyOf(calls().find(c => c.url.endsWith("/adCampaigns"))!).targetingCriteria as { include: { and: Array<{ or: Record<string, string[]> }> }; exclude: unknown };
  expect(criteria.include.and[0]).toEqual({ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278", "urn:li:geo:101174742"] } });
  expect(criteria.exclude).toEqual({ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:102095887"] } });
  expect(JSON.stringify(criteria.include)).not.toContain("102095887");
});

it("sends no exclude block when nothing is excluded", async () => {
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "800"));
  await createLinkedInCampaignBundle("t1", "11", { ...bundle, campaign: { ...bundle.campaign, excluded_geo_urns: [] } });
  expect(bodyOf(calls().find(c => c.url.endsWith("/adCampaigns"))!).targetingCriteria).not.toHaveProperty("exclude");
});

it("resumes a campaign with exclusions without creating it twice", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(422));
  await expect(createLinkedInCampaignBundle("t1", "11", withExclusions, undefined, progress)).rejects.toThrow();
  const campaign = campaignRead();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce(campaign).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  await expect(createLinkedInCampaignBundle("t1", "11", withExclusions, undefined, progress)).resolves.toMatchObject({ campaign_id: "700", creative_id: "800" });
  expect(calls().filter(c => c.init.method === "POST").map(c => c.url)).toEqual(["https://api.linkedin.com/rest/adAccounts/11/creatives"]);
});

it("resumes a saved campaign whose exclusions the founder dropped in LinkedIn, adding only the draft ad", async () => {
  const progress = journal();
  mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(422));
  await expect(createLinkedInCampaignBundle("t1", "11", withExclusions, undefined, progress)).rejects.toThrow();
  const c: Record<string, unknown> = await campaignRead().json();
  delete (c.targetingCriteria as Record<string, unknown>).exclude;
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValueOnce(groupRead()).mockResolvedValueOnce({ ok: true, json: async () => c }).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
  await expect(createLinkedInCampaignBundle("t1", "11", withExclusions, undefined, progress)).resolves.toMatchObject({ campaign_id: "700", creative_id: "800" });
  expect(calls().filter(x => x.init.method === "POST").map(x => x.url)).toEqual(["https://api.linkedin.com/rest/adAccounts/11/creatives"]);
});

describe("an ad account the founder turned off", () => {
  const off = () => mocks.choices.mockResolvedValue({ accounts: [{ id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: true }], managed: [], selected_id: null });

  it("refuses the launch before any LinkedIn call, in plain words, marked as nothing sent", async () => {
    off();
    const progress = journal();
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress).catch((x) => x);
    expect(e).toMatchObject({ code: LINKEDIN_ACCOUNT_DISABLED, meta: { [NOTHING_SENT]: true } });
    expect(e.message).toBe("You turned this ad account off in Zavi with Stop using this account. Nothing was created in LinkedIn. Turn it back on with Use this account again, or review the campaign with another account, then approve it again.");
    expect(mocks.order).toEqual([]);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(progress.state).toMatchObject({ account_binding_id: null, group_id: null });
  });

  it("refuses a Try again on a saved setup before touching LinkedIn", async () => {
    const progress = journal();
    await progress.save({ ...progress.state, account_binding_id: "binding", group_id: "600", group_paused: true });
    off();
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: LINKEDIN_ACCOUNT_DISABLED });
    expect(mocks.order).toEqual([]);
  });

  it("a turned-off account elsewhere in the workspace does not block this one", async () => {
    mocks.choices.mockResolvedValue({ accounts: [{ id: "other", platform: "linkedin", provider_account_id: "12", funding_source: "provider", currency: "USD", disabled: true }, { id: "binding", platform: "linkedin", provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: null });
    mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(resp(201, "urn:li:sponsoredCreative:800"));
    expect(await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal())).toEqual({ group_id: "600", campaign_id: "700", creative_id: "800" });
  });
});

describe("Create reads the post's author the way the review does", () => {
  const POST_PAGE = "https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001/";
  const personPage = () => ({ ok: true, status: 200, url: POST_PAGE, text: async () => `<script type="application/ld+json">{"@type":"SocialMediaPosting","author":{"@type":"Person","name":"Asha"},"articleBody":"Personal post."}</script>` });
  const gonePage = () => ({ ok: false, status: 404, url: POST_PAGE, text: async () => "" });
  const refusal = (status: number, body: unknown) =>
    ({ ok: false, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
  const postReason = { errorDetails: { inputErrors: [{ description: "The share's author is not allowed for this campaign", input: { inputPath: { fieldPath: "content.reference" } } }] } };
  const upToAd = (ad: Response) => mocks.fetch.mockResolvedValueOnce(resp(201, "600")).mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(201, "700")).mockResolvedValueOnce(ad);
  const allThree = ["POST adAccounts/11/adCampaignGroups", "POST adAccounts/11/adCampaignGroups/600", "POST adAccounts/11/adCampaigns", "POST adAccounts/11/creatives"];

  it("names a person's post the posts API cannot read as a Thought Leader refusal, not the page role or a private post", async () => {
    mocks.post.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    mocks.page.mockResolvedValue(personPage());
    upToAd(refusal(403, { message: "organizationUgcAuthorizations denied" }));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e).toMatchObject({ code: "linkedin_ads_forbidden", message: AD_REFUSED_MEMBER_POST });
    expect(mocks.page).toHaveBeenCalledWith(POST_PAGE, expect.anything());
  });

  it("never archives a person's post as another page's when the posts API answers 400, and keeps the setup for a retry", async () => {
    mocks.post.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    mocks.page.mockResolvedValue(personPage());
    upToAd(refusal(400, postReason));
    const progress = journal();
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress).catch((x) => x);
    expect(e.code).toBe("linkedin_ads_write_refused");
    expect(e.message).not.toMatch(/different page|another company page/);
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", ...allThree]);
    expect(progress.state).toMatchObject({ group_id: "600", campaign_id: "700", creative_id: null });
    expect(progress.state.archived).toBeUndefined();
  });

  it("does not claim another page wrote a post whose author Zavi could not read at all", async () => {
    mocks.post.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    upToAd(refusal(400, postReason));
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e.code).toBe(POST_AUTHOR_REFUSED);
    expect(e.message).not.toMatch(/different page|another company page/);
    expect(e.message).toMatch(/could not confirm who published it/);
  });

  it("archives the paused group and campaign when the post was deleted before Try again, closes the card and makes no ad", async () => {
    const progress = journal();
    await progress.save({ ...progress.state, account_binding_id: "binding", group_id: "600", campaign_id: "700", group_paused: true });
    mocks.post.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    mocks.page.mockResolvedValue(gonePage());
    mocks.fetch.mockResolvedValueOnce(resp(204)).mockResolvedValueOnce(resp(204));
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress).catch((x) => x);
    expect(e).toMatchObject({ code: POST_AUTHOR_REFUSED, meta: expect.objectContaining({ [POST_MISSING]: true, archived: { campaign: true, group: true } }) });
    expect(e.message).toMatch(/no longer on LinkedIn/);
    expect(e.message).not.toMatch(/paste it again|Check the link/i);
    expect(mocks.order).toEqual(["GET posts/urn%3Ali%3Ashare%3A7000000000000000001", "POST adAccounts/11/adCampaigns/700", "POST adAccounts/11/adCampaignGroups/600"]);
    expect(calls().map(bodyOf)).toEqual([{ patch: { $set: { status: "ARCHIVED" } } }, { patch: { $set: { status: "ARCHIVED" } } }]);
    expect(progress.state.archived).toBe(true);
    const before = mocks.order.length;
    await expect(createLinkedInCampaignBundle("t1", "11", bundle, undefined, progress)).rejects.toMatchObject({ code: POST_AUTHOR_REFUSED });
    expect(mocks.order.length).toBe(before);
  });

  it("closes the card with nothing created when the post was deleted before the first create", async () => {
    mocks.post.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    mocks.page.mockResolvedValue(gonePage());
    const e = await createLinkedInCampaignBundle("t1", "11", bundle, undefined, journal()).catch((x) => x);
    expect(e).toMatchObject({ code: POST_AUTHOR_REFUSED, meta: expect.objectContaining({ [POST_MISSING]: true, [NOTHING_SENT]: true }) });
    expect(e.message).toMatch(/Nothing was created in LinkedIn/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
