import { z } from "zod";
import { linkedinAudienceSchema } from "@zavi/shared";
import { listLinkedInAdAccountsWithReference, withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { assertPostFromPage, readPublicPost } from "@/services/connectors/linkedin-ads/post-link";
import { linkedinLocationIncludable, linkedinLocationInEu, resolveLinkedinLocationNames } from "@/services/connectors/linkedin-ads/targeting";
import { listLinkedInRawCampaignsInGroupWithToken, readLinkedInRawCampaignGroupWithToken } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_CREATE_CAMPAIGN_CLASS, type LinkedInCreateCampaignBody } from "../_change-bodies";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "../_wallet";
import { ENDED_STATUSES, ORGANIZATION_URN, postUrnInput } from "./_ad-source";
import { requireChannelRun, emitLinkedInCard } from "./_own-target";

const MAX_PLACES = 10;
const amount = z.string().regex(/^\d+(\.\d{1,2})?$/, "an amount like 25 or 25.50, in the account's currency");

const inputSchema = z
  .object({
    account_id: z.string().regex(/^\d{1,20}$/).describe("The founder's own ad account, from linkedin_ads_list_accounts."),
    group_id: z.string().regex(/^\d{1,20}$/).describe("The campaign group to create the campaign in, from linkedin_ads_list_campaign_groups."),
    name: z.string().trim().min(1).max(255).describe("The campaign's name; must be unused among the group's running campaigns."),
    daily_budget: amount.describe("Daily budget in the account's currency."),
    bid: amount.describe("CPC bid in the account's currency, above 0."),
    locations: z.array(z.string().trim().min(2).max(120)).min(1).max(MAX_PLACES).describe("Place names to show in, as LinkedIn names them. Countries and non-EU regions; cities and states need the country. EU locations are refused."),
    excluded_locations: z.array(z.string().trim().min(2).max(120)).max(MAX_PLACES).optional().describe("Place names to exclude."),
    language: z.string().regex(/^[a-z]{2}$/).default("en").describe("Interface language of the audience, two letters."),
    audience: linkedinAudienceSchema.optional().describe("Job titles or seniorities, industries and company sizes as LinkedIn urns, from linkedin_ads_list_saved_audiences or the targeting search."),
    post_urn: postUrnInput.optional().describe("A post of the account's company page to add as the campaign's first ad, paused."),
    objective_type: z.string().min(1).max(60).optional().describe("LinkedIn objective, e.g. WEBSITE_VISITS or WEBSITE_CONVERSIONS."),
    rationale: z.string().min(1).max(500).describe("Why this campaign, citing what you read about the account's existing campaigns."),
  })
  .strict();

type Args = z.infer<typeof inputSchema>;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_CODES = new Map<string, string>();
for (let a = 65; a < 91; a++)
  for (let b = 65; b < 91; b++) {
    const code = String.fromCharCode(a, b);
    try {
      const name = regionNames.of(code);
      if (name && name !== code) COUNTRY_CODES.set(name.toLowerCase(), code);
    } catch {
      continue;
    }
  }

export function countryOfPlace(name: string): string | null {
  return COUNTRY_CODES.get(name.split(",").pop()!.trim().toLowerCase()) ?? null;
}

async function resolvePlaces(token: string, names: string[], what: string) {
  const { found, missed } = await resolveLinkedinLocationNames(token, names);
  if (missed.length) throw new ExpectedToolError("linkedin_ads_location_unknown", `LinkedIn has no single place named ${missed.join(", ")}. Name it as LinkedIn does, with its state and country for a city.`, { missed });
  const eu = found.filter((f) => linkedinLocationInEu(f.name)).map((f) => f.name);
  if (eu.length) throw new ExpectedToolError("linkedin_ads_location_eu", `Zavi does not ${what} EU locations (${eu.join(", ")}): LinkedIn's EU rules need the founder to set them up in Campaign Manager.`, { eu });
  return found;
}

export async function readLinkedInNewCampaignBody(tenant_id: string, args: Args): Promise<LinkedInCreateCampaignBody> {
  if (!(Number(args.bid) > 0)) throw new ExpectedToolError("linkedin_ads_bid_invalid", "The bid must be above 0; LinkedIn refuses a campaign without one.");
  if (!(Number(args.daily_budget) > 0)) throw new ExpectedToolError("linkedin_ads_budget_zero", "The daily budget must be above 0.");
  if (!(await linkedinAccountInUse(tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
  const account = (await listLinkedInAdAccountsWithReference(tenant_id, true)).find((a) => a.id === args.account_id);
  if (!account) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
  if (!account.currency || !/^[A-Z]{3}$/.test(account.currency)) throw new ExpectedToolError("linkedin_ads_currency_unknown", `LinkedIn did not say which currency the ad account "${account.name}" bills in, so Zavi cannot set a budget for it.`);
  if (!account.reference || !ORGANIZATION_URN.test(account.reference))
    throw new ExpectedToolError("linkedin_ads_page_unknown", `LinkedIn did not say which company page the ad account "${account.name}" advertises for, which a campaign must name. Check the account in Campaign Manager.`);
  const currency = account.currency;
  const associated_entity = account.reference;
  return withLinkedInAdsToken(tenant_id, async (token) => {
    const group = await readLinkedInRawCampaignGroupWithToken(token, args.account_id, args.group_id);
    if (!group) throw new ExpectedToolError("linkedin_ads_group_not_found", "This campaign group is not in this LinkedIn Ads account. Call linkedin_ads_list_campaign_groups and use an id from there.");
    const group_name = group.name ?? String(group.id);
    if (!group.status) throw new ExpectedToolError("linkedin_ads_status_unread", `LinkedIn did not return the status of the campaign group "${group_name}", so Zavi cannot write a card against it.`);
    if (ENDED_STATUSES.has(group.status)) throw new ExpectedToolError("linkedin_ads_group_ended", `The campaign group "${group_name}" is ${group.status.toLowerCase()}, so no campaign can be created in it.`);
    const siblings = await listLinkedInRawCampaignsInGroupWithToken(token, args.account_id, args.group_id);
    const same = siblings.find((c) => c.name === args.name && c.status !== "ARCHIVED" && c.status !== "PENDING_DELETION");
    if (same && same.status !== "PAUSED" && same.status !== "DRAFT")
      throw new ExpectedToolError("linkedin_ads_name_taken", `The campaign group "${group_name}" already has a ${same.status?.toLowerCase() ?? ""} campaign named "${args.name}" (campaign ${String(same.id)}). Pick another name.`, { campaign_id: String(same.id) });
    const found = await resolvePlaces(token, args.locations, "target");
    const bad = found.filter((f) => !linkedinLocationIncludable(f.name)).map((f) => f.name);
    if (bad.length) throw new ExpectedToolError("linkedin_ads_location_not_includable", `${bad.join(", ")} cannot be targeted as written. Name a country, or a city or state with its country.`, { not_includable: bad });
    const excluded = args.excluded_locations?.length ? await resolvePlaces(token, args.excluded_locations, "exclude") : [];
    if (args.post_urn) await assertPostFromPage(token, args.post_urn, associated_entity, () => readPublicPost(args.post_urn!));
    return {
      account_id: args.account_id,
      group_id: String(group.id),
      group_name,
      expected_group_status: group.status,
      name: args.name,
      daily_budget: { amount: args.daily_budget, currency },
      unit_cost: { amount: args.bid, currency },
      geo_urns: found.map((f) => f.id),
      ...(excluded.length ? { excluded_geo_urns: excluded.map((f) => f.id) } : {}),
      country: countryOfPlace(found[0].name) ?? "US",
      language: args.language,
      associated_entity,
      ...(args.audience ? { audience: args.audience } : {}),
      objective_type: args.objective_type ?? null,
      post_urn: args.post_urn ?? null,
      places: found.map((f) => f.name),
      rationale: args.rationale,
    };
  });
}

export const linkedinAdsProposeNewCampaignTool: ToolSpec = {
  name: "linkedin_ads_propose_new_campaign",
  effect: "write",
  description:
    "Propose a new paused Sponsored Content campaign in an existing campaign group of the founder's own LinkedIn ad account, with a daily budget, a CPC bid, locations by name, an optional audience and optionally a company-page post as its first paused ad. Files a card on the LinkedIn Ads channel's Actions tab for the founder, or cgo on Autopilot with an ad budget, to approve; nothing spends until someone switches the campaign on. EU locations, a post from another page and a name already used by a running campaign in the group are refused. Zavi's shared ad account is not accepted: its launch flow creates there. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInNewCampaignBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_CREATE_CAMPAIGN_CLASS, body);
    return { action_id, status: "waiting_for_owner", campaign: { name: body.name, group: { id: body.group_id, name: body.group_name }, daily_budget: body.daily_budget, bid: body.unit_cost, places: body.places, post_urn: body.post_urn } };
  },
};
