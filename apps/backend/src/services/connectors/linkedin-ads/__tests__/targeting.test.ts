import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), accounts: vi.fn(), binding: vi.fn(), resolve: vi.fn() }));
vi.mock("../http", () => ({ linkedinAdsGet: m.get }));
vi.mock("../client", () => ({ linkedinAdsToken: async () => "customer-token", listLinkedInAdAccounts: m.accounts }));
vi.mock("../action-read", () => ({ readAction: async () => ({}), assertReviewable: () => {} }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: m.binding }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: m.resolve }));
import { searchLinkedinTargeting, verifyLinkedinAudience, searchLinkedinLocations, verifyLinkedinLocations, resolveLinkedinLocationNames, linkedinLocationInEu, linkedinLocationIncludable } from "../targeting";
import { linkedinAudienceSchema, linkedinTargetingCriteria } from "@zavi/shared";
const entity = (facet: string, urn: string, name: string) => ({ facetUrn: `urn:li:adTargetingFacet:${facet}`, urn, name });
beforeEach(() => {
  vi.resetAllMocks();
  m.accounts.mockResolvedValue([{ id: "11" }]);
  m.get.mockResolvedValue({ elements: [entity("titles", "urn:li:title:1", "Chief Executive Officer")] });
  m.binding.mockResolvedValue({ id: "binding" });
  m.resolve.mockResolvedValue({ token: "managed-token", account: { id: "11" } });
});
it("uses LinkedIn typeahead for job titles on the selected customer account", async () => {
  expect(await searchLinkedinTargeting("t", "a", { account_id: "11", facet: "titles", query: "Chief" })).toEqual({ options: [{ urn: "urn:li:title:1", name: "Chief Executive Officer" }] });
  expect(m.get).toHaveBeenCalledWith("customer-token", "adTargetingEntities", expect.objectContaining({ q: "typeahead", query: "Chief", facet: "urn:li:adTargetingFacet:titles" }));
});
it.each(["seniorities", "staffCountRanges"])("uses the finite-facet finder for %s", async facet => {
  m.get.mockResolvedValue({ elements: [] });
  await searchLinkedinTargeting("t", "a", { account_id: "11", facet });
  expect(m.get).toHaveBeenCalledWith("customer-token", "adTargetingEntities", expect.objectContaining({ q: "adTargetingFacet", facet: `urn:li:adTargetingFacet:${facet}` }));
});
it("rejects account mismatch before searching", async () => {
  await expect(searchLinkedinTargeting("t", "a", { account_id: "99", facet: "titles", query: "Chief" })).rejects.toThrow("verify");
  expect(m.get).not.toHaveBeenCalled();
});
it("uses the selected managed credential and verifies its account", async () => {
  const binding = "10000000-0000-4000-8000-000000000003";
  await searchLinkedinTargeting("t", "a", { account_id: "11", account_binding_id: binding, facet: "titles", query: "Chief" });
  expect(m.get).toHaveBeenCalledWith("managed-token", "adTargetingEntities", expect.any(Object));
  m.resolve.mockResolvedValue({ account: { id: "99" } }); m.get.mockClear();
  await expect(searchLinkedinTargeting("t", "a", { account_id: "11", account_binding_id: binding, facet: "titles", query: "Chief" })).rejects.toThrow();
  expect(m.get).not.toHaveBeenCalled();
});
it("re-resolves selected URNs and uses provider names in the approval", async () => {
  m.get.mockResolvedValue({ elements: [entity("titles", "urn:li:title:1", "Chief Executive Officer"), entity("industries", "urn:li:industry:4", "Software Development"), entity("staffCountRanges", "urn:li:staffCountRange:(51,200)", "51-200 employees")] });
  const result = await verifyLinkedinAudience("token", { titles: ["urn:li:title:1"], industries: ["urn:li:industry:4"], staffCountRanges: ["urn:li:staffCountRange:(51,200)"] });
  expect(m.get).toHaveBeenCalledWith("token", "adTargetingEntities", expect.objectContaining({ q: "urns", urns: expect.arrayContaining(["urn:li:title:1", "urn:li:staffCountRange:(51,200)"]) }));
  expect(result.rows).toContainEqual({ item: "Company size", before: "Not chosen", after: "51-200 employees" });
  const criteria = linkedinTargetingCriteria(["urn:li:geo:1"], "en_US", result.audience);
  expect(criteria.include.and).toContainEqual({ or: { "urn:li:adTargetingFacet:industries": ["urn:li:industry:4"] } });
  expect(criteria.include.and).toHaveLength(5);
});
it.each([{ elements: [] }, { elements: [entity("industries", "urn:li:title:1", "Wrong facet")] }, { elements: [{ ...entity("titles", "urn:li:title:1", "Unavailable"), isTargetable: false }] }])("refuses missing, mismatched or untargetable selected entities", async response => {
  m.get.mockResolvedValue(response);
  await expect(verifyLinkedinAudience("token", { titles: ["urn:li:title:1"] })).rejects.toThrow();
});
it("refuses unsupported facets and LinkedIn's prohibited title/seniority AND combination", () => {
  expect(() => linkedinAudienceSchema.parse({ titles: ["urn:li:title:1"], seniorities: ["urn:li:seniority:7"] })).toThrow("job titles or seniority");
  expect(() => linkedinAudienceSchema.parse({ industries: ["urn:li:title:1"] })).toThrow();
  expect(() => linkedinAudienceSchema.parse({ genders: ["urn:li:gender:1"] })).toThrow();
});

const place = (urn: string, name: string) => entity("locations", urn, name);
it("searches LinkedIn locations by typeahead on the selected account and returns picker rows", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:102095887", "California, United States"), place("urn:li:geo:102095887", "California, United States"), { ...place("urn:li:geo:5", "Closed"), isTargetable: false }] });
  expect(await searchLinkedinLocations("t", "a", { q: "Calif", account_id: "11" })).toEqual({ locations: [{ id: "urn:li:geo:102095887", name: "California, United States", eu: false, includable: true }] });
  expect(m.get).toHaveBeenCalledWith("customer-token", "adTargetingEntities", expect.objectContaining({ q: "typeahead", facet: "urn:li:adTargetingFacet:locations", query: "Calif" }));
});
it("marks EU and EEA places and places with no country as exclude-only in the location search", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:1", "Germany"), place("urn:li:geo:2", "Bavaria, Germany"), place("urn:li:geo:3", "Réunion"), place("urn:li:geo:4", "Greater Munich Metropolitan Area"), place("urn:li:geo:5", "Canada"), place("urn:li:geo:6", "Germany, Ohio, United States")] });
  expect((await searchLinkedinLocations("t", "a", { q: "Germ", account_id: "11" })).locations.map(l => [l.name, l.eu, l.includable])).toEqual([
    ["Germany", true, false], ["Bavaria, Germany", true, false], ["Réunion", true, false], ["Greater Munich Metropolitan Area", false, false], ["Canada", false, true], ["Germany, Ohio, United States", false, true],
  ]);
});
it.each([[{ elements: [entity("profileLocations", "urn:li:geo:1", "Home")] }], [{ elements: [place("urn:li:title:1", "Not a place")] }], [{}]])("refuses a location answer that is not a targetable geo", async response => {
  m.get.mockResolvedValue(response);
  await expect(searchLinkedinLocations("t", "a", { q: "Home", account_id: "11" })).rejects.toThrow("locations");
});
it("does not search for one character or for another account", async () => {
  await expect(searchLinkedinLocations("t", "a", { q: "C", account_id: "11" })).rejects.toThrow();
  await expect(searchLinkedinLocations("t", "a", { q: "Calif", account_id: "99" })).rejects.toThrow();
  expect(m.get).not.toHaveBeenCalled();
});
it("verifies every chosen place and refuses one LinkedIn no longer returns as a location", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:1", "Texas, United States"), entity("profileLocations", "urn:li:geo:2", "Ohio")] });
  await expect(verifyLinkedinLocations("token", ["urn:li:geo:1", "urn:li:geo:2"])).rejects.toThrow("locations");
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:1", "Texas, United States"), place("urn:li:geo:2", "Ohio, United States")] });
  expect([...(await verifyLinkedinLocations("token", ["urn:li:geo:1", "urn:li:geo:2", "urn:li:geo:1"]))]).toEqual([["urn:li:geo:1", "Texas, United States"], ["urn:li:geo:2", "Ohio, United States"]]);
  expect(m.get).toHaveBeenLastCalledWith("token", "adTargetingEntities", expect.objectContaining({ q: "urns", urns: ["urn:li:geo:1", "urn:li:geo:2"] }));
});
it("resolves the agent's place names to the closest LinkedIn location", async () => {
  m.get.mockResolvedValueOnce({ elements: [place("urn:li:geo:9", "Texas City, Texas, United States"), place("urn:li:geo:1", "Texas, United States")] })
    .mockResolvedValueOnce({ elements: [place("urn:li:geo:3", "Ontario, Canada")] });
  expect(await resolveLinkedinLocationNames("token", ["Texas", "Ontario"])).toEqual({ found: [{ id: "urn:li:geo:1", name: "Texas, United States" }, { id: "urn:li:geo:3", name: "Ontario, Canada" }], missed: [] });
});
it("reports a place name with no exact LinkedIn match instead of guessing the first result", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:7", "Springfield, Illinois, United States"), place("urn:li:geo:8", "West Springfield, Massachusetts, United States")] });
  expect(await resolveLinkedinLocationNames("token", ["Springfeld"])).toEqual({ found: [], missed: ["Springfeld"] });
});
it.each([["Germany", true], ["Berlin, Germany", true], ["Europe", true], ["Norway", true], ["United Kingdom", false], ["California, United States", false], ["New Jersey, United States", false], ["Greece, New York, United States", false], ["Malta, Montana, United States", false], ["Paris, Île-de-France, France", true], ["Réunion", true], ["Saint-Denis, Réunion", true], ["French Guiana", true], ["Åland Islands", true], ["Canary Islands", true]])("flags %s as EU or EEA: %s", (name, eu) => {
  expect(linkedinLocationInEu(name)).toBe(eu);
});
it.each([
  ["United States", true], ["Texas, United States", true], ["Ontario, Canada", true], ["India", true], ["South Africa", true], ["Asia", true], ["Oceania", true],
  ["Germany", false], ["Berlin, Germany", false], ["Greater Munich Metropolitan Area", false], ["San Francisco Bay Area", false], ["European Union", false], ["Eurozone", false],
])("only includes %s when its country is known and outside the EU: %s", (name, ok) => {
  expect(linkedinLocationIncludable(name)).toBe(ok);
});
it("leaves a bare name unresolved when several LinkedIn places start with it", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:7", "Portland, Oregon, United States"), place("urn:li:geo:8", "Portland, Maine, United States")] });
  expect(await resolveLinkedinLocationNames("token", ["Portland"])).toEqual({ found: [], missed: ["Portland"] });
});
it.each(["Africa", "South America", "Latin America", "LATAM", "Caribbean", "Americas", "Atlantic"])("refuses %s as an include because it contains EU outermost regions, like the EU itself", (name) => {
  expect(linkedinLocationInEu(name)).toBe(true);
  expect(linkedinLocationIncludable(name)).toBe(false);
});
it("North America is includable because it has no EU territory, in any case or spacing the search returns", () => {
  for (const name of ["North America", "north america", " North America "]) {
    expect(linkedinLocationInEu(name)).toBe(false);
    expect(linkedinLocationIncludable(name)).toBe(true);
  }
  for (const name of ["Greenland", "St. Pierre & Miquelon", "Canada", "United States", "Bermuda"]) expect([name, linkedinLocationIncludable(name)]).toEqual([name, true]);
});
it("the search offers North America as an include and keeps refusing Latin America", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:1", "North America"), place("urn:li:geo:2", "Latin America")] });
  expect((await searchLinkedinLocations("t", "a", { q: "Am", account_id: "11" })).locations.map(l => [l.name, l.eu, l.includable])).toEqual([
    ["North America", false, true],
    ["Latin America", true, false],
  ]);
});
it("the French places in or next to North America stay refused by name", () => {
  for (const name of ["Guadeloupe", "Martinique", "Saint Martin", "St. Martin"]) expect([name, linkedinLocationIncludable(name)]).toEqual([name, false]);
});
it("narrows a region to its non-EU countries: the countries next to EU outermost regions stay includable", () => {
  for (const name of ["Brazil", "Suriname", "Morocco", "Madagascar", "Dominica", "Sint Maarten", "Jamaica"]) expect([name, linkedinLocationIncludable(name)]).toEqual([name, true]);
  for (const name of ["French Guiana", "Guadeloupe", "Martinique", "Canary Islands", "Madeira", "Azores", "Mayotte"]) expect([name, linkedinLocationIncludable(name)]).toEqual([name, false]);
});
it("does not include an EU outermost region that Intl names like a country", () => {
  for (const name of ["Réunion", "Guadeloupe", "Martinique", "Mayotte", "St. Martin", "Åland Islands"]) expect(linkedinLocationIncludable(name)).toBe(false);
});
it("does not pick a country for a bare name a state shares", async () => {
  m.get.mockResolvedValue({ elements: [place("urn:li:geo:1", "Georgia"), place("urn:li:geo:2", "Georgia, United States")] });
  expect(await resolveLinkedinLocationNames("token", ["Georgia"])).toEqual({ found: [], missed: ["Georgia"] });
  expect(await resolveLinkedinLocationNames("token", ["Georgia, United States"])).toEqual({ found: [{ id: "urn:li:geo:2", name: "Georgia, United States" }], missed: [] });
});
