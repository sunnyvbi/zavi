import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAdsGet } from "@/services/connectors/linkedin-ads/http";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { linkedinLocationInEu } from "@/services/connectors/linkedin-ads/targeting";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "./_wallet";

export const LINKEDIN_TYPEAHEAD_FACETS = ["locations", "titles", "industries", "skills", "employers", "schools", "fieldsOfStudy", "degrees", "groups"] as const;
const DEFAULT_FACETS = ["locations", "titles", "industries", "skills"] as const;
const FACET_PREFIX = "urn:li:adTargetingFacet:";

const inputSchema = z
  .object({
    account_id: z.string().regex(/^\d{1,20}$/).describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    query: z.string().trim().min(2).max(120).describe("What to look for, at least two characters."),
    facet: z.enum(LINKEDIN_TYPEAHEAD_FACETS).optional().describe("One facet to search. Default: locations, titles, industries and skills together."),
    limit: z.number().int().min(1).max(25).default(10).describe("Most entities to return per facet."),
  })
  .strict();

const entitySchema = z.object({ urn: z.string(), name: z.string().min(1).max(300), facetUrn: z.string(), isTargetable: z.boolean().optional() });

export type LinkedInTargetingEntity = { urn: string; name: string; facet: string; in_eu?: true };

export async function typeaheadWithToken(token: string, facet: string, query: string, limit: number): Promise<LinkedInTargetingEntity[]> {
  const facetUrn = `${FACET_PREFIX}${facet}`;
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", { q: "typeahead", facet: facetUrn, queryVersion: "QUERY_USES_URNS", locale: { language: "en", country: "US" }, query });
  if (!Array.isArray(response.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not answer the targeting search clearly. Try again in a few minutes.");
  const out: LinkedInTargetingEntity[] = [];
  for (const raw of response.elements) {
    const e = entitySchema.safeParse(raw);
    if (!e.success || e.data.facetUrn !== facetUrn || e.data.isTargetable === false || out.some((o) => o.urn === e.data.urn)) continue;
    out.push({ urn: e.data.urn, name: e.data.name, facet, ...(facet === "locations" && linkedinLocationInEu(e.data.name) ? { in_eu: true as const } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

export const linkedinAdsSearchTargetingTool: ToolSpec = {
  name: "linkedin_ads_search_targeting",
  effect: "read",
  description:
    "Search LinkedIn's targeting entities by name (locations, job titles, industries, skills, employers, schools, fields of study, degrees, groups) and get the URNs that linkedin_ads_propose_campaign_edit's audience and linkedin_ads_propose_launch_campaign accept. Locations inside the EU carry in_eu: true and are never added by Zavi. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    if (!(await linkedinAccountInUse(ctx.tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
    const facets = args.facet ? [args.facet] : [...DEFAULT_FACETS];
    const entities = await withLinkedInAdsToken(ctx.tenant_id, async (token) => (await Promise.all(facets.map((f) => typeaheadWithToken(token, f, args.query, args.limit)))).flat());
    return { account_id: args.account_id, query: args.query, facets, entities };
  },
};
