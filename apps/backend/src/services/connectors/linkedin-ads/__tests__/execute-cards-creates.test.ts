import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), log: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));

import { resetLinkedInAdsReadCache } from "../http";
import { executeLinkedInCreateAd, executeLinkedInCreateCampaign, executeLinkedInDuplicate, executeLinkedInSwapAd } from "../execute-cards";
import { LINKEDIN_CAMPAIGN_COPY_FIELDS } from "../write";
import { classifyExecFailure, failedDefinitely } from "@/services/channels/exec-failure";

const DAY = 86_400_000;
const PAGE = "urn:li:organization:77";
const POST = "urn:li:share:7000000000000000001";
const NEW_POST = "urn:li:share:7000000000000000002";
const US = "urn:li:geo:103644278";
const LOC = "urn:li:adTargetingFacet:locations";
const LOCALES = "urn:li:adTargetingFacet:interfaceLocales";
const LAST_MODIFIED = 1_760_000_000_000;
const targeting = { include: { and: [{ or: { [LOC]: [US] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }] } };

let live: Record<string, unknown>;
let group: Record<string, unknown> | null;
let siblings: Array<Record<string, unknown>>;
let creatives: Record<string, Array<Record<string, unknown>>>;
let postRefusal: ((url: string, body: Record<string, unknown>) => { status: number; text?: string } | null) | null;

type Post = { url: string; method: string; body: Record<string, unknown> };
const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const notFound = () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => "{}" });
const ad = (id: string, over: Record<string, unknown> = {}) => ({ id: `urn:li:sponsoredCreative:${id}`, campaign: "urn:li:sponsoredCampaign:22", name: `Ad ${id} name`, intendedStatus: "ACTIVE", content: { reference: `urn:li:share:70000000000000000${id}` }, changeAuditStamps: { lastModified: { time: LAST_MODIFIED } }, ...over });
const posts = (): Post[] => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST").map(([u, init]) => ({ url: String(u), method: String(new Headers((init as RequestInit).headers).get("X-RestLi-Method")), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));
let created = 0;

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.inUse.mockResolvedValue(true);
  created = 900;
  postRefusal = null;
  live = { id: 22, account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:5", name: "Spring", status: "ACTIVE", type: "SPONSORED_UPDATES", objectiveType: "WEBSITE_VISITS", associatedEntity: PAGE, costType: "CPC", creativeSelection: "OPTIMIZED", dailyBudget: { amount: "40", currencyCode: "USD" }, unitCost: { amount: "4", currencyCode: "USD" }, locale: { country: "US", language: "en" }, runSchedule: { start: Date.now() - 30 * DAY, end: Date.now() + 30 * DAY }, audienceExpansionEnabled: true, offsiteDeliveryEnabled: false, changeAuditStamps: { created: { time: LAST_MODIFIED - DAY }, lastModified: { time: LAST_MODIFIED } }, targetingCriteria: targeting, servingStatuses: ["RUNNABLE"], version: { versionTag: "7" } };
  group = { id: 5, account: "urn:li:sponsoredAccount:11", name: "Q4", status: "ACTIVE", changeAuditStamps: { lastModified: { time: LAST_MODIFIED } } };
  siblings = [live, { id: 23, account: "urn:li:sponsoredAccount:11", name: "Autumn", status: "PAUSED" }];
  creatives = { "22": [ad("1", { content: { reference: POST } }), ad("2"), ad("3")], "23": [] };
  m.fetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const refused = postRefusal?.(u, body);
      if (refused) return { ok: false, status: refused.status, headers: new Headers(), json: async () => ({}), text: async () => refused.text ?? JSON.stringify({ message: "refused" }) };
      const method = new Headers(init.headers).get("X-RestLi-Method");
      if (method === "CREATE") return { ok: true, status: 201, headers: new Headers({ "x-restli-id": String(++created) }), json: async () => ({}), text: async () => "" };
      return { ok: true, status: 204, headers: new Headers(), json: async () => ({}), text: async () => "" };
    }
    if (u.includes("adAccounts/11/adCampaigns/22")) return ok(live);
    if (u.includes("adAccounts/11/adCampaigns/23")) return ok(siblings[1]);
    if (/adAccounts\/11\/adCampaigns\/\d+/.test(u)) return notFound();
    if (u.includes("adAccounts/11/adCampaignGroups/5")) return group ? ok(group) : notFound();
    if (u.includes("adAccounts/11/adCampaigns?") && u.includes("q=search")) return ok({ elements: siblings });
    if (u.includes("adAccounts/11/creatives?") && u.includes("q=criteria")) return ok({ elements: creatives[/sponsoredCampaign%3A(\d+)/.exec(u)?.[1] ?? ""] ?? [] });
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const createAd = (over: Record<string, unknown> = {}) =>
  executeLinkedInCreateAd({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", campaign_name: "Spring", campaign_status: "ACTIVE", associated_entity: PAGE, source: { kind: "post", post_urn: NEW_POST }, go_live: false, expected_ad_count: 3, rationale: "r", ...over } });
const swap = (over: Record<string, unknown> = {}) =>
  executeLinkedInSwapAd({ tenant_id: "t1", body: { campaign_id: "22", account_id: "11", campaign_name: "Spring", associated_entity: PAGE, old_creative_id: "2", old_ad_name: "Ad 2 name", source: { kind: "post", post_urn: NEW_POST }, rationale: "r", ...over } });
const createCampaign = (over: Record<string, unknown> = {}) =>
  executeLinkedInCreateCampaign({ tenant_id: "t1", body: { account_id: "11", group_id: "5", group_name: "Q4", expected_group_status: "ACTIVE", name: "Winter", daily_budget: { amount: "25", currency: "USD" }, unit_cost: { amount: "4.50", currency: "USD" }, geo_urns: [US], country: "US", language: "en", associated_entity: PAGE, objective_type: null, post_urn: NEW_POST, places: ["United States"], rationale: "r", ...over } });
const duplicate = (over: Record<string, unknown> = {}) =>
  executeLinkedInDuplicate({ tenant_id: "t1", body: { target: "campaign", source_id: "22", account_id: "11", source_name: "Spring", new_name: "Spring copy", group_id: null, campaign_id: null, copy_ads: true, source_last_modified_at: new Date(LAST_MODIFIED).toISOString(), rationale: "r", ...over } });

describe("linkedin_ads.create_ad applies only what the founder saw", () => {
  it("must catch: an ad count that moved since the card was written sends nothing", async () => {
    await expect(createAd({ expected_ad_count: 2 })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_count_drift" });
    expect(posts()).toEqual([]);
  });

  it("must catch: a post the campaign already runs is a notice, never a second ad", async () => {
    await expect(createAd({ source: { kind: "post", post_urn: POST } })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already has this post") });
    expect(posts()).toEqual([]);
  });

  it("the post ad is created with exactly the three fields LinkedIn needs, paused unless the card says go live", async () => {
    await expect(createAd()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("901") });
    expect(posts()).toEqual([{ url: expect.stringMatching(/\/adAccounts\/11\/creatives$/), method: "CREATE", body: { campaign: "urn:li:sponsoredCampaign:22", content: { reference: NEW_POST }, intendedStatus: "PAUSED" } }]);
    m.fetch.mockClear();
    await expect(createAd({ go_live: true })).resolves.toMatchObject({ ok: true });
    expect(posts()[0].body).toEqual({ campaign: "urn:li:sponsoredCampaign:22", content: { reference: NEW_POST }, intendedStatus: "ACTIVE" });
  });

  it("must catch: a direct ad goes to createInline with the campaign's page as author and this account as the DSC account", async () => {
    await expect(createAd({ source: { kind: "inline", ad_name: "Direct", commentary: "Buy now", headline: "H", landing_url: "https://example.com/x", image_urn: "urn:li:image:C4D1" }, go_live: true })).resolves.toMatchObject({ ok: true });
    const [p] = posts();
    expect(p.url).toMatch(/\/adAccounts\/11\/creatives\?action=createInline$/);
    expect(p.method).toBe("CREATE");
    expect(p.body).toMatchObject({ campaign: "urn:li:sponsoredCampaign:22", intendedStatus: "ACTIVE", name: "Direct" });
    const post = (p.body.inlineContent as { post: Record<string, unknown> }).post;
    expect(post.author).toBe(PAGE);
    expect(post.commentary).toBe("Buy now");
    expect(post.adContext).toMatchObject({ dscAdAccount: "urn:li:sponsoredAccount:11", dscName: "Direct" });
    expect(post.content).toEqual({ article: { source: "https://example.com/x", title: "H", thumbnail: "urn:li:image:C4D1" } });
  });

  it("refuses when the campaign's page or status drifted, and sends nothing", async () => {
    live.associatedEntity = "urn:li:organization:99";
    await expect(createAd()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_page_drift" });
    live.associatedEntity = PAGE;
    live.status = "ARCHIVED";
    await expect(createAd()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_campaign_ended" });
    expect(posts()).toEqual([]);
  });
});

describe("linkedin_ads.swap_ad creates the new ad before it touches the old one", () => {
  it("creates the replacement on, then pauses the old ad, in that order", async () => {
    await expect(swap()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("901") });
    const p = posts();
    expect(p.map((x) => x.method)).toEqual(["CREATE", "PARTIAL_UPDATE"]);
    expect(p[0]).toMatchObject({ url: expect.stringMatching(/\/adAccounts\/11\/creatives$/), body: { campaign: "urn:li:sponsoredCampaign:22", content: { reference: NEW_POST }, intendedStatus: "ACTIVE" } });
    expect(p[1]).toMatchObject({ url: expect.stringContaining("creatives/urn%3Ali%3AsponsoredCreative%3A2"), body: { patch: { $set: { intendedStatus: "PAUSED" } } } });
  });

  it("must catch: a pause that fails after the create succeeded reports the swap as partial and names the new ad", async () => {
    postRefusal = (url) => (url.includes("sponsoredCreative%3A2") ? { status: 400 } : null);
    const r = await swap();
    expect(r).toMatchObject({ ok: false, code: "exec_partial", error: expect.stringContaining("901") });
    expect(classifyExecFailure(r)).toMatchObject({ bucket: "partial_risk" });
    expect(failedDefinitely({ exec_status: "failed", exec_result: r })).toBe(false);
    expect(posts().map((x) => x.method)).toEqual(["CREATE", "PARTIAL_UPDATE"]);
  });

  it("must catch: an old ad that is no longer on, or missing, means no new ad is created", async () => {
    creatives["22"][1].intendedStatus = "PAUSED";
    await expect(swap()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    await expect(swap({ old_creative_id: "9" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_ad_not_found" });
    expect(posts()).toEqual([]);
  });
});

describe("linkedin_ads.create_campaign is idempotent on the campaign's name", () => {
  it("must catch: a paused sibling with the same name is reused, so only the ad is created", async () => {
    await expect(createCampaign({ name: "Autumn" })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("campaign 23") });
    expect(posts()).toEqual([{ url: expect.stringMatching(/\/adAccounts\/11\/creatives$/), method: "CREATE", body: { campaign: "urn:li:sponsoredCampaign:23", content: { reference: NEW_POST }, intendedStatus: "PAUSED" } }]);
  });

  it("a running sibling with the same name refuses everything", async () => {
    await expect(createCampaign({ name: "Spring" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_name_taken" });
    expect(posts()).toEqual([]);
  });

  it("a new name creates the campaign paused in the group, then its paused ad", async () => {
    await expect(createCampaign()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("campaign 901") });
    const p = posts();
    expect(p.map((x) => x.method)).toEqual(["CREATE", "CREATE"]);
    expect(p[0].url).toMatch(/\/adAccounts\/11\/adCampaigns$/);
    expect(p[0].body).toMatchObject({ name: "Winter", status: "PAUSED", account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:5", associatedEntity: PAGE, dailyBudget: { amount: "25", currencyCode: "USD" }, unitCost: { amount: "4.50", currencyCode: "USD" }, audienceExpansionEnabled: false, offsiteDeliveryEnabled: false });
    expect(JSON.stringify(p[0].body.targetingCriteria)).toContain(LOCALES);
    expect(p[1].body).toEqual({ campaign: "urn:li:sponsoredCampaign:901", content: { reference: NEW_POST }, intendedStatus: "PAUSED" });
  });

  it("must catch: a group whose status moved since the card sends nothing", async () => {
    group!.status = "PAUSED";
    await expect(createCampaign()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_status_drift" });
    group = null;
    await expect(createCampaign()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_group_not_found" });
    expect(posts()).toEqual([]);
  });
});

describe("linkedin_ads.duplicate copies settings, never state", () => {
  it("must catch: a campaign copy carries only the allowlisted fields, is paused, and starts now", async () => {
    const before = Date.now();
    await expect(duplicate()).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("campaign 901") });
    const p = posts();
    expect(p[0].url).toMatch(/\/adAccounts\/11\/adCampaigns$/);
    const body = p[0].body;
    expect(body.status).toBe("PAUSED");
    expect(body.name).toBe("Spring copy");
    expect(body.campaignGroup).toBe("urn:li:sponsoredCampaignGroup:5");
    expect(body.account).toBe("urn:li:sponsoredAccount:11");
    expect(body.politicalIntent).toBe("NOT_DECLARED");
    const start = (body.runSchedule as { start: number; end?: number }).start;
    expect(start).toBeGreaterThanOrEqual(before);
    expect((body.runSchedule as { end?: number }).end).toBeUndefined();
    for (const k of ["id", "changeAuditStamps", "servingStatuses", "version"]) expect(body).not.toHaveProperty(k);
    const allowed = new Set<string>([...LINKEDIN_CAMPAIGN_COPY_FIELDS, "account", "campaignGroup", "status", "runSchedule", "politicalIntent"]);
    for (const k of Object.keys(body)) expect(allowed.has(k), k).toBe(true);
    expect(body).toMatchObject({ type: "SPONSORED_UPDATES", objectiveType: "WEBSITE_VISITS", associatedEntity: PAGE, costType: "CPC", dailyBudget: { amount: "40", currencyCode: "USD" }, unitCost: { amount: "4", currencyCode: "USD" }, audienceExpansionEnabled: true, targetingCriteria: targeting });
    expect(p.slice(1).map((x) => x.body)).toEqual(creatives["22"].map((a) => ({ campaign: "urn:li:sponsoredCampaign:901", content: a.content, intendedStatus: "PAUSED" })));
  });

  it("copy_ads false copies the campaign alone", async () => {
    await expect(duplicate({ copy_ads: false })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("without ads") });
    expect(posts()).toHaveLength(1);
  });

  it("must catch: a source edited in LinkedIn after the card was written sends nothing", async () => {
    await expect(duplicate({ source_last_modified_at: new Date(LAST_MODIFIED - 1000).toISOString() })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_source_drift" });
    live.changeAuditStamps = { lastModified: { time: LAST_MODIFIED + 60_000 } };
    await expect(duplicate()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_source_drift" });
    expect(posts()).toEqual([]);
  });

  it("must catch: an ad copy is created under the approved new name, so approving the same card again makes no second copy", async () => {
    const card = { target: "creative", source_id: "2", source_name: "Ad 2 name", campaign_id: "22", new_name: "Ad 2 copy" };
    await expect(duplicate(card)).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("ad 901") });
    expect(posts()).toEqual([{ url: expect.stringMatching(/\/adAccounts\/11\/creatives$/), method: "CREATE", body: { campaign: "urn:li:sponsoredCampaign:22", content: creatives["22"][1].content, intendedStatus: "PAUSED", name: "Ad 2 copy" } }]);
    creatives["22"].push(ad("901", { name: "Ad 2 copy", intendedStatus: "PAUSED" }));
    resetLinkedInAdsReadCache();
    await expect(duplicate(card)).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("already exists") });
    expect(posts()).toHaveLength(1);
  });

  it("must catch: a campaign copy whose second ad is refused reports exec_partial naming the paused copy, never a plain failure a retry would mark done", async () => {
    let ads = 0;
    postRefusal = (url) => (url.endsWith("/creatives") && ++ads === 2 ? { status: 429 } : null);
    const r = await duplicate();
    expect(r).toMatchObject({ ok: false, code: "exec_partial", error: expect.stringContaining("campaign 901") });
    expect(r).toMatchObject({ error: expect.stringContaining("with 1 ad,") });
  });

  it("must catch: a group copy that fails on its second campaign reports exec_partial naming the paused group", async () => {
    postRefusal = (url, body) => (url.endsWith("/adCampaigns") && body.name === "Autumn" ? { status: 500 } : null);
    const r = await duplicate({ target: "campaign_group", source_id: "5", source_name: "Q4", new_name: "Q4 copy", copy_ads: false });
    expect(r).toMatchObject({ ok: false, code: "exec_partial", error: expect.stringContaining("group 901") });
    expect(r).toMatchObject({ error: expect.stringContaining("with 1 campaign,") });
  });

  it("a name already present in the destination group is a notice, not a second copy", async () => {
    await expect(duplicate({ new_name: "Autumn" })).resolves.toMatchObject({ ok: true, notice: expect.stringContaining("campaign 23") });
    expect(posts()).toEqual([]);
  });

  it("must catch: a group copy is created ACTIVE then paused before any campaign is added, since LinkedIn refuses a group born paused", async () => {
    const r = await duplicate({ target: "campaign_group", source_id: "5", source_name: "Q4", new_name: "Q4 copy", copy_ads: false });
    expect(r).toMatchObject({ ok: true, notice: expect.stringContaining("group 901") });
    const p = posts();
    expect(p[0]).toMatchObject({ url: expect.stringMatching(/\/adAccounts\/11\/adCampaignGroups$/), method: "CREATE", body: { status: "ACTIVE", name: "Q4 copy", account: "urn:li:sponsoredAccount:11" } });
    expect(p[1]).toMatchObject({ url: expect.stringContaining("adAccounts/11/adCampaignGroups/901"), method: "PARTIAL_UPDATE", body: { patch: { $set: { status: "PAUSED" } } } });
    expect(p.slice(2).map((x) => [x.method, x.body.campaignGroup, x.body.status])).toEqual(siblings.map(() => ["CREATE", "urn:li:sponsoredCampaignGroup:901", "PAUSED"]));
  });

  it("must catch: when the pause of the new group fails, the empty group is archived and no campaign is copied into it", async () => {
    postRefusal = (url, body) => (url.includes("adCampaignGroups/901") && (body.patch as { $set?: { status?: string } })?.$set?.status === "PAUSED" ? { status: 400 } : null);
    await expect(duplicate({ target: "campaign_group", source_id: "5", source_name: "Q4", new_name: "Q4 copy" })).resolves.toMatchObject({ ok: false });
    expect(posts().map((x) => [x.method, (x.body.patch as { $set?: { status?: string } })?.$set?.status ?? x.body.status])).toEqual([["CREATE", "ACTIVE"], ["PARTIAL_UPDATE", "PAUSED"], ["PARTIAL_UPDATE", "ARCHIVED"]]);
  });

  it("must catch: a group that holds a wallet campaign is not copied, and nothing is created", async () => {
    m.findBinding.mockImplementation(async (_t: string, _p: string, id: string) => (id === "23" ? { id: "b1", funding_source: "wallet" } : null));
    await expect(duplicate({ target: "campaign_group", source_id: "5", source_name: "Q4", new_name: "Q4 copy" })).resolves.toMatchObject({ ok: false, code: "linkedin_ads_wallet_campaign", error: expect.stringContaining("Autumn") });
    expect(posts()).toEqual([]);
  });

  it("refuses a wallet-bound source campaign before any read", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", funding_source: "wallet" });
    await expect(duplicate()).resolves.toMatchObject({ ok: false, code: "linkedin_ads_wallet_campaign" });
    expect(m.fetch).not.toHaveBeenCalled();
  });
});
