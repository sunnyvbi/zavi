import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ fetch: vi.fn(), findBinding: vi.fn(), inUse: vi.fn(), emit: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => "tok", forceRefreshConnector: vi.fn(), markConnectorTokenRevoked: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: m.findBinding }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({ linkedinAccountInUse: m.inUse }));

import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { linkedinAdsProposeNewAdTool } from "../propose_new_ad";
import { linkedinAdsProposeAdSwapTool } from "../propose_ad_swap";
import { countryOfPlace, linkedinAdsProposeNewCampaignTool } from "../propose_new_campaign";
import { linkedinAdsProposeDuplicateTool } from "../propose_duplicate";
import {
  LINKEDIN_CREATE_AD_CLASS,
  LINKEDIN_CREATE_CAMPAIGN_CLASS,
  LINKEDIN_DUPLICATE_CLASS,
  LINKEDIN_SWAP_AD_CLASS,
  linkedinCreateAdBodySchema,
  linkedinCreateCampaignBodySchema,
  linkedinDuplicateBodySchema,
  linkedinSwapAdBodySchema,
} from "../../_change-bodies";

const DAY = 86_400_000;
const PAGE = "urn:li:organization:77";
const POST = "urn:li:share:7000000000000000001";
const NEW_POST = "urn:li:share:7000000000000000002";
const US = "urn:li:geo:103644278";
const CA = "urn:li:geo:101174742";
const DE = "urn:li:geo:101282230";
const LOC = "urn:li:adTargetingFacet:locations";
const LOCALES = "urn:li:adTargetingFacet:interfaceLocales";
const LAST_MODIFIED = 1_760_000_000_000;

let live: Record<string, unknown>;
let group: Record<string, unknown> | null;
let siblings: Array<Record<string, unknown>>;
let groups: Array<Record<string, unknown>>;
let accounts: Array<Record<string, unknown>>;
let creatives: Record<string, Array<Record<string, unknown>>>;
let postAuthor: Record<string, unknown>;

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const notFound = () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => "{}" });
const entity = (urn: string, name: string) => ({ urn, name, facetUrn: LOC, isTargetable: true });
const ctx = (over: Record<string, unknown> = {}) => ({ tenant_id: "t1", log: () => {}, emit_decision: m.emit, ...over }) as never;
const ad = (id: string, over: Record<string, unknown> = {}) => ({ id: `urn:li:sponsoredCreative:${id}`, campaign: "urn:li:sponsoredCampaign:22", name: `Ad ${id} name`, intendedStatus: "ACTIVE", content: { reference: `urn:li:share:70000000000000000${id}` }, changeAuditStamps: { lastModified: { time: LAST_MODIFIED } }, ...over });
const posts = () => m.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST");

beforeEach(() => {
  resetLinkedInAdsReadCache();
  for (const f of Object.values(m)) f.mockReset();
  m.findBinding.mockResolvedValue(null);
  m.inUse.mockResolvedValue(true);
  m.emit.mockResolvedValue("card-1");
  live = { id: 22, account: "urn:li:sponsoredAccount:11", campaignGroup: "urn:li:sponsoredCampaignGroup:5", name: "Spring", status: "ACTIVE", associatedEntity: PAGE, dailyBudget: { amount: "40", currencyCode: "USD" }, runSchedule: { start: Date.now() - 30 * DAY }, changeAuditStamps: { lastModified: { time: LAST_MODIFIED } }, targetingCriteria: { include: { and: [{ or: { [LOC]: [US] } }, { or: { [LOCALES]: ["urn:li:locale:en_US"] } }] } } };
  group = { id: 5, account: "urn:li:sponsoredAccount:11", name: "Q4", status: "ACTIVE", changeAuditStamps: { lastModified: { time: LAST_MODIFIED } } };
  siblings = [live, { id: 23, account: "urn:li:sponsoredAccount:11", name: "Autumn", status: "PAUSED" }];
  groups = [group];
  accounts = [{ id: 11, name: "Acme Ads", currency: "USD", status: "ACTIVE", reference: PAGE }];
  creatives = { "22": [ad("1", { content: { reference: POST } }), ad("2"), ad("3", { intendedStatus: "ARCHIVED" })] };
  postAuthor = { author: PAGE, commentary: "hello" };
  m.fetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes("adAccounts/11/adCampaigns/22")) return ok(live);
    if (u.includes("adAccounts/11/adCampaigns/23")) return ok(siblings[1]);
    if (/adAccounts\/11\/adCampaigns\/\d+/.test(u)) return notFound();
    if (u.includes("adAccounts/11/adCampaignGroups/5")) return group ? ok(group) : notFound();
    if (/adAccounts\/11\/adCampaignGroups\/\d+/.test(u)) return notFound();
    if (u.includes("adAccounts/11/adCampaignGroups?") && u.includes("q=search")) return ok({ elements: groups });
    if (u.includes("adAccounts/11/adCampaigns?") && u.includes("q=search")) return ok({ elements: siblings });
    if (u.includes("adAccounts/11/creatives?") && u.includes("q=criteria")) return ok({ elements: creatives[/sponsoredCampaign%3A(\d+)/.exec(u)?.[1] ?? ""] ?? [] });
    if (u.includes("adAccounts?") && u.includes("q=search")) return ok({ elements: accounts });
    if (u.includes("/posts/")) return ok(postAuthor);
    if (u.includes("adTargetingEntities") && u.includes("typeahead")) {
      if (/query=Canada/i.test(u)) return ok({ elements: [entity(CA, "Canada")] });
      if (/query=Germany/i.test(u)) return ok({ elements: [entity(DE, "Germany")] });
      if (/query=United(%20| )States/i.test(u)) return ok({ elements: [entity(US, "United States")] });
      return ok({ elements: [] });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const newAd = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeNewAdTool.execute(c, { campaign_id: "22", account_id: "11", post_urn: NEW_POST, rationale: "the current ad's CTR halved in 3 weeks", ...input });
const swap = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeAdSwapTool.execute(c, { campaign_id: "22", account_id: "11", old_creative_id: "2", post_urn: NEW_POST, rationale: "ad 2 is fatigued", ...input });
const newCampaign = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeNewCampaignTool.execute(c, { account_id: "11", group_id: "5", name: "Winter", daily_budget: "25", bid: "4.50", locations: ["Canada"], rationale: "Canada clicks convert twice as often", ...input });
const duplicate = (input: Record<string, unknown> = {}, c = ctx()) => linkedinAdsProposeDuplicateTool.execute(c, { target: "campaign", source_id: "22", account_id: "11", new_name: "Spring copy", rationale: "Spring is the best converter", ...input });

describe("the four create tools only ever file a card, and only for the founder's own account", () => {
  it("none of them works outside a channel run", async () => {
    const bare = ctx({ emit_decision: undefined });
    for (const call of [() => newAd({}, bare), () => swap({}, bare), () => newCampaign({}, bare), () => duplicate({}, bare)]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_propose_not_channel_run" });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("a wallet-bound campaign is refused by every campaign-shaped tool before LinkedIn is read", async () => {
    m.findBinding.mockResolvedValue({ id: "b1", funding_source: "wallet" });
    for (const call of [newAd, swap, duplicate]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("an account this workspace does not use is refused before LinkedIn is read", async () => {
    m.inUse.mockResolvedValue(false);
    for (const call of [newAd, swap, newCampaign, () => duplicate({ target: "campaign_group", source_id: "5" })]) await expect(call()).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("must catch: no tool sends a POST to LinkedIn; the card is the only output", async () => {
    await newAd();
    await swap();
    await newCampaign();
    await duplicate();
    expect(posts()).toEqual([]);
    expect(m.emit).toHaveBeenCalledTimes(4);
  });
});

describe("linkedin_ads_propose_new_ad", () => {
  it("files the card with the live ad count (archived ads excluded) and the campaign's own page, and the body passes the strict schema", async () => {
    await expect(newAd()).resolves.toMatchObject({ action_id: "card-1", status: "waiting_for_approval", campaign: { id: "22", name: "Spring", ads_now: 2 } });
    const [cls, body] = m.emit.mock.calls[0] as [string, unknown];
    expect(cls).toBe(LINKEDIN_CREATE_AD_CLASS);
    expect(linkedinCreateAdBodySchema.strict().parse(body)).toMatchObject({ campaign_id: "22", campaign_status: "ACTIVE", associated_entity: PAGE, expected_ad_count: 2, go_live: false, source: { kind: "post", post_urn: NEW_POST } });
  });

  it("must catch: the ad count on the card comes from LinkedIn, never from the caller", async () => {
    await expect(newAd({ expected_ad_count: 7 })).rejects.toThrow();
    expect(m.emit).not.toHaveBeenCalled();
    creatives["22"] = [ad("1"), ad("2"), ad("3"), ad("4")];
    await newAd();
    expect(m.emit.mock.calls[0][1]).toMatchObject({ expected_ad_count: 4 });
  });

  it("go_live needs an owner; paused only an approval", async () => {
    await expect(newAd({ go_live: true })).resolves.toMatchObject({ status: "waiting_for_owner" });
    expect(m.emit.mock.calls[0][1]).toMatchObject({ go_live: true });
  });

  it("must catch: a post from another page is refused before anything is filed", async () => {
    postAuthor = { author: "urn:li:organization:99" };
    await expect(newAd()).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("a post the campaign already runs is refused with the ad that has it", async () => {
    await expect(newAd({ post_urn: POST })).rejects.toMatchObject({ code: "linkedin_ads_ad_exists", meta: { creative_id: "1" } });
    creatives["22"][0].intendedStatus = "ARCHIVED";
    await expect(newAd({ post_urn: POST })).resolves.toMatchObject({ action_id: "card-1" });
  });

  it("must catch: a campaign at LinkedIn's 100-ad limit is refused, archived ads not counted", async () => {
    creatives["22"] = Array.from({ length: 100 }, (_, i) => ad(String(100 + i)));
    await expect(newAd()).rejects.toMatchObject({ code: "linkedin_ads_ad_limit" });
    creatives["22"][0].intendedStatus = "PENDING_DELETION";
    await expect(newAd()).resolves.toMatchObject({ campaign: { ads_now: 99 } });
  });

  it("an inline source needs an ad_name, and exactly one source is accepted", async () => {
    await expect(newAd({ post_urn: undefined, inline: { commentary: "Buy now" } })).rejects.toThrow();
    await expect(newAd({ inline: { ad_name: "Direct", commentary: "Buy now" } })).rejects.toThrow();
    await expect(newAd({ post_urn: undefined })).rejects.toThrow();
    expect(m.fetch).not.toHaveBeenCalled();
    await expect(newAd({ post_urn: undefined, inline: { ad_name: "Direct", commentary: "Buy now", landing_url: "https://example.com/x", image_urn: "urn:li:image:C4D1" } })).resolves.toMatchObject({ source: { kind: "inline", ad_name: "Direct" } });
    expect(linkedinCreateAdBodySchema.parse(m.emit.mock.calls[0][1]).source).toEqual({ kind: "inline", ad_name: "Direct", commentary: "Buy now", landing_url: "https://example.com/x", image_urn: "urn:li:image:C4D1" });
    expect(m.fetch.mock.calls.some(([u]) => String(u).includes("/posts/"))).toBe(false);
  });

  it("refuses an ended campaign and one whose page LinkedIn did not return", async () => {
    live.status = "ARCHIVED";
    await expect(newAd()).rejects.toMatchObject({ code: "linkedin_ads_campaign_ended" });
    live.status = "ACTIVE";
    delete live.associatedEntity;
    await expect(newAd()).rejects.toMatchObject({ code: "linkedin_ads_page_unknown" });
    expect(m.emit).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_propose_ad_swap", () => {
  it("files an owner card naming the live old ad, and the body passes the strict schema", async () => {
    await expect(swap()).resolves.toMatchObject({ status: "waiting_for_owner", old_ad: { id: "2", name: "Ad 2 name" } });
    const [cls, body] = m.emit.mock.calls[0] as [string, unknown];
    expect(cls).toBe(LINKEDIN_SWAP_AD_CLASS);
    expect(linkedinSwapAdBodySchema.strict().parse(body)).toMatchObject({ old_creative_id: "2", old_ad_name: "Ad 2 name", associated_entity: PAGE, source: { kind: "post", post_urn: NEW_POST } });
  });

  it("an unnamed old ad is called by its id", async () => {
    delete creatives["22"][1].name;
    await expect(swap()).resolves.toMatchObject({ old_ad: { name: "Ad 2" } });
  });

  it("must catch: the old ad must exist in this campaign and be on", async () => {
    await expect(swap({ old_creative_id: "9" })).rejects.toMatchObject({ code: "linkedin_ads_ad_not_found" });
    creatives["22"][1].intendedStatus = "PAUSED";
    await expect(swap()).rejects.toMatchObject({ code: "linkedin_ads_ad_not_active" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("a post from another page or already in the campaign is refused like a new ad", async () => {
    await expect(swap({ post_urn: POST })).rejects.toMatchObject({ code: "linkedin_ads_ad_exists" });
    postAuthor = { author: "urn:li:organization:99" };
    await expect(swap()).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch" });
    expect(m.emit).not.toHaveBeenCalled();
  });
});

describe("linkedin_ads_propose_new_campaign", () => {
  it("files an owner card with the account's currency and page, the group's live status, resolved geo urns and the body passes the strict schema", async () => {
    await expect(newCampaign()).resolves.toMatchObject({ status: "waiting_for_owner", campaign: { name: "Winter", group: { id: "5", name: "Q4" }, places: ["Canada"] } });
    const [cls, body] = m.emit.mock.calls[0] as [string, unknown];
    expect(cls).toBe(LINKEDIN_CREATE_CAMPAIGN_CLASS);
    expect(linkedinCreateCampaignBodySchema.strict().parse(body)).toMatchObject({
      account_id: "11",
      group_id: "5",
      expected_group_status: "ACTIVE",
      daily_budget: { amount: "25", currency: "USD" },
      unit_cost: { amount: "4.50", currency: "USD" },
      geo_urns: [CA],
      country: "CA",
      language: "en",
      associated_entity: PAGE,
      objective_type: null,
      post_urn: null,
      places: ["Canada"],
    });
    expect(countryOfPlace("Austin, Texas, United States")).toBe("US");
    expect(countryOfPlace("Atlantis")).toBeNull();
  });

  it("must catch: a running sibling with the same name is refused; a paused one is not", async () => {
    await expect(newCampaign({ name: "Spring" })).rejects.toMatchObject({ code: "linkedin_ads_name_taken", meta: { campaign_id: "22" } });
    expect(m.emit).not.toHaveBeenCalled();
    await expect(newCampaign({ name: "Autumn" })).resolves.toMatchObject({ action_id: "card-1" });
  });

  it("must catch: the currency and page come from LinkedIn's account record; an account without them is refused", async () => {
    accounts[0].currency = undefined;
    await expect(newCampaign()).rejects.toMatchObject({ code: "linkedin_ads_currency_unknown" });
    accounts[0].currency = "EUR";
    accounts[0].reference = undefined;
    await expect(newCampaign()).rejects.toMatchObject({ code: "linkedin_ads_page_unknown" });
    accounts[0].reference = PAGE;
    await newCampaign();
    expect(m.emit.mock.calls[0][1]).toMatchObject({ daily_budget: { currency: "EUR" }, unit_cost: { currency: "EUR" } });
  });

  it("a missing or ended group, an EU or unknown location and a zero bid are refused", async () => {
    group = null;
    await expect(newCampaign()).rejects.toMatchObject({ code: "linkedin_ads_group_not_found" });
    group = { id: 5, account: "urn:li:sponsoredAccount:11", name: "Q4", status: "ARCHIVED" };
    await expect(newCampaign()).rejects.toMatchObject({ code: "linkedin_ads_group_ended" });
    group.status = "ACTIVE";
    await expect(newCampaign({ locations: ["Germany"] })).rejects.toMatchObject({ code: "linkedin_ads_location_eu" });
    await expect(newCampaign({ locations: ["Atlantis"] })).rejects.toMatchObject({ code: "linkedin_ads_location_unknown" });
    await expect(newCampaign({ bid: "0" })).rejects.toMatchObject({ code: "linkedin_ads_bid_invalid" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("must catch: a first-ad post from another page is refused before filing; the page's own post is carried", async () => {
    postAuthor = { author: "urn:li:organization:99" };
    await expect(newCampaign({ post_urn: NEW_POST })).rejects.toMatchObject({ code: "linkedin_ads_post_page_mismatch" });
    expect(m.emit).not.toHaveBeenCalled();
    postAuthor = { author: PAGE };
    await newCampaign({ post_urn: NEW_POST, objective_type: "WEBSITE_VISITS", excluded_locations: ["United States"], audience: { titles: [], seniorities: ["urn:li:seniority:4"], industries: [], staffCountRanges: [] } });
    expect(linkedinCreateCampaignBodySchema.parse(m.emit.mock.calls[0][1])).toMatchObject({ post_urn: NEW_POST, objective_type: "WEBSITE_VISITS", excluded_geo_urns: [US], audience: { seniorities: ["urn:li:seniority:4"] } });
  });
});

describe("linkedin_ads_propose_duplicate", () => {
  it("a campaign copy carries its live name, group and last-modified stamp, and the body passes the strict schema", async () => {
    await expect(duplicate()).resolves.toMatchObject({ status: "waiting_for_owner", source: { target: "campaign", id: "22", name: "Spring" }, copy: { name: "Spring copy", group_id: "5" } });
    const [cls, body] = m.emit.mock.calls[0] as [string, unknown];
    expect(cls).toBe(LINKEDIN_DUPLICATE_CLASS);
    expect(linkedinDuplicateBodySchema.strict().parse(body)).toMatchObject({ source_name: "Spring", group_id: "5", campaign_id: null, copy_ads: true, source_last_modified_at: new Date(LAST_MODIFIED).toISOString() });
  });

  it("must catch: a name already used at the destination is refused for every target", async () => {
    await expect(duplicate({ new_name: "Autumn" })).rejects.toMatchObject({ code: "linkedin_ads_name_taken" });
    await expect(duplicate({ target: "campaign_group", source_id: "5", new_name: "Q4" })).rejects.toMatchObject({ code: "linkedin_ads_name_taken" });
    await expect(duplicate({ target: "creative", source_id: "1", campaign_id: "22", new_name: "Ad 2 name" })).rejects.toMatchObject({ code: "linkedin_ads_name_taken" });
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("an ad copy needs its campaign and a post to reuse", async () => {
    await expect(duplicate({ target: "creative", source_id: "1" })).rejects.toMatchObject({ code: "linkedin_ads_campaign_required" });
    creatives["22"][1].content = {};
    await expect(duplicate({ target: "creative", source_id: "2", campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_copy_unsupported" });
    await expect(duplicate({ target: "creative", source_id: "9", campaign_id: "22" })).rejects.toMatchObject({ code: "linkedin_ads_ad_not_found" });
    await expect(duplicate({ target: "creative", source_id: "1", campaign_id: "22" })).resolves.toMatchObject({ copy: { campaign_id: "22", group_id: null } });
    expect(m.emit.mock.calls[0][1]).toMatchObject({ source_name: "Ad 1 name", source_last_modified_at: new Date(LAST_MODIFIED).toISOString() });
  });

  it("must catch: a group of more than 20 campaigns is refused; a destination group that does not exist is refused", async () => {
    siblings = Array.from({ length: 21 }, (_, i) => ({ id: 100 + i, account: "urn:li:sponsoredAccount:11", name: `C${i}`, status: "PAUSED" }));
    await expect(duplicate({ target: "campaign_group", source_id: "5" })).rejects.toMatchObject({ code: "linkedin_ads_copy_too_big", meta: { campaigns: 21 } });
    siblings.pop();
    await expect(duplicate({ target: "campaign_group", source_id: "5", copy_ads: false })).resolves.toMatchObject({ source: { name: "Q4" }, copy: { copy_ads: false } });
    await expect(duplicate({ group_id: "6" })).rejects.toMatchObject({ code: "linkedin_ads_group_not_found" });
  });
});
