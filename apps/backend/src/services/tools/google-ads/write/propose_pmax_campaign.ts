
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { asTenantId, type TenantId } from "@/services/tenant-client";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { buildGoogleAdsDecisionEvidence, cardEvidenceInputShape } from "./_card-evidence";
import { GOOGLE_ADS_DECISION_CLASSES } from "./_class-router";
import { assertUsdGoogleAccount } from "./_currency-guard";
import { createCampaignBodySchema } from "./_decision-bodies";
import { fitAdImage, readAdImageSource, storeAdImage, type AdImageRef, type AdImageSlot, type AdImageSource, type FittedAdImage } from "./_ad-images";
import { storeLogo, type LogoRef } from "./_logo";
import { assertGoogleAdsProposeAllowed } from "./_propose-guard";
import { readTenantGoogleCapAndToday } from "./cap-reader";
import { googleValidateCreateCampaign } from "./create_campaign";
import { VIDEO_CAMPAIGN_APPROVAL } from "./propose_video_campaign";

const text = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith("https://"), "must be an https URL");

const imageSource = z
  .union([
    z.object({ artifact_id: z.string().uuid().describe("The artifact_id a render tool returned for an image Zavi made.") }),
    z.object({ filename: z.string().trim().min(1).max(200).describe("The file name of an image Zavi made, e.g. social-1-scrim.png; the newest one with that name is used.") }),
    z.object({ image_path: z.string().min(1).max(200).describe("The image_path of a chat upload or a render's stageable copy.") }),
    z.object({ url: httpsUrl.describe("An https image URL, PNG or JPEG, under 5 MB, no redirects.") }),
  ])
  .describe("One image: exactly one of artifact_id, filename, image_path or url.");

const inputSchema = z.object({
  ...cardEvidenceInputShape,
  name: z.string().trim().min(1).max(255).describe("Campaign name, unique in the account."),
  daily_budget_usd: z.number().positive().describe("Daily budget in USD. Created PAUSED; nothing spends until it is turned on."),
  bidding: z
    .discriminatedUnion("strategy", [
      z.strictObject({ strategy: z.literal("MAXIMIZE_CONVERSIONS"), target_cpa_usd: z.number().positive().optional() }),
      z.strictObject({ strategy: z.literal("MAXIMIZE_CONVERSION_VALUE"), target_roas: z.number().positive().optional() }),
    ])
    .default({ strategy: "MAXIMIZE_CONVERSIONS" })
    .describe("Performance Max bids for conversions or conversion value only."),
  final_url: httpsUrl.describe("The landing page, https. Check it loads before proposing."),
  headlines: z.array(text(30)).min(3).max(15).describe("3-15 headlines, each 30 characters or fewer."),
  long_headlines: z.array(text(90)).min(1).max(5).describe("1-5 long headlines, each 90 characters or fewer."),
  descriptions: z.array(text(90)).min(2).max(5).describe("2-5 descriptions, each 90 characters or fewer."),
  business_name: text(25).describe("The advertiser or brand name, 25 characters or fewer."),
  landscape_images: z
    .array(imageSource)
    .min(1)
    .max(5)
    .describe("1-5 landscape images for the 1.91:1 slot. A 16:9 render fits (Zavi trims up to 10%); a square or portrait poster does not."),
  square_images: z.array(imageSource).min(1).max(5).describe("1-5 square (1:1) images, at least 300x300."),
  portrait_images: z.array(imageSource).max(5).default([]).describe("Optional 4:5 portrait images, at least 480x600."),
  logo: imageSource.describe("A square logo, at least 128x128."),
  location_ids: z.array(z.number().int().positive()).max(50).default([]).describe("Geo target constant ids, e.g. 2840 for the United States."),
  excluded_location_ids: z.array(z.number().int().positive()).max(50).default([]).describe("Geo target constant ids the campaign must never show in."),
  language_ids: z.array(z.number().int().positive()).max(20).default([]).describe("Language constant ids, e.g. 1000 for English."),
  asset_group_name: z.string().trim().min(1).max(255).optional().describe("Defaults to '<campaign name> – assets'."),
  rationale: rationaleInput(),
  about: z.string().optional().describe("ONE plain sentence on what this campaign is for. Shown on the approval card."),
});

export type PmaxImageNote = { slot: AdImageSlot; artifact_id?: string; width: number; height: number; trimmed_pct: number };

async function prepareImage(tid: TenantId, src: AdImageSource, slot: AdImageSlot, notes: PmaxImageNote[]): Promise<FittedAdImage> {
  const source = await readAdImageSource(tid, src);
  const fitted = await fitAdImage(source.bytes, slot);
  notes.push({
    slot,
    ...(source.artifact_id ? { artifact_id: source.artifact_id } : {}),
    width: fitted.width,
    height: fitted.height,
    trimmed_pct: fitted.trimmed_pct,
  });
  return fitted;
}

export const googleProposePmaxCampaignTool: ToolSpec = {
  name: "google_ads_propose_pmax_campaign",
  effect: "write",
  description:
    "Propose a new Performance Max campaign with its asset group, ready to serve: budget, copy, images (a poster Zavi made, by artifact_id, a chat upload or an https URL) and a square logo. Each image is fitted to Google's shape: landscape 1.91:1 (render it 16:9), square 1:1, optional portrait 4:5; Zavi trims at most 10% and refuses more, so make a version in that shape. Google dry-runs it first; the campaign is created PAUSED with its asset group ready, so one enable of the campaign makes it eligible to serve. You approve it, or Autopilot can when it runs your ads under a budget.",
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
    const notes: PmaxImageNote[] = [];
    const images = async (sources: readonly AdImageSource[], slot: AdImageSlot): Promise<AdImageRef[]> => {
      const refs: AdImageRef[] = [];
      for (const src of sources) {
        refs.push(await storeAdImage(tid, await prepareImage(tid, src, slot, notes)));
      }
      return refs;
    };
    const landscape_images = await images(args.landscape_images, "landscape");
    const square_images = await images(args.square_images, "square");
    const portrait_images = await images(args.portrait_images, "portrait");
    const logo: LogoRef = await storeLogo(tid, (await prepareImage(tid, args.logo, "logo", notes)).bytes);

    const { countryIfNoLocation } = await import("./_launch-defaults");
    const location_ids = await countryIfNoLocation(ctx.tenant_id, args.location_ids);

    const parsed = createCampaignBodySchema.safeParse({
      name: args.name,
      channel_type: "PERFORMANCE_MAX",
      daily_budget_usd: args.daily_budget_usd,
      bidding: args.bidding,
      location_ids,
      excluded_location_ids: args.excluded_location_ids,
      language_ids: args.language_ids,
      pmax_asset_group: {
        name: args.asset_group_name ?? `${args.name} – assets`.slice(0, 255),
        final_urls: [args.final_url],
        headlines: [...new Set(args.headlines)],
        long_headlines: [...new Set(args.long_headlines)],
        descriptions: [...new Set(args.descriptions)],
        business_name: args.business_name,
        landscape_images,
        square_images,
        portrait_images,
        logo,
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
      campaign_type: "PERFORMANCE_MAX",
      approval: VIDEO_CAMPAIGN_APPROVAL,
      images: notes,
      notice: `Google's dry run accepted it. The card waits for ${VIDEO_CAMPAIGN_APPROVAL}; the campaign is created PAUSED with its asset group, and one approved enable of the campaign makes it eligible to serve.`,
    };
  },
};
