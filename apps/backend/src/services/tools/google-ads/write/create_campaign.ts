import { asTenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { gadsCustomerId, gadsListCampaignNames, gadsMutateOperations, googleAdsErrorPairs } from "../_client";
import type { CreateCampaignBody } from "./_decision-bodies";
import { assertNoGoogleNameCollision, resourceId } from "./_helpers";
import { loadAdImageBytes } from "./_ad-images";
import { loadLogoBytes } from "./_logo";
import { shapeCreateCampaignOperations, type CreateCampaignShape, type PmaxImageData } from "./_request-shapers";

export type CreatedCampaign = {
  campaign_id: string;
  campaign_resource: string;
  budget_resource: string;
  ad_group_id: string | null;
  ad_group_resource: string | null;
  asset_group_id?: string | null;
  created_resources: number;
};

export type CreateCampaignDeps = { loadLogo?: typeof loadLogoBytes; loadImage?: typeof loadAdImageBytes };

async function prepare(
  tenant_id: string,
  body: CreateCampaignBody,
  deps: CreateCampaignDeps,
): Promise<CreateCampaignShape> {
  const existing = await gadsListCampaignNames(tenant_id);
  assertNoGoogleNameCollision(existing, body.name, "campaign");
  const customer_id = await gadsCustomerId(tenant_id);
  const tid = asTenantId(tenant_id);
  const loadLogo = deps.loadLogo ?? loadLogoBytes;
  const logo = body.demand_gen_ad_group?.ad.logo;
  const logoData = logo ? (await loadLogo(tid, logo)).base64 : undefined;
  let pmaxData: PmaxImageData | undefined;
  const pmax = body.pmax_asset_group;
  if (pmax) {
    const images: Record<string, string> = {};
    for (const ref of [...pmax.landscape_images, ...pmax.square_images, ...pmax.portrait_images]) {
      images[ref.sha256] ??= (await (deps.loadImage ?? loadAdImageBytes)(tid, ref)).base64;
    }
    pmaxData = { logo: (await loadLogo(tid, pmax.logo)).base64, images };
  }
  return shapeCreateCampaignOperations(body, customer_id, { logoData, pmaxData });
}

export async function googleValidateCreateCampaign(
  tenant_id: string,
  body: CreateCampaignBody,
  deps: CreateCampaignDeps = {},
): Promise<void> {
  const shaped = await prepare(tenant_id, body, deps);
  try {
    await gadsMutateOperations(tenant_id, shaped.ops, { validateOnly: true });
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "google_ads_mutate_failed") {
      const m = /failed: \d{3} ([\s\S]*)$/.exec(e.message);
      const reasons = googleAdsErrorPairs(m ? m[1] : e.message);
      const demandGen = body.channel_type === "DEMAND_GEN";
      const kind = demandGen ? "Demand Gen " : body.pmax_asset_group ? "Performance Max " : "";
      throw new ExpectedToolError(
        demandGen ? "google_ads_demand_gen_rejected" : "google_ads_create_rejected",
        `Google refused this ${kind}campaign in a dry run, so no card was filed: ${
          reasons.join(" | ") || "no reason given"
        }`,
      );
    }
    throw e;
  }
}

export async function googleCreateCampaign(
  tenant_id: string,
  body: CreateCampaignBody,
  deps: CreateCampaignDeps = {},
): Promise<CreatedCampaign> {
  const shaped = await prepare(tenant_id, body, deps);
  const results = await gadsMutateOperations(tenant_id, shaped.ops);
  const campaign_resource = results[1] || shaped.campaign_resource;
  const budget_resource = results[0] || shaped.budget_resource;
  const adGroupIndex = shaped.ad_group_resource
    ? shaped.ops.findIndex((op) => op.service === "adGroups")
    : -1;
  const ad_group_resource = adGroupIndex >= 0 ? results[adGroupIndex] || null : null;
  const assetGroupIndex = shaped.asset_group_resource ? shaped.ops.findIndex((op) => op.service === "assetGroups") : -1;
  const asset_group_resource = assetGroupIndex >= 0 ? results[assetGroupIndex] || null : null;
  return {
    campaign_id: resourceId(campaign_resource),
    campaign_resource,
    budget_resource,
    ad_group_id: ad_group_resource ? resourceId(ad_group_resource) : null,
    ad_group_resource,
    asset_group_id: asset_group_resource ? resourceId(asset_group_resource) : null,
    created_resources: results.length,
  };
}
