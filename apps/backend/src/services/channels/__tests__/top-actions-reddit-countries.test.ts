import { beforeEach, describe, expect, it, vi } from "vitest";

const company = vi.hoisted(() => ({ country: null as { code: string; name: string } | null, fail: false }));
vi.mock("@/services/ad-locations/country", async (orig) => ({
  ...(await orig<object>()),
  businessCountryOrThrow: async () => {
    if (company.fail) throw new Error("down");
    return company.country;
  },
}));

import { TOP_ACTIONS, redditCountriesMustMatch, redditCreateNewAdClientInputs, redditCreateNewAdInputs, resolveRedditCountries, topActionProposalProblem } from "@/services/channels/top-actions";
import { prepareSchema } from "@/services/connectors/reddit-ads/schema";

const base = { about: "a", link: "https://x.example", daily_budget: 20 };
const body = (targeting: Record<string, unknown>) => ({ targeting });
const payload = (inputs: Record<string, unknown>) => ({ channel_slug: "reddit_ads", top_action: { key: "create_new_ad", by: "u", inputs } });

beforeEach(() => {
  company.country = null;
  company.fail = false;
});

describe("Reddit Create new ad: target and excluded countries", () => {
  it("accepts ISO codes in any case, refuses other shapes, unassigned codes and a country in both lists", () => {
    expect(redditCreateNewAdClientInputs.safeParse(base).success).toBe(true);
    expect(redditCreateNewAdClientInputs.safeParse({ ...base, countries: "us, ca", excluded_countries: "GB" }).success).toBe(true);
    expect(redditCreateNewAdClientInputs.safeParse({ ...base, countries: "USA" }).success).toBe(false);
    expect(redditCreateNewAdClientInputs.safeParse({ ...base, countries: "ZZ" }).success).toBe(false);
    expect(redditCreateNewAdClientInputs.safeParse({ ...base, countries: "US", excluded_countries: "zz" }).success).toBe(false);
    expect(redditCreateNewAdClientInputs.safeParse({ ...base, countries: "US", excluded_countries: "us" }).success).toBe(false);
  });

  it("the run's inputs always carry target countries", () => {
    expect(redditCreateNewAdInputs.safeParse(base).success).toBe(false);
    expect(redditCreateNewAdInputs.safeParse({ ...base, countries: "US" }).success).toBe(true);
    expect(TOP_ACTIONS.reddit_ads.create_new_ad.clientInputs).toBe(redditCreateNewAdClientInputs);
    expect(TOP_ACTIONS.reddit_ads.create_new_ad.resolve).toBe(resolveRedditCountries);
  });

  it("fills blank target countries with the business's country and keeps a typed list", async () => {
    company.country = { code: "IN", name: "India" };
    expect(await resolveRedditCountries({ ...base, excluded_countries: "GB" }, "t1")).toEqual({ inputs: { ...base, excluded_countries: "GB", countries: "IN" }, title: "Create new ad" });
    const typed = { ...base, countries: "US, CA" };
    expect(await resolveRedditCountries(typed, "t1")).toEqual({ inputs: typed, title: "Create new ad" });
  });

  it("refuses blank target countries with no business country, an unreadable record, or the default excluded", async () => {
    expect(await resolveRedditCountries(base, "t1")).toEqual({ refusal: expect.stringMatching(/no country on file/) });
    company.fail = true;
    expect(await resolveRedditCountries(base, "t1")).toEqual({ refusal: expect.stringMatching(/Could not read/) });
    company.fail = false;
    company.country = { code: "IN", name: "India" };
    expect(await resolveRedditCountries({ ...base, excluded_countries: "in" }, "t1")).toEqual({ refusal: expect.stringMatching(/cannot also be excluded/) });
  });

  it("tells the run the exact lists", () => {
    const text = TOP_ACTIONS.reddit_ads.create_new_ad.instruction({ ...base, countries: "us, CA", excluded_countries: "gb" });
    expect(text).toContain('targeting.geolocations exactly ["US","CA"]');
    expect(text).toContain('targeting.excluded_geolocations exactly ["GB"]');
    expect(() => TOP_ACTIONS.reddit_ads.create_new_ad.instruction(base)).toThrow();
  });

  it("refuses a proposal whose countries differ from the resolved form", () => {
    const inputs = { ...base, countries: "US, CA", excluded_countries: "GB" };
    expect(redditCountriesMustMatch(inputs, "reddit_ads.prepare_campaign", body({ geolocations: ["CA", "US"], excluded_geolocations: ["GB"] }))).toBeNull();
    expect(redditCountriesMustMatch(inputs, "reddit_ads.prepare_campaign", body({ geolocations: ["US"], excluded_geolocations: ["GB"] }))).toMatch(/exactly the countries/);
    expect(redditCountriesMustMatch(inputs, "reddit_ads.prepare_campaign", body({ geolocations: ["CA", "US"] }))).toMatch(/exclude exactly/);
    const resolved = { ...base, countries: "US" };
    expect(redditCountriesMustMatch(resolved, "reddit_ads.prepare_campaign", body({ geolocations: ["IN"] }))).toMatch(/exactly the countries/);
    expect(redditCountriesMustMatch(resolved, "reddit_ads.prepare_campaign", body({ geolocations: ["US"], excluded_geolocations: ["GB"] }))).toMatch(/excluded no countries/);
    expect(redditCountriesMustMatch(base, "reddit_ads.prepare_campaign", body({ geolocations: ["IN"] }))).toMatch(/no target countries/);
    expect(redditCountriesMustMatch(inputs, "reddit_ads.prepare_campaign", body({ geolocations: ["US", "CA", "US"], excluded_geolocations: ["GB"] }))).toMatch(/exactly the countries/);
    expect(redditCountriesMustMatch(inputs, "reddit_ads.prepare_campaign", body({ geolocations: ["US", "CA"], excluded_geolocations: ["GB", "GB"] }))).toMatch(/exclude exactly/);
    expect(topActionProposalProblem(payload(inputs), "reddit_ads.prepare_campaign", body({ geolocations: ["US"] }))).toMatch(/exactly the countries/);
  });

  it("the campaign plan carries exclusions and refuses a place in both lists, whatever its case", () => {
    const plan = { ad_account_id: "account", profile_id: "profile", pixel_id: "pixel", operation_key: "operation_123", name: "Traffic test", rationale: "r", objective: "CLICKS", daily_budget_usd: 10, lifetime_cap_usd: 100, start_time: "2099-01-01T09:00:00Z", creatives: [{ name: "First image", headline: "Plan your trip", image_url: "https://example.com/i.jpg", destination_url: "https://example.com" }] };
    expect(prepareSchema.parse({ ...plan, targeting: { geolocations: ["US"], excluded_geolocations: ["GB"] } }).targeting.excluded_geolocations).toEqual(["GB"]);
    expect(prepareSchema.parse({ ...plan, targeting: { geolocations: ["US"] } }).targeting).not.toHaveProperty("excluded_geolocations");
    expect(prepareSchema.safeParse({ ...plan, targeting: { geolocations: ["US"], excluded_geolocations: ["US"] } }).success).toBe(false);
    expect(prepareSchema.safeParse({ ...plan, targeting: { geolocations: ["US"], excluded_geolocations: ["us"] } }).success).toBe(false);
    expect(prepareSchema.safeParse({ ...plan, targeting: { geolocations: ["t2_ab"], excluded_geolocations: ["T2_AB"] } }).success).toBe(true);
  });
});
