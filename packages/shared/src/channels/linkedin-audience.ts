import { z } from "zod";

export const LINKEDIN_AUDIENCE_FACETS = ["titles", "seniorities", "industries", "staffCountRanges"] as const;
export type LinkedInAudienceFacet = typeof LINKEDIN_AUDIENCE_FACETS[number];
export const LINKEDIN_AUDIENCE_LABELS: Record<LinkedInAudienceFacet, string> = {
  titles: "Job titles", seniorities: "Seniority", industries: "Industries", staffCountRanges: "Company size",
};
export const LINKEDIN_AUDIENCE_URNS: Record<LinkedInAudienceFacet, RegExp> = {
  titles: /^urn:li:title:\d+$/,
  seniorities: /^urn:li:seniority:\d+$/,
  industries: /^urn:li:industry:\d+$/,
  staffCountRanges: /^urn:li:staffCountRange:\(\d+,\d+\)$/,
};
const values = (facet: LinkedInAudienceFacet) => z.array(z.string().regex(LINKEDIN_AUDIENCE_URNS[facet])).max(20).default([]);
export const linkedinAudienceSchema = z.object({
  titles: values("titles"), seniorities: values("seniorities"),
  industries: values("industries"), staffCountRanges: values("staffCountRanges"),
}).strict().refine(a => !(a.titles.length && a.seniorities.length), {
  message: "Choose job titles or seniority. LinkedIn does not allow both together.",
});
export type LinkedInAudience = z.infer<typeof linkedinAudienceSchema>;
const suggestions = () => z.array(z.string().trim().min(1).max(120)).max(10).default([]);
export const linkedinAudienceSuggestionsSchema = z.object({
  titles: suggestions(), seniorities: suggestions(), industries: suggestions(), staffCountRanges: suggestions(),
}).strict();
export type LinkedInAudienceSuggestions = z.infer<typeof linkedinAudienceSuggestionsSchema>;
export type LinkedInAudienceOption = { urn: string; name: string };

export function linkedinTargetingCriteria(geoUrns: string[], locale: string, audience?: LinkedInAudience, excludedGeoUrns: string[] = []) {
  const and: Array<{ or: Record<string, string[]> }> = [
    { or: { "urn:li:adTargetingFacet:locations": geoUrns } },
    { or: { "urn:li:adTargetingFacet:interfaceLocales": [`urn:li:locale:${locale}`] } },
  ];
  if (audience) {
    const parsed = linkedinAudienceSchema.parse(audience);
    for (const facet of LINKEDIN_AUDIENCE_FACETS) {
      if (parsed[facet].length) and.push({ or: { [`urn:li:adTargetingFacet:${facet}`]: [...new Set(parsed[facet])] } });
    }
  }
  const excluded = [...new Set(excludedGeoUrns)];
  return excluded.length
    ? { include: { and }, exclude: { or: { "urn:li:adTargetingFacet:locations": excluded } } }
    : { include: { and } };
}
