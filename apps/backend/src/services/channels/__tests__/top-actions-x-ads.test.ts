import { beforeEach, describe, expect, it, vi } from "vitest";

const company = vi.hoisted(() => ({ country: null as { code: string; name: string } | null, fail: false }));
const x = vi.hoisted(() => ({ place: null as { id: string; name: string; type: string; country_code: string } | null, token: null as Error | null, search: null as Error | null }));
vi.mock("@/services/ad-locations/country", async (orig) => ({
  ...(await orig<object>()),
  businessCountryOrThrow: async () => {
    if (company.fail) throw new Error("down");
    return company.country;
  },
  businessCountry: async () => (company.fail ? null : company.country),
}));
vi.mock("@/services/connectors/x-ads/client", async (orig) => ({
  ...(await orig<object>()),
  xAdsTenantToken: async () => {
    if (x.token) throw x.token;
    return { key: "k", secret: "s" };
  },
  findXCountryPlace: async () => {
    if (x.search) throw x.search;
    return x.place;
  },
}));

import {
  TOP_ACTIONS,
  resolveXCreateNewAd,
  resolveXPromotePost,
  topActionProposalProblem,
  xAudienceOf,
  xCampaignMustMatch,
  xCreateNewAdClientInputs,
  xCreateNewAdInputs,
  xKeywordsOf,
  xLanguagesOf,
  xNewAdMustMatch,
  xPromoteMustMatch,
  xPromotePostClientInputs,
  xPromotePostInputs,
} from "@/services/channels/top-actions";
import { ExpectedToolError } from "@/services/tools/types";

const us = { id: "96683cc9126741d1", name: "United States" };
const la = { id: "3b77caf94bfc81fe", name: "Los Angeles, CA, USA" };
const posts = "https://x.com/u/status/1";
const base = { posts, daily_budget: 10 };
const CLS = "x_ads.create_campaign";
const payload = (key: string, inputs: Record<string, unknown>) => ({ channel_slug: "x_ads", top_action: { key, by: "u", inputs } });
const bodyFor = (i: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  objective: "ENGAGEMENTS",
  daily_budget: i.daily_budget,
  total_budget: null,
  end_time: null,
  duration_days: null,
  locations: (i.places as unknown[]) ?? [],
  excluded_locations: (i.excluded_places as unknown[]) ?? [],
  audience: { keywords: [], languages: [], genders: [], ages: [] },
  tweet_ids: ["1"],
  new_post: null,
  ...extra,
});

beforeEach(() => {
  company.country = { code: "US", name: "United States" };
  company.fail = false;
  x.place = { ...us, type: "COUNTRIES", country_code: "US" };
  x.token = null;
  x.search = null;
});

describe("X Ads inputs: what the form may send and what the run carries", () => {
  it("the client shape takes the goal, budgets, duration, places and audience, with defaults", () => {
    const parsed = xPromotePostClientInputs.parse(base);
    expect(parsed).toMatchObject({ goal: "engage", duration: "open", gender: "any", age: "any" });
    expect(xPromotePostClientInputs.safeParse({ ...base, goal: "visit", total_budget: 200, duration: "14", keywords: "saas, startup\nfounders", languages: "en, ES", gender: "women", age: "25_49" }).success).toBe(true);
    expect(xPromotePostClientInputs.safeParse({ ...base, total_budget: 5 }).error?.issues[0].path).toEqual(["total_budget"]);
    expect(xPromotePostClientInputs.safeParse({ ...base, languages: "english" }).success).toBe(false);
    expect(xPromotePostClientInputs.safeParse({ ...base, keywords: Array.from({ length: 51 }, (_, k) => `k${k}`).join(",") }).success).toBe(false);
    expect(xPromotePostClientInputs.safeParse({ ...base, goal: "followers" }).success).toBe(false);
    expect(xPromotePostClientInputs.safeParse({ ...base, places: [us], excluded_places: [us] }).error?.issues[0].path).toEqual(["excluded_places"]);
  });

  it("the run's inputs always carry places, and are wired with the client shape and the resolver", () => {
    expect(xPromotePostInputs.safeParse(base).success).toBe(false);
    expect(xPromotePostInputs.safeParse({ ...base, places: [us] }).success).toBe(true);
    expect(TOP_ACTIONS.x_ads.promote_post.clientInputs).toBe(xPromotePostClientInputs);
    expect(TOP_ACTIONS.x_ads.promote_post.resolve).toBe(resolveXPromotePost);
    expect(TOP_ACTIONS.x_ads.create_new_ad.clientInputs).toBe(xCreateNewAdClientInputs);
    expect(TOP_ACTIONS.x_ads.create_new_ad.resolve).toBe(resolveXCreateNewAd);
    expect(TOP_ACTIONS.x_ads.promote_post.tools).not.toContain("x_ads__search_locations");
  });

  it("a new ad needs what it is about, and a link when the goal is website visits", () => {
    expect(xCreateNewAdClientInputs.safeParse({ about: "Book a car", daily_budget: 10 }).success).toBe(true);
    expect(xCreateNewAdClientInputs.safeParse({ about: "Book a car", daily_budget: 10, goal: "visit" }).error?.issues[0].path).toEqual(["link"]);
    expect(xCreateNewAdClientInputs.safeParse({ about: "Book a car", daily_budget: 10, goal: "visit", link: "https://e.x/start" }).success).toBe(true);
    expect(xCreateNewAdClientInputs.safeParse({ about: "", daily_budget: 10 }).success).toBe(false);
    expect(xCreateNewAdClientInputs.safeParse({ about: "Book a car", daily_budget: 10, goal: "video" }).success).toBe(false);
    expect(xPromotePostClientInputs.safeParse({ ...base, goal: "video" }).success).toBe(true);
    expect(xCreateNewAdInputs.safeParse({ about: "Book a car", daily_budget: 10 }).success).toBe(false);
  });

  it("reads keywords and languages as typed", () => {
    expect(xKeywordsOf(" SaaS, startup\nfounders , saas ,, ")).toEqual(["SaaS", "startup", "founders"]);
    expect(xLanguagesOf("en, ES fr en")).toEqual(["en", "es", "fr"]);
    expect(xAudienceOf({ keywords: "a", languages: "en", gender: "men", age: "50_plus" })).toEqual({ keywords: ["a"], languages: ["en"], genders: ["MALE"], ages: ["AGE_50_AND_OVER"] });
    expect(xAudienceOf({ gender: "any", age: "any" })).toEqual({ keywords: [], languages: [], genders: [], ages: [] });
  });
});

describe("resolve: the end date and the business's country as X's place", () => {
  it("fills blank places with the country X knows, keeps picked places, and carries the duration as picked", async () => {
    const r = await resolveXPromotePost(xPromotePostClientInputs.parse({ ...base, excluded_places: [la] }), "t1");
    expect(r).toMatchObject({ title: "Promote a post", inputs: { places: [us], excluded_places: [la], duration: "open" } });
    const picked = xPromotePostClientInputs.parse({ ...base, places: [la], duration: "7" });
    const p = await resolveXPromotePost(picked, "t1");
    expect(p).toEqual({ title: "Promote a post", inputs: picked });
    expect(xPromotePostInputs.safeParse((p as { inputs: unknown }).inputs).success).toBe(true);
    expect(await resolveXCreateNewAd(xCreateNewAdClientInputs.parse({ about: "a", daily_budget: 10 }), "t1")).toMatchObject({ title: "Create new ad", inputs: { places: [us] } });
  });

  it("refuses when the country is unknown, unreadable, not in X, X is not connected, or the country is excluded", async () => {
    const client = xPromotePostClientInputs.parse(base);
    company.country = null;
    expect(await resolveXPromotePost(client, "t1")).toEqual({ refusal: expect.stringMatching(/no country on file/) });
    company.fail = true;
    expect(await resolveXPromotePost(client, "t1")).toEqual({ refusal: expect.stringMatching(/Could not read/) });
    company.fail = false;
    company.country = { code: "US", name: "United States" };
    x.place = null;
    expect(await resolveXPromotePost(client, "t1")).toEqual({ refusal: expect.stringMatching(/no place for United States/) });
    x.place = { ...us, type: "COUNTRIES", country_code: "US" };
    x.token = new ExpectedToolError("x_ads_not_connected", "no");
    expect(await resolveXPromotePost(client, "t1")).toEqual({ refusal: expect.stringMatching(/not connected/) });
    x.token = null;
    x.search = new ExpectedToolError("x_ads_rate_limited", "slow");
    expect(await resolveXPromotePost(client, "t1")).toEqual({ refusal: expect.stringMatching(/Try again in a minute/) });
    x.search = null;
    expect(await resolveXPromotePost(xPromotePostClientInputs.parse({ ...base, excluded_places: [us] }), "t1")).toEqual({ refusal: expect.stringMatching(/cannot also be excluded/) });
  });

  it("the form's pre-fill is the same place, and empty when X cannot say", async () => {
    expect(await TOP_ACTIONS.x_ads.promote_post.context!("t1")).toEqual({ places: [us] });
    x.search = new Error("down");
    expect(await TOP_ACTIONS.x_ads.create_new_ad.context!("t1")).toEqual({ places: [] });
  });
});

describe("the proposal must match the form exactly", () => {
  const inputs = xPromotePostInputs.parse({ ...base, places: [us], excluded_places: [la], goal: "visit", total_budget: 200, duration: "14", keywords: "saas, startup", languages: "en", gender: "women", age: "25_49" });
  const good = bodyFor(inputs, { objective: "WEBSITE_CLICKS", total_budget: 200, duration_days: 14, audience: { keywords: ["saas", "startup"], languages: ["en"], genders: ["FEMALE"], ages: ["AGE_25_TO_49"] } });

  it("passes the exact proposal and refuses each drift", () => {
    expect(xCampaignMustMatch(inputs, CLS, good)).toBeNull();
    expect(xCampaignMustMatch(inputs, "x_ads.update_campaign", {})).toBeNull();
    expect(xCampaignMustMatch(inputs, CLS, { ...good, locations: [la] })).toMatch(/target exactly the places/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, objective: "ENGAGEMENTS" })).toMatch(/exactly WEBSITE_CLICKS/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, daily_budget: 999 })).toMatch(/daily budget must be at most 10/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, daily_budget: 10.004 })).toBeNull();
    expect(xCampaignMustMatch(inputs, CLS, { ...good, daily_budget: undefined })).toMatch(/daily budget must be at most 10/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, daily_budget: 0 })).toMatch(/daily budget must be at most 10/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, total_budget: 150 })).toMatch(/total budget must be exactly 200/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, duration_days: 7 })).toMatch(/run exactly 14 days/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, duration_days: null })).toMatch(/run exactly 14 days/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, end_time: "2030-01-09T00:00:00Z" })).toMatch(/duration, not an end date/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, start_time: "2099-01-01T00:00:00Z" })).toMatch(/no start date/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, start_time: new Date().toISOString() })).toBeNull();
    expect(xCampaignMustMatch(inputs, CLS, { ...good, start_time: new Date(Date.now() + 5 * 60_000).toISOString() })).toMatch(/no start date/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, audience: { ...good.audience, keywords: ["saas"] } })).toMatch(/keywords must be exactly \["saas","startup"\]/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, audience: { ...good.audience, genders: [] } })).toMatch(/genders must be exactly \["FEMALE"\]/);
    expect(xCampaignMustMatch(inputs, CLS, { ...good, audience: { ...good.audience, ages: ["AGE_18_TO_34"] } })).toMatch(/ages must be exactly/);
  });

  it("with nothing optional asked for, the proposal may add nothing", () => {
    const plain = xPromotePostInputs.parse({ ...base, places: [us] });
    expect(xCampaignMustMatch(plain, CLS, bodyFor(plain))).toBeNull();
    expect(xCampaignMustMatch(plain, CLS, bodyFor(plain, { total_budget: 50 }))).toMatch(/no total budget/);
    expect(xCampaignMustMatch(plain, CLS, bodyFor(plain, { duration_days: 7 }))).toMatch(/set no end/);
    expect(xCampaignMustMatch(plain, CLS, bodyFor(plain, { end_time: "2030-01-01T00:00:00Z" }))).toMatch(/duration, not an end date/);
    expect(xCampaignMustMatch(plain, CLS, bodyFor(plain, { audience: { keywords: ["x"], languages: [], genders: [], ages: [] } }))).toMatch(/no keywords/);
    expect(xCampaignMustMatch(plain, CLS, bodyFor(plain, { excluded_locations: [la] }))).toMatch(/excluded no places/);
    expect(topActionProposalProblem(payload("promote_post", plain), CLS, bodyFor(plain, { objective: "REACH" }))).toMatch(/exactly ENGAGEMENTS/);
  });

  it("promote: the proposal carries exactly the founder's posts and no new one", () => {
    const two = xPromotePostInputs.parse({ ...base, posts: "https://x.com/u/status/1\nhttps://x.com/u/status/2", places: [us] });
    expect(xPromoteMustMatch(two, CLS, bodyFor(two, { tweet_ids: ["2", "1"] }))).toBeNull();
    expect(xPromoteMustMatch(two, CLS, bodyFor(two, { tweet_ids: ["1"] }))).toMatch(/exactly the founder's posts \(tweet_ids \["1","2"\]\)/);
    expect(xPromoteMustMatch(two, CLS, bodyFor(two, { tweet_ids: ["1", "2", "3"] }))).toMatch(/exactly the founder's posts/);
    expect(xPromoteMustMatch(two, CLS, bodyFor(two, { tweet_ids: ["1", "2"], new_post: { text: "extra" } }))).toMatch(/not a new one/);
    expect(xPromoteMustMatch(two, CLS, bodyFor(two, { tweet_ids: ["1", "2"], daily_budget: 999 }))).toMatch(/daily budget/);
    expect(topActionProposalProblem(payload("promote_post", two), CLS, bodyFor(two, { tweet_ids: ["2"], new_post: { text: "x" } }))).toMatch(/exactly the founder's posts/);
    expect(TOP_ACTIONS.x_ads.promote_post.checkProposal).toBe(xPromoteMustMatch);
    expect(TOP_ACTIONS.x_ads.create_new_ad.checkProposal).toBe(xNewAdMustMatch);
  });

  it("a new ad files one new post ending with the founder's link, no other link, and no existing post", () => {
    const ad = xCreateNewAdInputs.parse({ about: "Book a car", link: "https://e.x/start", daily_budget: 10, goal: "visit", places: [us] });
    const okBody = bodyFor(ad, { objective: "WEBSITE_CLICKS", tweet_ids: [], new_post: { text: "Book a car in two taps. https://e.x/start" } });
    expect(xNewAdMustMatch(ad, CLS, okBody)).toBeNull();
    expect(xNewAdMustMatch(ad, CLS, { ...okBody, new_post: null })).toMatch(/new_post_text/);
    expect(xNewAdMustMatch(ad, CLS, { ...okBody, tweet_ids: ["1"] })).toMatch(/no tweet_ids/);
    expect(xNewAdMustMatch(ad, CLS, { ...okBody, new_post: { text: "Book a car" } })).toMatch(/end with the founder's link/);
    expect(xNewAdMustMatch(ad, CLS, { ...okBody, new_post: { text: "https://e.x/start Book a car" } })).toMatch(/end with the founder's link/);
    expect(xNewAdMustMatch(ad, CLS, { ...okBody, new_post: { text: "See https://other.x then https://e.x/start" } })).toMatch(/no other link/);
    expect(xNewAdMustMatch(ad, CLS, { ...okBody, objective: "REACH" })).toMatch(/exactly WEBSITE_CLICKS/);
    expect(topActionProposalProblem(payload("create_new_ad", ad), CLS, { ...okBody, tweet_ids: ["1"] })).toMatch(/no tweet_ids/);
    const noLink = xCreateNewAdInputs.parse({ about: "Book a car", daily_budget: 10, places: [us] });
    expect(xNewAdMustMatch(noLink, CLS, bodyFor(noLink, { tweet_ids: [], new_post: { text: "Book a car in two taps." } }))).toBeNull();
    expect(xNewAdMustMatch(noLink, CLS, bodyFor(noLink, { tweet_ids: [], new_post: { text: "Book a car https://made.up" } }))).toMatch(/gave no link/);
  });
});

describe("the instructions name every exact argument", () => {
  it("promote: objective, budgets, end, places, exclusions and audience as tool arguments", () => {
    const text = TOP_ACTIONS.x_ads.promote_post.instruction({ ...base, places: [us], excluded_places: [la], goal: "visit", total_budget: 200, duration: "14", keywords: "saas", languages: "en", gender: "men", age: "18_34" });
    expect(text).toContain("Objective: exactly WEBSITE_CLICKS. Every promoted post must carry a link.");
    expect(text).toContain("total_budget exactly 200");
    expect(text).toContain("duration_days exactly 14");
    expect(text).toContain('keywords exactly ["saas"]');
    expect(text).toContain('genders exactly ["MALE"]');
    expect(text).toContain('ages exactly ["AGE_18_TO_34"]');
    const plain = TOP_ACTIONS.x_ads.promote_post.instruction({ ...base, places: [us] });
    expect(plain).toContain("pass no total_budget");
    expect(plain).toContain("pass no end_time and no duration_days");
    expect(plain).toContain("pass no keywords");
  });

  it("create new ad: the post is written by the run, carries the link, and is promoted-only", () => {
    const text = TOP_ACTIONS.x_ads.create_new_ad.instruction({ about: 'Book "fast"', link: "https://e.x/start", daily_budget: 10, goal: "visit", places: [us] });
    expect(text).toContain('"Book \\"fast\\""');
    expect(text).toContain("The post ends with exactly this link");
    expect(text).toContain("new_post_text exactly that post, no tweet_ids");
    expect(text).toContain("promoted-only");
    expect(TOP_ACTIONS.x_ads.create_new_ad.instruction({ about: "a", daily_budget: 10, places: [us] })).toContain("Link: none");
  });
});
