
import { gadsSearch } from "../_client";
import { checkBiddingForChannel, type BiddingSpec, type CreateCampaignBody } from "./_decision-bodies";
import { usdToMicros } from "./_helpers";
import { businessCountry, businessCountryOrThrow, googleCountryGeoId } from "@/services/ad-locations/country";
import { ExpectedToolError } from "@/services/tools/types";

const CONVERSION_BIDDING = new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]);

export async function readBusinessCountryGeoId(tenant_id: string, strict = false): Promise<number | null> {
  const c = strict ? await businessCountryOrThrow(tenant_id) : await businessCountry(tenant_id);
  if (!c) return null;
  try {
    const rows = (await gadsSearch(
      tenant_id,
      "SELECT geo_target_constant.id FROM geo_target_constant " +
        `WHERE geo_target_constant.country_code = '${c.code}' AND geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'`,
    )) as Array<{ geoTargetConstant?: { id?: string | number } }>;
    const ids = [...new Set(rows.map((r) => Number(r.geoTargetConstant?.id)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 1) return ids[0];
  } catch (e) {
    console.warn(`[google launch-defaults] country target unreadable for ${tenant_id}: ${(e as Error).message}`);
  }
  return googleCountryGeoId(c.code);
}

export async function countryIfNoLocation(tenant_id: string, location_ids: number[]): Promise<number[]> {
  if (location_ids.length > 0) return location_ids;
  let geoId: number | null;
  try {
    geoId = await readBusinessCountryGeoId(tenant_id, true);
  } catch (e) {
    throw new ExpectedToolError(
      "google_ads_location_unreadable",
      `Could not read the business's country to default this campaign's location (${(e as Error).message}). Name the locations, or try again.`,
    );
  }
  return withCountryDefault({ location_ids }, geoId).location_ids;
}

export function withCountryDefault<B extends Pick<CreateCampaignBody, "location_ids">>(body: B, countryGeoId: number | null): B {
  if (body.location_ids.length > 0 || countryGeoId === null) return body;
  return { ...body, location_ids: [countryGeoId] } as B;
}

export async function readAccountConversions30d(tenant_id: string): Promise<number | null> {
  try {
    const rows = (await gadsSearch(tenant_id, "SELECT metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS")) as Array<{
      metrics?: { conversions?: number | string };
    }>;
    let total = 0;
    for (const r of rows) total += Number(r.metrics?.conversions ?? 0) || 0;
    return total;
  } catch (e) {
    console.warn(`[google launch-defaults] conversions unreadable for ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}

export function withClickBiddingWhenBlind<B extends Pick<CreateCampaignBody, "bidding" | "channel_type" | "bidding_replaced">>(
  body: B,
  conversions30d: number | null,
): B {
  if (conversions30d === null || conversions30d > 0) return body;
  if (!CONVERSION_BIDDING.has(body.bidding.strategy)) return body;
  if (checkBiddingForChannel({ strategy: "TARGET_SPEND" }, body.channel_type) !== null) return body;
  return { ...body, bidding: { strategy: "TARGET_SPEND" }, bidding_replaced: body.bidding } as B;
}

const usdFromMicros = (m: number): string => `$${(m / 1_000_000).toFixed(2)}`;

export function cpcCeilingReadBack(bidding: BiddingSpec, live: number | null | undefined): string {
  if (bidding.strategy !== "TARGET_SPEND" || bidding.cpc_bid_ceiling_usd === undefined) return "";
  const asked = Number(usdToMicros(bidding.cpc_bid_ceiling_usd));
  if (live === undefined) return `Zavi could not read back the max cost per click (${usdFromMicros(asked)}) from Google to confirm it saved.`;
  if (live === asked) return "";
  return `The max cost per click did not save on Google (asked ${usdFromMicros(asked)}, Google shows ${live === null ? "none" : usdFromMicros(live)}).`;
}
