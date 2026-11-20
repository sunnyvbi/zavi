import { z } from "zod";
import { withLinkedInAdsToken } from "@/services/connectors/linkedin-ads/client";
import { linkedinAccountInUse } from "@/services/connectors/linkedin-ads/own-accounts";
import { readLinkedInRawCampaignGroup, readLinkedInRawCreativeWithToken } from "@/services/connectors/linkedin-ads/write";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { LINKEDIN_ARCHIVE_CLASS, type LinkedInArchiveBody } from "../_change-bodies";
import { LINKEDIN_ACCOUNT_NOT_IN_USE } from "../_wallet";
import { readOwnCampaignTarget, requireChannelRun } from "./_own-target";

const numericId = z.string().regex(/^\d{1,20}$/);
const GONE = new Set(["PENDING_DELETION", "REMOVED", "CANCELED"]);

const inputSchema = z
  .object({
    target: z.enum(["campaign_group", "campaign", "creative"]).describe("What to archive: a campaign group, a campaign, or one ad (creative)."),
    id: numericId.describe("The group, campaign or creative id."),
    account_id: numericId.describe("The ad account it belongs to."),
    campaign_id: numericId.optional().describe("For a creative: the campaign it belongs to."),
    mode: z.enum(["archive", "delete"]).default("archive").describe("archive keeps history and can be undone in Campaign Manager; delete is for good and needs an admin."),
    rationale: z.string().min(1).max(500).describe("Why, citing the numbers you read."),
  })
  .strict()
  .refine((v) => v.target !== "creative" || !!v.campaign_id, { message: "A creative needs its campaign_id." });

export type ArchiveArgs = z.infer<typeof inputSchema>;

function refuseGone(label: string, status: string | null, mode: "archive" | "delete"): string {
  if (!status) throw new ExpectedToolError("linkedin_ads_status_unread", `LinkedIn did not say what state ${label} is in, so Zavi will not ${mode} it.`);
  if (GONE.has(status)) throw new ExpectedToolError("linkedin_ads_already_archived", `${label} is already ${status === "CANCELED" ? "canceled" : "deleted"}.`);
  if (status === "ARCHIVED" && mode === "archive") throw new ExpectedToolError("linkedin_ads_already_archived", `${label} is already archived.`);
  return status;
}

export async function readLinkedInArchiveBody(tenant_id: string, args: ArchiveArgs): Promise<LinkedInArchiveBody> {
  const verb = args.mode === "delete" ? "delete" : "archive";
  if (args.target === "campaign") {
    const t = await readOwnCampaignTarget(tenant_id, { campaign_id: args.id, account_id: args.account_id }, `Zavi does not ${verb} it`);
    const label = `The campaign "${t.name}"`;
    const status = refuseGone(label, t.status, args.mode);
    if (status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_campaign_active", `${label} is running. Pause it first with linkedin_ads_propose_pause_campaign; Zavi never ${verb}s a running campaign.`);
    return { target: "campaign", id: t.id, account_id: args.account_id, campaign_id: null, name: t.name, expected_status: status, mode: args.mode, rationale: args.rationale };
  }
  if (args.target === "campaign_group") {
    if (!(await linkedinAccountInUse(tenant_id, args.account_id))) throw LINKEDIN_ACCOUNT_NOT_IN_USE();
    const g = await readLinkedInRawCampaignGroup(tenant_id, args.account_id, args.id);
    if (!g) throw new ExpectedToolError("linkedin_ads_group_not_found", "This campaign group is not in this LinkedIn Ads account. Refresh the group list, then try again.");
    const id = String(g.id);
    const name = g.name ?? id;
    const label = `The campaign group "${name}"`;
    if (g.backfilled) throw new ExpectedToolError("linkedin_ads_default_group", `${label} is the account's default group, which LinkedIn does not let anyone ${verb}.`);
    const status = refuseGone(label, g.status ?? null, args.mode);
    if (status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_group_active", `${label} is running. Pause it first with linkedin_ads_propose_campaign_group_edit; Zavi never ${verb}s a running campaign group.`);
    return { target: "campaign_group", id, account_id: args.account_id, campaign_id: null, name, expected_status: status, mode: args.mode, rationale: args.rationale };
  }
  const campaign_id = args.campaign_id as string;
  const t = await readOwnCampaignTarget(tenant_id, { campaign_id, account_id: args.account_id }, `Zavi does not ${verb} its ads`);
  const c = await withLinkedInAdsToken(tenant_id, (token) => readLinkedInRawCreativeWithToken(token, args.account_id, args.id));
  if (!c || c.campaign !== `urn:li:sponsoredCampaign:${t.id}`) throw new ExpectedToolError("linkedin_ads_ad_not_found", `This ad is not in the campaign "${t.name}". Check linkedin_ads_list_ads, then try again.`);
  const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : `Ad ${args.id}`;
  const status = refuseGone(`The ad "${name}"`, c.intendedStatus ?? null, args.mode);
  if (status === "ACTIVE") throw new ExpectedToolError("linkedin_ads_ad_active", `The ad "${name}" is on. Turn it off first with linkedin_ads_propose_ad_status; Zavi never ${verb}s an ad that is on.`);
  return { target: "creative", id: args.id, account_id: args.account_id, campaign_id: t.id, name, expected_status: status, mode: args.mode, rationale: args.rationale };
}

export const linkedinAdsProposeArchiveTool: ToolSpec = {
  name: "linkedin_ads_propose_archive",
  effect: "write",
  description:
    "Propose archiving (or, for an admin, deleting) one LinkedIn Ads campaign group, campaign, or ad in the founder's own ad account. Files a card on the LinkedIn Ads channel's Actions tab that only a workspace owner or admin can approve; nothing is applied on its own, and if the object changes state in LinkedIn before approval the card does nothing. A running campaign or group, or an ad that is on, is refused: pause or turn it off first. The account's default group and anything already archived or deleted are refused. A campaign in Zavi's shared account is refused. Only works on a linkedin_ads channel run.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const args = inputSchema.parse(input);
    requireChannelRun(ctx);
    const body = await readLinkedInArchiveBody(ctx.tenant_id, args);
    const action_id = await (ctx.emit_decision as (c: string, b: unknown) => Promise<string>)(LINKEDIN_ARCHIVE_CLASS, body);
    return { action_id, status: "waiting_for_owner", target: { kind: body.target, id: body.id, name: body.name, was: body.expected_status }, mode: body.mode };
  },
};
