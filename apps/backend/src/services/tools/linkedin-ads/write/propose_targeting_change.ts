import { z } from "zod";
import { canonicalTargeting } from "@/services/connectors/linkedin-ads/account-reads";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinLocationIncludable, linkedinLocationInEu, resolveLinkedinLocationNames, verifyLinkedinLocations } from "@/services/connectors/linkedin-ads/targeting";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_TARGETING_CLASS, type LinkedInTargetingBody } from "../_change-bodies";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

const LOCATIONS_FACET = "urn:li:adTargetingFacet:locations";
const LOCALES_FACET = "urn:li:adTargetingFacet:interfaceLocales";
const MAX_PLACES = 10;

const inputSchema = z
  .object({
    campaign_id: z.string().regex(/^\d{1,20}$/).describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
    account_id: z.string().regex(/^\d{1,20}$/).describe("The ad account the campaign belongs to."),
    add_locations: z.array(z.string().trim().min(2).max(120)).max(MAX_PLACES).default([]).describe("Place names to start showing in, as LinkedIn names them (\"Canada\", \"Austin, Texas, United States\"). Countries and non-EU regions only; cities and states need the country."),
    remove_locations: z.array(z.string().trim().min(2).max(120)).max(MAX_PLACES).default([]).describe("Place names to stop showing in, exactly as the campaign's current locations are named."),
    rationale: z.string().min(1).max(500).describe("Why, citing the numbers you read per location where you have them."),
  })
  .strict()
  .refine((v) => v.add_locations.length + v.remove_locations.length > 0, { message: "Pass at least one location to add or remove." });

type Args = z.infer<typeof inputSchema>;
type Clause = { or?: Record<string, unknown> };
type Criteria = { include?: { and?: Clause[] }; exclude?: unknown };

const PROFILE_LOCATIONS_FACET = "urn:li:adTargetingFacet:profileLocations";

export function currentLocationUrns(criteria: unknown): string[] {
  const and = (criteria as Criteria | undefined)?.include?.and;
  if (!Array.isArray(and)) throw new ExpectedToolError("linkedin_ads_targeting_invalid", "This campaign's audience could not be read as LinkedIn targeting, so Zavi will not rewrite it.");
  if (and.some((cl) => cl?.or && PROFILE_LOCATIONS_FACET in cl.or))
    throw new ExpectedToolError("linkedin_ads_targeting_profile_locations", "This campaign targets people by profile location, which Zavi does not edit. Change it in Campaign Manager.");
  const clauses = and.filter((cl) => cl?.or && LOCATIONS_FACET in cl.or);
  if (clauses.length !== 1) throw new ExpectedToolError("linkedin_ads_targeting_invalid", clauses.length ? "This campaign's audience lists locations in more than one place, so Zavi will not rewrite it." : "This campaign has no location clause Zavi can edit. Set its locations in Campaign Manager first.");
  const or = clauses[0].or!;
  if (Object.keys(or).length !== 1) throw new ExpectedToolError("linkedin_ads_targeting_invalid", "This campaign's locations are combined with other audience facets, which Zavi does not edit. Change it in Campaign Manager.");
  const v = or[LOCATIONS_FACET];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function replaceLocations(criteria: unknown, urns: string[]): Criteria {
  const c = (criteria && typeof criteria === "object" ? JSON.parse(JSON.stringify(criteria)) : {}) as Criteria;
  const and: Clause[] = Array.isArray(c.include?.and) ? c.include!.and! : [];
  if (!and.some((cl) => cl?.or && LOCALES_FACET in cl.or)) throw new ExpectedToolError("linkedin_ads_targeting_invalid", "This campaign's audience has no interface language, which LinkedIn requires, so Zavi will not rewrite it. Fix it in Campaign Manager first.");
  const idx = and.findIndex((cl) => cl?.or && LOCATIONS_FACET in cl.or);
  if (idx < 0) throw new ExpectedToolError("linkedin_ads_targeting_invalid", "This campaign has no location clause Zavi can edit. Set its locations in Campaign Manager first.");
  and[idx] = { or: { ...and[idx].or, [LOCATIONS_FACET]: urns } };
  c.include = { ...(c.include ?? {}), and };
  return c;
}

const norm = (s: string) => s.trim().toLowerCase();
const matchesPlace = (want: string, name: string) => norm(name) === norm(want) || (!want.includes(",") && norm(name.split(",")[0]) === norm(want));

export async function readLinkedInTargetingBody(tenant_id: string, args: Args): Promise<LinkedInTargetingBody> {
  const t = await readOwnCampaignTarget(tenant_id, args, "its audience is set when it is launched and Zavi does not edit it afterwards");
  if (t.status && ["CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"].includes(t.status))
    throw new ExpectedToolError("linkedin_ads_campaign_ended", `This campaign is ${t.status.toLowerCase()}, so its audience cannot be changed.`);
  const beforeUrns = currentLocationUrns(t.live.targetingCriteria);
  return withLinkedInAdsToken(tenant_id, async (token) => {
    const beforeNames = await verifyLinkedinLocations(token, beforeUrns);
    const removeUrns = new Set<string>();
    const unmatched: string[] = [];
    for (const want of args.remove_locations) {
      const hit = [...beforeNames.entries()].filter(([, name]) => matchesPlace(want, name));
      if (hit.length !== 1) unmatched.push(want);
      else removeUrns.add(hit[0][0]);
    }
    if (unmatched.length) throw new ExpectedToolError("linkedin_ads_location_not_targeted", `This campaign does not show in ${unmatched.join(", ")}. Its locations are: ${[...beforeNames.values()].join(", ") || "none"}.`, { current: [...beforeNames.values()] });
    const { found, missed } = args.add_locations.length ? await resolveLinkedinLocationNames(token, args.add_locations) : { found: [], missed: [] };
    if (missed.length) throw new ExpectedToolError("linkedin_ads_location_unknown", `LinkedIn has no single place named ${missed.join(", ")}. Name it as LinkedIn does, with its state and country for a city.`, { missed });
    const eu = found.filter((f) => linkedinLocationInEu(f.name)).map((f) => f.name);
    if (eu.length) throw new ExpectedToolError("linkedin_ads_location_eu", `Zavi does not add EU locations (${eu.join(", ")}) to a campaign: LinkedIn's EU rules need the founder to set them up in Campaign Manager.`, { eu });
    const bad = found.filter((f) => !linkedinLocationIncludable(f.name)).map((f) => f.name);
    if (bad.length) throw new ExpectedToolError("linkedin_ads_location_not_includable", `${bad.join(", ")} cannot be added as written. Name a country, or a city or state with its country.`, { not_includable: bad });
    const afterUrns = [...beforeUrns.filter((u) => !removeUrns.has(u)), ...found.map((f) => f.id).filter((u) => !beforeUrns.includes(u))];
    if (!afterUrns.length) throw new ExpectedToolError("linkedin_ads_no_locations_left", "Removing those would leave the campaign with no location, which LinkedIn refuses. Pause it instead with linkedin_ads_propose_pause_campaign.");
    if (canonicalTargeting(afterUrns) === canonicalTargeting(beforeUrns)) throw new ExpectedToolError("linkedin_ads_targeting_unchanged", "Those changes leave the campaign's locations as they are.");
    const afterNames = new Map(beforeNames);
    for (const f of found) afterNames.set(f.id, f.name);
    return {
      campaign_id: t.id,
      account_id: args.account_id,
      name: t.name,
      before_fingerprint: canonicalTargeting(t.live.targetingCriteria),
      before_criteria: t.live.targetingCriteria ?? null,
      after_criteria: replaceLocations(t.live.targetingCriteria, afterUrns),
      places_before: beforeUrns.map((u) => beforeNames.get(u) ?? u),
      places_after: afterUrns.map((u) => afterNames.get(u) ?? u),
      rationale: args.rationale,
    };
  });
}

export const linkedinAdsProposeTargetingChangeTool: ToolSpec = {
  name: "linkedin_ads_propose_targeting_change",
  effect: "write",
  description:
    "Propose adding or removing locations on one LinkedIn Ads campaign in the founder's own ad account; everything else about its audience stays. Files a card on the LinkedIn Ads channel's Actions tab that only a workspace owner or admin can approve; nothing is applied on its own, and if the audience is edited in LinkedIn before approval the card does nothing. Place names must be LinkedIn's; EU locations are never added. A campaign in Zavi's shared account is refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInTargetingBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_TARGETING_CLASS, body);
    return { action_id, status: "waiting_for_owner", campaign: { id: body.campaign_id, name: body.name }, locations: { before: body.places_before, after: body.places_after } };
  },
};
