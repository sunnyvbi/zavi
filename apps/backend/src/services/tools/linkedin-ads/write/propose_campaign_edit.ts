import { z } from "zod";
import { LINKEDIN_AUDIENCE_FACETS, LINKEDIN_AUDIENCE_LABELS, linkedinAudienceSchema, type LinkedInAudience } from "@zavi/shared";
import { canonicalTargeting } from "@/services/connectors/linkedin-ads/account-reads";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAdsGet } from "@/services/connectors/linkedin-ads/http";
import { linkedinLocationIncludable, linkedinLocationInEu, resolveLinkedinLocationNames, verifyLinkedinLocations } from "@/services/connectors/linkedin-ads/targeting";
import type { LiRawCampaign } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_CAMPAIGN_EDIT_CLASS, type LinkedInCampaignEditBody } from "../_change-bodies";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";
import { currentLocationUrns, replaceLocations } from "./propose_targeting_change";

const LOCATIONS_FACET = "urn:li:adTargetingFacet:locations";
const LOCALES_FACET = "urn:li:adTargetingFacet:interfaceLocales";
const FACET_PREFIX = "urn:li:adTargetingFacet:";
const ENDED = new Set(["CANCELED", "ARCHIVED", "PENDING_DELETION", "REMOVED"]);
const MAX_PLACES = 10;
const numericId = z.string().regex(/^\d{1,20}$/);
const amount = z.string().regex(/^\d+(\.\d{1,2})?$/, "an amount like 12 or 12.50");

const inputSchema = z
  .object({
    campaign_id: numericId.describe("LinkedIn campaign id, from linkedin_ads_list_campaigns."),
    account_id: numericId.describe("The ad account the campaign belongs to."),
    rationale: z.string().min(1).max(500).describe("Why, citing the numbers you read."),
    new_name: z.string().trim().min(1).max(255).optional().describe("A new campaign name."),
    run_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("New end date (UTC, YYYY-MM-DD, after today)."),
    clear_end_date: z.boolean().optional().describe("True to remove the end date so the campaign runs until paused."),
    bid: amount.optional().describe("New bid (unit cost) in the account currency, as a plain amount."),
    audience_expansion: z.boolean().optional().describe("Turn LinkedIn's audience expansion on or off."),
    offsite_delivery: z.boolean().optional().describe("Turn the LinkedIn Audience Network on or off."),
    add_locations: z.array(z.string().trim().min(2).max(120)).max(MAX_PLACES).default([]).describe("Place names to start showing in, as LinkedIn names them. Countries and non-EU regions only."),
    remove_locations: z.array(z.string().trim().min(2).max(120)).max(MAX_PLACES).default([]).describe("Place names to stop showing in, as the campaign's current locations are named."),
    audience: linkedinAudienceSchema.optional().describe("Replaces every non-location audience facet with these URNs (from linkedin_ads_search_targeting). Locations and interface language stay."),
  })
  .strict()
  .refine((v) => !(v.run_until && v.clear_end_date), { message: "Pass run_until or clear_end_date, not both." })
  .refine(
    (v) => v.new_name !== undefined || v.run_until !== undefined || v.clear_end_date === true || v.bid !== undefined || v.audience_expansion !== undefined || v.offsite_delivery !== undefined || v.add_locations.length + v.remove_locations.length > 0 || v.audience !== undefined,
    { message: "Pass at least one change." },
  );

export type CampaignEditArgs = z.infer<typeof inputSchema>;
type Clause = { or?: Record<string, unknown> };
type Criteria = { include?: { and?: Clause[] }; exclude?: unknown };
type LiRawCampaignFull = LiRawCampaign & { unitCost?: { amount: string; currencyCode: string }; audienceExpansionEnabled?: boolean; offsiteDeliveryEnabled?: boolean };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const money = (amt: string, currency: string) => ({ amount: Number(amt).toFixed(2), currency });
const facetLabel = (facet: string) => {
  const short = facet.replace(FACET_PREFIX, "");
  return (LINKEDIN_AUDIENCE_LABELS as Record<string, string>)[short] ?? short.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
};

export function endDateChange(live: { runSchedule?: { start?: number; end?: number } }, args: { run_until?: string; clear_end_date?: boolean }, now: Date): { before: string | null; after: string | null } | null {
  const before = typeof live.runSchedule?.end === "number" ? new Date(live.runSchedule.end).toISOString() : null;
  if (args.clear_end_date) return before === null ? null : { before, after: null };
  if (!args.run_until) return null;
  const end = Date.parse(`${args.run_until}T23:59:59.000Z`);
  if (Number.isNaN(end) || ymd(new Date(end)) !== args.run_until || args.run_until <= ymd(now)) throw new ExpectedToolError("linkedin_ads_end_date_passed", `run_until ${args.run_until} is not a calendar date after today (${ymd(now)}).`);
  const after = new Date(end).toISOString();
  return before === after ? null : { before, after };
}

export function replaceAudienceFacets(criteria: unknown, audience: LinkedInAudience): Criteria {
  const c = JSON.parse(JSON.stringify(criteria ?? {})) as Criteria;
  const and: Clause[] = Array.isArray(c.include?.and) ? c.include!.and! : [];
  if (!and.some((cl) => cl?.or && LOCALES_FACET in cl.or)) throw new ExpectedToolError("linkedin_ads_targeting_invalid", "This campaign's audience has no interface language, which LinkedIn requires, so Zavi will not rewrite it. Fix it in Campaign Manager first.");
  const kept = and.filter((cl) => cl?.or && (LOCATIONS_FACET in cl.or || LOCALES_FACET in cl.or));
  const parsed = linkedinAudienceSchema.parse(audience);
  for (const facet of LINKEDIN_AUDIENCE_FACETS) if (parsed[facet].length) kept.push({ or: { [`${FACET_PREFIX}${facet}`]: [...new Set(parsed[facet])] } });
  c.include = { ...(c.include ?? {}), and: kept };
  return c;
}

function facetUrns(criteria: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const and = (criteria as Criteria | undefined)?.include?.and;
  if (!Array.isArray(and)) return out;
  for (const cl of and) {
    for (const [facet, v] of Object.entries(cl?.or ?? {})) {
      if (facet === LOCATIONS_FACET || facet === LOCALES_FACET || !Array.isArray(v)) continue;
      out.set(facet, [...(out.get(facet) ?? []), ...v.filter((x): x is string => typeof x === "string")]);
    }
  }
  return out;
}

const entitySchema = z.object({ urn: z.string(), name: z.string().min(1).max(300), facetUrn: z.string() });

async function entityNames(token: string, urns: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(urns)];
  const names = new Map<string, string>();
  if (!unique.length) return names;
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", { q: "urns", urns: unique, queryVersion: "QUERY_USES_URNS", locale: { language: "en", country: "US" } });
  for (const raw of response.elements ?? []) {
    const e = entitySchema.safeParse(raw);
    if (e.success && unique.includes(e.data.urn)) names.set(e.data.urn, e.data.name);
  }
  return names;
}

export function targetingSummary(criteria: unknown, locationNames: Map<string, string>, names: Map<string, string>): string {
  const parts: string[] = [];
  const locations = currentLocationUrns(criteria).map((u) => locationNames.get(u) ?? u);
  parts.push(`Locations: ${locations.join(", ") || "none"}`);
  for (const [facet, urns] of facetUrns(criteria)) parts.push(`${facetLabel(facet)}: ${[...new Set(urns)].map((u) => names.get(u) ?? u).join(" or ")}`);
  const exclude = (criteria as Criteria | undefined)?.exclude;
  if (exclude) parts.push("with exclusions kept");
  return parts.join("; ").slice(0, 2000);
}

const norm = (s: string) => s.trim().toLowerCase();
const matchesPlace = (want: string, name: string) => norm(name) === norm(want) || (!want.includes(",") && norm(name.split(",")[0]) === norm(want));

async function targetingChange(token: string, live: LiRawCampaignFull, args: CampaignEditArgs): Promise<LinkedInCampaignEditBody["changes"]["targeting"] | null> {
  const beforeUrns = currentLocationUrns(live.targetingCriteria);
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
  let after: Criteria = replaceLocations(live.targetingCriteria, afterUrns);
  if (args.audience) after = replaceAudienceFacets(after, args.audience);
  const before_fingerprint = canonicalTargeting(live.targetingCriteria);
  if (canonicalTargeting(after) === before_fingerprint) return null;
  const locationNames = new Map(beforeNames);
  for (const f of found) locationNames.set(f.id, f.name);
  const names = await entityNames(token, [...facetUrns(live.targetingCriteria).values(), ...facetUrns(after).values()].flat());
  return { before_fingerprint, after_criteria: after, summary_before: targetingSummary(live.targetingCriteria, locationNames, names), summary_after: targetingSummary(after, locationNames, names) };
}

export async function readLinkedInCampaignEditBody(tenant_id: string, args: CampaignEditArgs, now = new Date()): Promise<LinkedInCampaignEditBody> {
  const t = await readOwnCampaignTarget(tenant_id, args, "Zavi does not edit it; its launch flow owns its settings");
  const label = t.name !== t.id ? `"${t.name}"` : "This campaign";
  if (t.status && ENDED.has(t.status)) throw new ExpectedToolError("linkedin_ads_campaign_ended", `${label} is ${t.status.toLowerCase()}, so it cannot be edited.`);
  const live = t.live as LiRawCampaignFull;
  const changes: LinkedInCampaignEditBody["changes"] = {};
  if (args.new_name !== undefined && args.new_name !== t.name) changes.name = { before: t.name, after: args.new_name };
  const end = endDateChange(live, args, now);
  if (end) changes.run_end_at = end;
  if (args.bid !== undefined) {
    if (!(Number(args.bid) > 0)) throw new ExpectedToolError("linkedin_ads_bid_zero", "A bid of 0 is not a bid. Pass the amount LinkedIn should bid, in the account currency.");
    if (!live.unitCost) throw new ExpectedToolError("linkedin_ads_bid_unread", `LinkedIn did not return the current bid of ${label}, so Zavi cannot show the change. Check the bid in Campaign Manager.`);
    const before = money(live.unitCost.amount, live.unitCost.currencyCode);
    const after = money(args.bid, live.unitCost.currencyCode);
    if (before.amount !== after.amount) changes.unit_cost = { before, after };
  }
  if (args.audience_expansion !== undefined && (live.audienceExpansionEnabled ?? false) !== args.audience_expansion) changes.audience_expansion = { before: live.audienceExpansionEnabled ?? false, after: args.audience_expansion };
  if (args.offsite_delivery !== undefined && (live.offsiteDeliveryEnabled ?? false) !== args.offsite_delivery) changes.offsite_delivery = { before: live.offsiteDeliveryEnabled ?? false, after: args.offsite_delivery };
  if (args.add_locations.length || args.remove_locations.length || args.audience) {
    const targeting = await withLinkedInAdsToken(tenant_id, (token) => targetingChange(token, live, args));
    if (targeting) changes.targeting = targeting;
  }
  if (!Object.keys(changes).length) throw new ExpectedToolError("linkedin_ads_change_empty", `${label} already has every setting you asked for, so there is nothing to change.`);
  return {
    campaign_id: t.id,
    account_id: args.account_id,
    name: t.name,
    rationale: args.rationale,
    last_modified_at: typeof live.changeAuditStamps?.lastModified?.time === "number" ? new Date(live.changeAuditStamps.lastModified.time).toISOString() : null,
    changes,
  };
}

export const linkedinAdsProposeCampaignEditTool: ToolSpec = {
  name: "linkedin_ads_propose_campaign_edit",
  effect: "write",
  description:
    "Propose editing one LinkedIn Ads campaign in the founder's own ad account: its name, end date, bid, audience expansion, LinkedIn Audience Network, locations, or the non-location audience facets. Files a card on the LinkedIn Ads channel's Actions tab for the founder, or cgo on Autopilot with an ad budget, to approve (locations: the founder only); if the campaign is edited in LinkedIn before approval the card does nothing. Every 'before' on the card is what LinkedIn shows now. Budget changes use linkedin_ads_propose_budget_change; pausing uses linkedin_ads_propose_pause_campaign. EU locations are never added. A campaign in Zavi's shared account is refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInCampaignEditBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_CAMPAIGN_EDIT_CLASS, body);
    return { action_id, status: "waiting_for_owner", campaign: { id: body.campaign_id, name: body.name }, changes: body.changes };
  },
};
