import { z } from "zod";
import { listLinkedInCampaignGroupsWithToken, withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { listLinkedInRawCampaignsInGroupWithToken, listLinkedInRawCreativesWithToken, readLinkedInRawCampaignGroupWithToken } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_DUPLICATE_CLASS, type LinkedInDuplicateBody } from "../_change-bodies";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "../_wallet";
import { countsAsAd } from "./_ad-source";
import { readOwnCampaignTarget, requireChannelRun, emitLinkedInCard } from "./_own-target";

export const LINKEDIN_COPY_MAX_CAMPAIGNS = 20;
const GONE = new Set(["ARCHIVED", "PENDING_DELETION"]);

const inputSchema = z
  .object({
    target: z.enum(["campaign_group", "campaign", "creative"]).describe("What to copy."),
    source_id: z.string().regex(/^\d{1,20}$/).describe("The id of the group, campaign or ad to copy."),
    account_id: z.string().regex(/^\d{1,20}$/).describe("The ad account it lives in."),
    new_name: z.string().trim().min(1).max(255).describe("The copy's name; must be unused at the destination."),
    copy_ads: z.boolean().default(true).describe("For a campaign or group: also copy its ads, paused."),
    group_id: z.string().regex(/^\d{1,20}$/).optional().describe("For a campaign: the group to put the copy in. Default: the source's own group."),
    campaign_id: z.string().regex(/^\d{1,20}$/).optional().describe("For an ad: the campaign it is in (the copy lands there too). Required for target creative."),
    rationale: z.string().min(1).max(500).describe("Why copy it, citing the numbers you read on the source."),
  })
  .strict();

type Args = z.infer<typeof inputSchema>;

const stamp = (ms: number | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const nameTaken = (what: string, where: string, name: string, id: string) =>
  new ExpectedToolError("linkedin_ads_name_taken", `${where} already has a ${what} named "${name}" (${id}). Pick another name.`, { id });

export async function readLinkedInDuplicateBody(tenant_id: string, args: Args): Promise<LinkedInDuplicateBody> {
  const base = { target: args.target, source_id: args.source_id, account_id: args.account_id, new_name: args.new_name, copy_ads: args.copy_ads, rationale: args.rationale };
  if (args.target === "campaign") {
    const t = await readOwnCampaignTarget(tenant_id, { campaign_id: args.source_id, account_id: args.account_id }, "its launch flow in Zavi is the only way to run another like it");
    const ownGroup = /^urn:li:sponsoredCampaignGroup:(\d{1,20})$/.exec(String((t.live as { campaignGroup?: unknown }).campaignGroup ?? ""))?.[1] ?? null;
    const group_id = args.group_id ?? ownGroup;
    if (!group_id) throw new ExpectedToolError("linkedin_ads_group_not_found", `LinkedIn did not say which campaign group "${t.name}" is in. Pass group_id.`);
    return withLinkedInAdsToken(tenant_id, async (token) => {
      const group = await readLinkedInRawCampaignGroupWithToken(token, args.account_id, group_id);
      if (!group) throw new ExpectedToolError("linkedin_ads_group_not_found", "The destination campaign group is not in this LinkedIn Ads account. Call linkedin_ads_list_campaign_groups and use an id from there.");
      if (group.status && GONE.has(group.status)) throw new ExpectedToolError("linkedin_ads_group_ended", `The campaign group "${group.name ?? group_id}" is ${group.status.toLowerCase()}, so nothing can be copied into it.`);
      const siblings = await listLinkedInRawCampaignsInGroupWithToken(token, args.account_id, group_id);
      const taken = siblings.find((c) => c.name === args.new_name && !GONE.has(c.status ?? ""));
      if (taken) throw nameTaken("campaign", `The campaign group "${group.name ?? group_id}"`, args.new_name, `campaign ${String(taken.id)}`);
      return { ...base, source_name: t.name, group_id, campaign_id: null, source_last_modified_at: stamp(t.live.changeAuditStamps?.lastModified?.time) };
    });
  }
  if (!(await linkedinAccountInUse(tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
  return withLinkedInAdsToken(tenant_id, async (token) => {
    if (args.target === "creative") {
      if (!args.campaign_id) throw new ExpectedToolError("linkedin_ads_campaign_required", "Copying an ad needs campaign_id, the campaign it is in.");
      const ads = await listLinkedInRawCreativesWithToken(token, args.account_id, args.campaign_id);
      const src = ads.find((a) => a.creative_id === args.source_id);
      if (!src) throw new ExpectedToolError("linkedin_ads_ad_not_found", `Campaign ${args.campaign_id} has no ad ${args.source_id}. Call linkedin_ads_list_ads and use an id from there.`);
      const source_name = src.name ?? `Ad ${src.creative_id}`;
      if (!src.content?.reference) throw new ExpectedToolError("linkedin_ads_copy_unsupported", `The ad "${source_name}" has no post Zavi can reuse (it is a direct ad), so it cannot be copied through Zavi. Copy it in Campaign Manager.`);
      const taken = ads.find((a) => a.name === args.new_name && countsAsAd(a));
      if (taken) throw nameTaken("ad", `Campaign ${args.campaign_id}`, args.new_name, `ad ${taken.creative_id}`);
      return { ...base, source_name, group_id: null, campaign_id: args.campaign_id, source_last_modified_at: stamp(src.changeAuditStamps?.lastModified?.time) };
    }
    const src = await readLinkedInRawCampaignGroupWithToken(token, args.account_id, args.source_id);
    if (!src) throw new ExpectedToolError("linkedin_ads_group_not_found", "This campaign group is not in this LinkedIn Ads account. Call linkedin_ads_list_campaign_groups and use an id from there.");
    const source_name = src.name ?? String(src.id);
    const campaigns = await listLinkedInRawCampaignsInGroupWithToken(token, args.account_id, args.source_id);
    if (campaigns.length > LINKEDIN_COPY_MAX_CAMPAIGNS)
      throw new ExpectedToolError("linkedin_ads_copy_too_big", `The campaign group "${source_name}" holds ${campaigns.length} campaigns; Zavi copies groups of up to ${LINKEDIN_COPY_MAX_CAMPAIGNS}. Copy it in Campaign Manager.`, { campaigns: campaigns.length });
    const groups = await listLinkedInCampaignGroupsWithToken(token, args.account_id, 1000, ["ACTIVE", "PAUSED", "DRAFT"]);
    const taken = groups.find((g) => g.name === args.new_name);
    if (taken) throw nameTaken("campaign group", "This ad account", args.new_name, `group ${taken.id}`);
    return { ...base, source_name, group_id: null, campaign_id: null, source_last_modified_at: stamp(src.changeAuditStamps?.lastModified?.time) };
  });
}

export const linkedinAdsProposeDuplicateTool: ToolSpec = {
  name: "linkedin_ads_propose_duplicate",
  effect: "write",
  description:
    "Propose copying a LinkedIn Ads campaign group, campaign or ad in the founder's own ad account under a new name. The copy is created paused with the source's settings (and, for a campaign or group, paused copies of its post ads), so nothing spends until someone switches it on. Files a card on the LinkedIn Ads channel's Actions tab for the founder, or cgo on Autopilot with an ad budget, to approve; if the source is edited in LinkedIn before approval the card does nothing. A direct ad without a post, a group of more than 20 campaigns, a name already used at the destination and a campaign in Zavi's shared account are refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInDuplicateBody(ctx.tenant_id, args);
    const action_id = await emitLinkedInCard(ctx, LINKEDIN_DUPLICATE_CLASS, body);
    return { action_id, status: "waiting_for_owner", source: { target: body.target, id: body.source_id, name: body.source_name }, copy: { name: body.new_name, group_id: body.group_id, campaign_id: body.campaign_id, copy_ads: body.copy_ads } };
  },
};
