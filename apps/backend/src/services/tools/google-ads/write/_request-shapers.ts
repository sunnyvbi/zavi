import type { GadsOperation, GadsMutateService } from "../_client";
import { gadsTempResourceName } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { usdToMicros } from "./_helpers";
import type {
  AdSpec,
  AdGroupSpec,
  BiddingSpec,
  CreateCampaignBody,
  DemandGenAdGroupSpec,
  KeywordSpec,
  NetworkSettings,
  PmaxAssetGroupSpec,
  UpdateAdGroupBody,
  UpdateCampaignBody,
} from "./_decision-bodies";
import { networkSettingsSchema } from "./_decision-bodies";

class TempIds {
  private next = 1;
  constructor(private readonly customer_id: string) {}
  take(service: GadsMutateService): string {
    return gadsTempResourceName(this.customer_id, service, this.next++);
  }
}

export function shapeBidding(bidding: BiddingSpec): Record<string, unknown> {
  switch (bidding.strategy) {
    case "MANUAL_CPC":
      return { manualCpc: { enhancedCpcEnabled: bidding.enhanced_cpc } };
    case "MANUAL_CPV":
      return { manualCpv: {} };
    case "MANUAL_CPM":
      return { manualCpm: {} };
    case "TARGET_CPM":
      return { targetCpm: {} };
    case "TARGET_SPEND":
      return {
        targetSpend:
          bidding.cpc_bid_ceiling_usd !== undefined
            ? { cpcBidCeilingMicros: usdToMicros(bidding.cpc_bid_ceiling_usd) }
            : {},
      };
    case "MAXIMIZE_CONVERSIONS":
      return {
        maximizeConversions:
          bidding.target_cpa_usd !== undefined
            ? { targetCpaMicros: usdToMicros(bidding.target_cpa_usd) }
            : {},
      };
    case "MAXIMIZE_CONVERSION_VALUE":
      return {
        maximizeConversionValue:
          bidding.target_roas !== undefined ? { targetRoas: bidding.target_roas } : {},
      };
  }
}

export function shapeNetworkSettings(network: NetworkSettings): Record<string, boolean> {
  return {
    targetGoogleSearch: network.google_search,
    targetSearchNetwork: network.search_network,
    targetContentNetwork: network.content_network,
    targetPartnerSearchNetwork: network.partner_search_network,
  };
}

function textAssets(items: readonly string[]): Array<{ text: string }> {
  return items.map((text) => ({ text }));
}

function keywordInfo(k: KeywordSpec): { text: string; matchType: string } {
  return { text: k.text, matchType: k.match_type };
}

export function shapeAd(ad: AdSpec): Record<string, unknown> {
  return {
    finalUrls: ad.final_urls,
    responsiveSearchAd: {
      headlines: textAssets(ad.headlines),
      descriptions: textAssets(ad.descriptions),
      ...(ad.path1 ? { path1: ad.path1 } : {}),
      ...(ad.path2 ? { path2: ad.path2 } : {}),
    },
  };
}

function adGroupBids(spec: {
  cpc_bid_usd?: number;
  cpv_bid_usd?: number;
  cpm_bid_usd?: number;
}): Record<string, string> {
  return {
    ...(spec.cpc_bid_usd !== undefined ? { cpcBidMicros: usdToMicros(spec.cpc_bid_usd) } : {}),
    ...(spec.cpv_bid_usd !== undefined ? { cpvBidMicros: usdToMicros(spec.cpv_bid_usd) } : {}),
    ...(spec.cpm_bid_usd !== undefined ? { cpmBidMicros: usdToMicros(spec.cpm_bid_usd) } : {}),
  };
}

export type ChildStatus = "PAUSED" | "ENABLED";

export function shapeAdOperations(
  ads: readonly AdSpec[],
  ad_group_resource: string,
  status: ChildStatus = "PAUSED",
): GadsOperation[] {
  return ads.map((ad) => ({
    service: "adGroupAds",
    create: { adGroup: ad_group_resource, status, ad: shapeAd(ad) },
  }));
}

export function shapeKeywordOperations(
  keywords: readonly KeywordSpec[],
  parent: { ad_group_resource: string; negative: boolean } | { campaign_resource: string },
): GadsOperation[] {
  if ("campaign_resource" in parent) {
    return keywords.map((k) => ({
      service: "campaignCriteria",
      create: { campaign: parent.campaign_resource, negative: true, keyword: keywordInfo(k) },
    }));
  }
  return keywords.map((k) => ({
    service: "adGroupCriteria",
    create: {
      adGroup: parent.ad_group_resource,
      status: "ENABLED",
      ...(parent.negative ? { negative: true } : {}),
      keyword: keywordInfo(k),
    },
  }));
}

export function shapeAdGroupOperations(
  spec: AdGroupSpec,
  campaign_resource: string,
  ids: TempIds,
  status: ChildStatus = "PAUSED",
): { ops: GadsOperation[]; ad_group_resource: string } {
  const ad_group_resource = ids.take("adGroups");
  const ops: GadsOperation[] = [
    {
      service: "adGroups",
      create: {
        resourceName: ad_group_resource,
        name: spec.name,
        campaign: campaign_resource,
        status,
        type: spec.type,
        ...adGroupBids(spec),
      },
    },
    ...shapeKeywordOperations(spec.keywords, { ad_group_resource, negative: false }),
    ...shapeAdOperations(spec.ads, ad_group_resource, status),
  ];
  return { ops, ad_group_resource };
}

function imageAssetName(owner: string, role: string): string {
  const suffix = ` – ${role}`;
  return `${owner.slice(0, 128 - suffix.length)}${suffix}`;
}

export type PmaxImageData = { logo: string; images: Readonly<Record<string, string>> };

export function shapePmaxAssetGroupOperations(
  spec: PmaxAssetGroupSpec,
  campaign_resource: string,
  data: PmaxImageData,
  ids: TempIds,
): { ops: GadsOperation[]; asset_group_resource: string } {
  const assets: GadsOperation[] = [];
  const links: Array<{ asset: string; fieldType: string }> = [];
  const textAsset = new Map<string, string>();
  const text = (t: string): string => {
    let r = textAsset.get(t);
    if (!r) {
      r = ids.take("assets");
      textAsset.set(t, r);
      assets.push({ service: "assets", create: { resourceName: r, textAsset: { text: t } } });
    }
    return r;
  };
  const imageAsset = new Map<string, string>();
  const image = (sha256: string): string => {
    let r = imageAsset.get(sha256);
    if (!r) {
      const bytes = data.images[sha256];
      if (!bytes) throw new ExpectedToolError("google_ads_ad_image_missing", "An image's bytes were not loaded, so the request was not built.");
      r = ids.take("assets");
      imageAsset.set(sha256, r);
      assets.push({ service: "assets", create: { resourceName: r, name: imageAssetName(spec.name, `image ${sha256.slice(0, 12)}`), type: "IMAGE", imageAsset: { data: bytes } } });
    }
    return r;
  };
  const link = (fieldType: string, items: readonly string[], make: (x: string) => string) => {
    for (const x of new Set(items)) links.push({ asset: make(x), fieldType });
  };
  link("HEADLINE", spec.headlines, text);
  link("LONG_HEADLINE", spec.long_headlines, text);
  link("DESCRIPTION", spec.descriptions, text);
  link("MARKETING_IMAGE", spec.landscape_images.map((i) => i.sha256), image);
  link("SQUARE_MARKETING_IMAGE", spec.square_images.map((i) => i.sha256), image);
  link("PORTRAIT_MARKETING_IMAGE", spec.portrait_images.map((i) => i.sha256), image);

  const businessName = ids.take("assets");
  assets.push({ service: "assets", create: { resourceName: businessName, textAsset: { text: spec.business_name } } });
  const logo = ids.take("assets");
  assets.push({ service: "assets", create: { resourceName: logo, name: imageAssetName(spec.name, "logo"), type: "IMAGE", imageAsset: { data: data.logo } } });

  const asset_group_resource = ids.take("assetGroups");
  const ops: GadsOperation[] = [
    ...assets,
    { service: "campaignAssets", create: { campaign: campaign_resource, asset: businessName, fieldType: "BUSINESS_NAME" } },
    { service: "campaignAssets", create: { campaign: campaign_resource, asset: logo, fieldType: "LOGO" } },
    {
      service: "assetGroups",
      create: { resourceName: asset_group_resource, campaign: campaign_resource, name: spec.name, finalUrls: spec.final_urls, status: "ENABLED" },
    },
    ...links.map<GadsOperation>((l) => ({
      service: "assetGroupAssets",
      create: { assetGroup: asset_group_resource, asset: l.asset, fieldType: l.fieldType },
    })),
  ];
  return { ops, asset_group_resource };
}

export type CreateCampaignShape = {
  ops: GadsOperation[];
  budget_resource: string;
  campaign_resource: string;
  ad_group_resource: string | null;
  asset_group_resource?: string | null;
};

export const DEMAND_GEN_SELECTED_CHANNELS = {
  youtubeInStream: true,
  youtubeInFeed: true,
  youtubeShorts: true,
  discover: true,
  gmail: true,
  display: false,
  maps: false,
} as const;

export function shapeDemandGenAdGroupOperations(
  spec: DemandGenAdGroupSpec,
  campaign_resource: string,
  targeting: { location_ids: readonly number[]; language_ids: readonly number[] },
  logoData: string,
  ids: TempIds,
): { ops: GadsOperation[]; ad_group_resource: string } {
  const ad_group_resource = ids.take("adGroups");
  const ops: GadsOperation[] = [
    {
      service: "adGroups",
      create: {
        resourceName: ad_group_resource,
        name: spec.name,
        campaign: campaign_resource,
        status: "ENABLED",
        demandGenAdGroupSettings: { channelControls: { selectedChannels: { ...DEMAND_GEN_SELECTED_CHANNELS } } },
      },
    },
    ...targeting.location_ids.map<GadsOperation>((id) => ({
      service: "adGroupCriteria",
      create: { adGroup: ad_group_resource, location: { geoTargetConstant: `geoTargetConstants/${id}` } },
    })),
    ...targeting.language_ids.map<GadsOperation>((id) => ({
      service: "adGroupCriteria",
      create: { adGroup: ad_group_resource, language: { languageConstant: `languageConstants/${id}` } },
    })),
  ];
  const ad = spec.ad;
  const videoAssets: string[] = [];
  for (const videoId of [...new Set(ad.youtube_video_ids)]) {
    const resourceName = ids.take("assets");
    videoAssets.push(resourceName);
    ops.push({
      service: "assets",
      create: { resourceName, name: `YouTube ${videoId}`, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: videoId } },
    });
  }
  const logoAsset = ids.take("assets");
  ops.push({ service: "assets", create: { resourceName: logoAsset, name: imageAssetName(spec.name, "logo"), type: "IMAGE", imageAsset: { data: logoData } } });
  ops.push({
    service: "adGroupAds",
    create: {
      adGroup: ad_group_resource,
      status: "ENABLED",
      ad: {
        finalUrls: ad.final_urls,
        demandGenVideoResponsiveAd: {
          headlines: textAssets(ad.headlines),
          longHeadlines: textAssets(ad.long_headlines),
          descriptions: textAssets(ad.descriptions),
          videos: videoAssets.map((asset) => ({ asset })),
          logoImages: [{ asset: logoAsset }],
          businessName: { text: ad.business_name },
        },
      },
    },
  });
  return { ops, ad_group_resource };
}

export function shapeCreateCampaignOperations(
  body: CreateCampaignBody,
  customer_id: string,
  opts: { logoData?: string; pmaxData?: PmaxImageData } = {},
): CreateCampaignShape {
  const demandGen = body.demand_gen_ad_group ?? null;
  if (demandGen && !opts.logoData) {
    throw new ExpectedToolError(
      "google_ads_demand_gen_logo_missing",
      "The Demand Gen ad's logo bytes were not loaded, so the request was not built.",
    );
  }
  const pmax = body.pmax_asset_group ?? null;
  if (pmax && !opts.pmaxData) {
    throw new ExpectedToolError("google_ads_ad_image_missing", "The asset group's image bytes were not loaded, so the request was not built.");
  }
  const ids = new TempIds(customer_id);
  const budget_resource = ids.take("campaignBudgets");
  const campaign_resource = ids.take("campaigns");
  const network =
    body.channel_type === "SEARCH"
      ? shapeNetworkSettings(body.network ?? networkSettingsSchema.parse({}))
      : null;
  const ops: GadsOperation[] = [
    {
      service: "campaignBudgets",
      create: {
        resourceName: budget_resource,
        name: `${body.name} budget`,
        amountMicros: usdToMicros(body.daily_budget_usd),
        deliveryMethod: "STANDARD",
        explicitlyShared: false,
      },
    },
    {
      service: "campaigns",
      create: {
        resourceName: campaign_resource,
        name: body.name,
        status: "PAUSED",
        advertisingChannelType: body.channel_type,
        campaignBudget: budget_resource,
        containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        ...(body.end_date ? { endDateTime: `${new Date(Date.parse(`${body.end_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)} 23:59:59` } : {}),
        ...shapeBidding(body.bidding),
        ...(network ? { networkSettings: network } : {}),
        ...(pmax ? { brandGuidelinesEnabled: true } : {}),
      },
    },
  ];
  if (demandGen) {
    const shaped = shapeDemandGenAdGroupOperations(
      demandGen,
      campaign_resource,
      { location_ids: body.location_ids, language_ids: body.language_ids },
      opts.logoData!,
      ids,
    );
    ops.push(...shaped.ops);
    return { ops, budget_resource, campaign_resource, ad_group_resource: shaped.ad_group_resource };
  }
  ops.push(
    ...body.location_ids.map<GadsOperation>((id) => ({
      service: "campaignCriteria",
      create: { campaign: campaign_resource, location: { geoTargetConstant: `geoTargetConstants/${id}` } },
    })),
    ...body.excluded_location_ids.map<GadsOperation>((id) => ({
      service: "campaignCriteria",
      create: { campaign: campaign_resource, negative: true, location: { geoTargetConstant: `geoTargetConstants/${id}` } },
    })),
    ...body.language_ids.map<GadsOperation>((id) => ({
      service: "campaignCriteria",
      create: { campaign: campaign_resource, language: { languageConstant: `languageConstants/${id}` } },
    })),
    ...shapeKeywordOperations(body.negative_keywords, { campaign_resource }),
  );
  if (pmax) {
    const shaped = shapePmaxAssetGroupOperations(pmax, campaign_resource, opts.pmaxData!, ids);
    ops.push(...shaped.ops);
    return { ops, budget_resource, campaign_resource, ad_group_resource: null, asset_group_resource: shaped.asset_group_resource };
  }
  let ad_group_resource: string | null = null;
  if (body.ad_group) {
    const shaped = shapeAdGroupOperations(body.ad_group, campaign_resource, ids, "ENABLED");
    ops.push(...shaped.ops);
    ad_group_resource = shaped.ad_group_resource;
  }
  return { ops, budget_resource, campaign_resource, ad_group_resource };
}

export function newTempIds(customer_id: string): TempIds {
  return new TempIds(customer_id);
}

const TARGET_CPA_FIELD: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: "maximizeConversions",
  TARGET_CPA: "targetCpa",
};

const TARGET_ROAS_FIELD: Record<string, string> = {
  MAXIMIZE_CONVERSION_VALUE: "maximizeConversionValue",
  TARGET_ROAS: "targetRoas",
};

function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function shapeUpdateCampaignOperation(
  body: UpdateCampaignBody,
  live: { campaign_resource: string; bidding_strategy_type: string },
): GadsOperation {
  const update: Record<string, unknown> = { resourceName: live.campaign_resource };
  const mask: string[] = [];
  if (body.new_name !== undefined) {
    update.name = body.new_name;
    mask.push("name");
  }
  if (body.target_cpa_usd !== undefined) {
    const field = TARGET_CPA_FIELD[live.bidding_strategy_type];
    if (!field) {
      throw new ExpectedToolError(
        "google_ads_target_cpa_not_applicable",
        `target_cpa_usd cannot be set on a campaign bidding with ${live.bidding_strategy_type || "an unknown strategy"}.`,
      );
    }
    update[field] = { targetCpaMicros: usdToMicros(body.target_cpa_usd) };
    mask.push(`${snake(field)}.target_cpa_micros`);
  }
  if (body.target_roas !== undefined) {
    const field = TARGET_ROAS_FIELD[live.bidding_strategy_type];
    if (!field) {
      throw new ExpectedToolError(
        "google_ads_target_roas_not_applicable",
        `target_roas cannot be set on a campaign bidding with ${live.bidding_strategy_type || "an unknown strategy"}.`,
      );
    }
    update[field] = { targetRoas: body.target_roas };
    mask.push(`${snake(field)}.target_roas`);
  }
  if (body.network !== undefined) {
    update.networkSettings = shapeNetworkSettings(body.network);
    mask.push(
      "network_settings.target_google_search",
      "network_settings.target_search_network",
      "network_settings.target_content_network",
      "network_settings.target_partner_search_network",
    );
  }
  return { service: "campaigns", update, updateMask: mask.join(",") };
}

export function shapeUpdateAdGroupOperation(
  body: UpdateAdGroupBody,
  ad_group_resource: string,
): GadsOperation {
  const bids = adGroupBids(body);
  const update: Record<string, unknown> = { resourceName: ad_group_resource, ...bids };
  const mask = Object.keys(bids).map(snake);
  if (body.new_name !== undefined) {
    update.name = body.new_name;
    mask.push("name");
  }
  return { service: "adGroups", update, updateMask: mask.join(",") };
}
