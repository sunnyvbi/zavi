
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { asTenantId } from "@/services/tenant-client";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { createCampaignBodySchema } from "./_decision-bodies";
import { pinnedFetch, storeLogo } from "./_logo";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { isYoutubeVideoId } from "./_video-formats";
import { readTenantGoogleCapAndToday } from "./cap-reader";
import { googleValidateCreateCampaign } from "./create_campaign";

const youtubeVideoId = z.string().refine(isYoutubeVideoId, "must be an 11-character YouTube video id");
const text = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith("https://"), "must be an https URL");

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  name: z.string().trim().min(1).max(255).describe("Campaign name, unique in the account."),
  daily_budget_usd: z.number().positive().describe("Daily budget in USD. Created PAUSED; nothing spends until it is turned on."),
  youtube_video_ids: z.array(youtubeVideoId).min(1).max(5).describe("1-5 real YouTube video ids (11 characters) that are public or unlisted on the advertiser's channel."),
  final_url: httpsUrl.describe("The landing page, https. Check it loads before proposing."),
  headlines: z.array(text(40)).min(1).max(5).describe("1-5 headlines, each 40 characters or fewer."),
  long_headlines: z.array(text(90)).min(1).max(5).describe("1-5 long headlines, each 90 characters or fewer."),
  descriptions: z.array(text(90)).min(1).max(5).describe("1-5 descriptions, each 90 characters or fewer."),
  business_name: text(25).describe("The advertiser or brand name, 25 characters or fewer."),
  logo_image_url: httpsUrl.describe("https URL of a square PNG or JPEG logo, at least 128x128, under 5 MB. Fetched once and stored; no redirects."),
  target_cpa_usd: z.number().positive().optional().describe("Optional target cost per conversion for maximize conversions."),
  location_ids: z.array(z.number().int().positive()).max(50).default([]).describe("Geo target constant ids, e.g. 2840 for the United States."),
  language_ids: z.array(z.number().int().positive()).max(20).default([]).describe("Language constant ids, e.g. 1000 for English."),
  ad_group_name: z.string().trim().min(1).max(255).optional().describe("Defaults to '<campaign name> – video'."),
  rationale: rationaleInput(),
  about: z.string().optional().describe("ONE plain sentence on what this campaign is for. Shown on the approval card."),
});

export const VIDEO_CREATE_UNSUPPORTED =
  "Google's Ads API cannot create or change YouTube VIDEO campaigns, so Zavi cannot file this. For new YouTube video spend use google_ads_propose_video_campaign (Demand Gen); otherwise make it a manual setup card.";

export const VIDEO_CAMPAIGN_APPROVAL = "you, or Autopilot when it runs your ads under a budget";

export const googleProposeVideoCampaignTool: ToolSpec = {
  name: "google_ads_propose_video_campaign",
  effect: "write",
  description:
    "Propose a new YouTube video campaign as Demand Gen, on YouTube, Discover and Gmail (not Display): budget, YouTube videos, copy and a square logo, on maximize conversions. Google dry-runs it first; the campaign is created PAUSED with its ad group and ad ready, so one enable of the campaign makes it eligible to serve. You approve it, or Autopilot can when it runs your ads under a budget. Google's API cannot create VIDEO campaigns.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const emit = await assertGoogleAdsProposeAllowed(ctx);
    const args = inputSchema.parse(input);

    const { cap } = await readTenantGoogleCapAndToday(ctx.tenant_id);
    if (cap?.enabled && cap.max_daily_budget_usd != null && args.daily_budget_usd > cap.max_daily_budget_usd) {
      throw new ExpectedToolError(
        "google_ads_proposal_over_absolute_cap",
        `Proposed daily budget $${args.daily_budget_usd} exceeds the tenant ceiling $${cap.max_daily_budget_usd}. Lower the proposal or ask the operator to raise the cap.`,
      );
    }

    await assertUsdGoogleAccount(ctx, "campaign budgets");

    const tid = asTenantId(ctx.tenant_id);
    const fetched = await pinnedFetch(args.logo_image_url);
    const logo = await storeLogo(tid, fetched.bytes);

    const { countryIfNoLocation } = await import("./_launch-defaults");
    const location_ids = await countryIfNoLocation(ctx.tenant_id, args.location_ids);

    const parsed = createCampaignBodySchema.safeParse({
      name: args.name,
      channel_type: "DEMAND_GEN",
      daily_budget_usd: args.daily_budget_usd,
      bidding: {
        strategy: "MAXIMIZE_CONVERSIONS",
        ...(args.target_cpa_usd !== undefined ? { target_cpa_usd: args.target_cpa_usd } : {}),
      },
      location_ids,
      language_ids: args.language_ids,
      demand_gen_ad_group: {
        name: args.ad_group_name ?? `${args.name} – video`.slice(0, 255),
        ad: {
          final_urls: [args.final_url],
          youtube_video_ids: [...new Set(args.youtube_video_ids)],
          headlines: args.headlines,
          long_headlines: args.long_headlines,
          descriptions: args.descriptions,
          business_name: args.business_name,
          logo,
        },
      },
      rationale: args.rationale,
      ...(args.about ? { about: args.about } : {}),
    });
    if (!parsed.success) {
      throw new ExpectedToolError(
        "google_ads_invalid_create_body",
        `This campaign cannot be created as specified: ${parsed.error.issues.map((i) => i.message).join(" | ")}`,
      );
    }

    await googleValidateCreateCampaign(ctx.tenant_id, parsed.data);

    const decision_class = GOOGLE_ADS_DECISION_CLASSES.create_campaign;
    const decision_id = await emit(decision_class, {
      ...parsed.data,
      decision_evidence: buildGoogleAdsDecisionEvidence("create", args.rationale, args),
    });
    return {
      decision_id,
      decision_class,
      campaign_type: "DEMAND_GEN",
      approval: VIDEO_CAMPAIGN_APPROVAL,
      notice: `Google's dry run accepted it. The card waits for ${VIDEO_CAMPAIGN_APPROVAL}; the campaign is created PAUSED and one approved enable of the campaign makes it eligible to serve.`,
    };
  },
};
