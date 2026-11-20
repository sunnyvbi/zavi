import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { tiktokAdsAccount } from "@/services/connectors/tiktok-ads/composio-read";
import { listTiktokAdGroups, listTiktokAds } from "@/services/connectors/tiktok-ads/objects";
import { savedAdvertiser } from "./propose_changes";
import { searchTiktokLocations, searchTiktokLocationsLocalFirst } from "@/services/connectors/tiktok-ads/locations";
import { businessCountry } from "@/services/ad-locations/country";
import { readTiktokTargetingOptions } from "@/services/connectors/tiktok-ads/targeting";

const advertiserField = z.string().regex(/^[0-9]{1,32}$/).optional().describe("TikTok ad account, from tiktok_ads_list_accounts. Left out: the account the founder chose.");
const adGroupsInput = z.object({ advertiser_id: advertiserField, campaign_id: z.string().regex(/^[0-9]{1,32}$/).describe("From tiktok_ads_list_campaigns.") });

export const tiktokAdsListAdGroupsTool: ToolSpec = {
  name: "tiktok_ads_list_ad_groups",
  effect: "read",
  description: "List one TikTok campaign's ad groups and their ads, each with its status (ACTIVE / PAUSED / DELETED) and daily budget. Read-only. Use it to find the ad group or ad to change.",
  input_schema: adGroupsInput,
  async execute(ctx, input) {
    const a = adGroupsInput.parse(input);
    const adv = await savedAdvertiser(ctx.tenant_id, a.advertiser_id);
    const account = await tiktokAdsAccount(ctx.tenant_id);
    const [groups, ads] = await Promise.all([listTiktokAdGroups(account, adv.advertiser_id, [a.campaign_id]), listTiktokAds(account, adv.advertiser_id, [a.campaign_id])]);
    return { advertiser_id: adv.advertiser_id, campaign_id: a.campaign_id, ad_groups: groups.map((g) => ({ ...g, ads: ads.filter((x) => x.ad_group_id === g.id) })) };
  },
};

const searchLocationsInput = z.object({
  advertiser_id: advertiserField,
  query: z.string().min(2).max(100).describe("A place name: a country, state, city or metro area."),
  country_code: z.string().regex(/^([A-Za-z]{2})?$/).optional().describe("Two-letter country to search in only. Left out: the company's country first, then every country this account may target."),
});

export const tiktokAdsSearchLocationsTool: ToolSpec = {
  name: "tiktok_ads_search_locations",
  effect: "read",
  description:
    "Find places a TikTok launch may show in, by name: countries, states, cities and metro areas this ad account can target, each as {location_id, name, level, country_code}. " +
    "Read-only. Pass the ids to tiktok_ads_propose_launch as location_ids. TikTok targets places include-only (no exclude list).",
  input_schema: searchLocationsInput,
  async execute(ctx, input) {
    const a = searchLocationsInput.parse(input);
    const adv = await savedAdvertiser(ctx.tenant_id, a.advertiser_id);
    const account = await tiktokAdsAccount(ctx.tenant_id);
    const locations = a.country_code
      ? await searchTiktokLocations(account, adv.advertiser_id, a.query, a.country_code)
      : await searchTiktokLocationsLocalFirst(account, adv.advertiser_id, a.query, (await businessCountry(ctx.tenant_id))?.code);
    return { advertiser_id: adv.advertiser_id, count: locations.length, locations };
  },
};

const targetingInput = z.object({ advertiser_id: advertiserField });
export const tiktokAdsTargetingOptionsTool: ToolSpec = {
  name: "tiktok_ads_targeting_options",
  effect: "read",
  description: "Read TikTok launch audience choices: adult age groups, genders and TikTok's live language codes and names. Pass selected ids as age_groups, gender and languages to tiktok_ads_propose_launch. Default: all adult ages, all genders, all languages. Narrow only when requested; ad language alone does not imply a language restriction. Read-only.",
  input_schema: targetingInput,
  async execute(ctx, input) {
    const a = targetingInput.parse(input);
    const adv = await savedAdvertiser(ctx.tenant_id, a.advertiser_id);
    return { advertiser_id: adv.advertiser_id, ...(await readTiktokTargetingOptions(await tiktokAdsAccount(ctx.tenant_id), adv.advertiser_id)) };
  },
};
